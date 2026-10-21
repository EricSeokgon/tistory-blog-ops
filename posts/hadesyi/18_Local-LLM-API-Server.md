# 로컬 LLM 서버 구축 가이드: vLLM, GGUF, FastAPI로 사내 AI API 만들기

GPU 서버에 모델을 올리고 `curl`로 답변이 돌아오는 것을 확인한 다음 날, 사내 서비스 세 곳이 동시에 붙자 응답이 30초씩 밀리고 게이트웨이는 타임아웃을 쏟아내는 상황. 모델이 "돌아가는 것"과 사내 서비스가 "믿고 호출할 수 있는 것" 사이에는 거리가 꽤 있습니다. 이 글은 로컬 LLM 구축 시리즈의 4편으로, 1편의 RAG 구조와 2편의 GPU 사양을 전제로 **vLLM 추론 서버를 사내 표준 API로 만드는 절차**를 정리합니다. 모델 선택·포맷, 서버 옵션, FastAPI 게이트웨이, 스트리밍, 인증, 배포, 모니터링까지 운영 관점에서 다룹니다.

## 핵심 요약

- 구조는 **vLLM(추론) ↔ FastAPI 게이트웨이(인증·로깅·정책) ↔ 사내 서비스**의 3층으로 나누고, 추론 서버는 사내망 내부에만 노출합니다.
- vLLM은 **OpenAI 호환 API**를 기본 제공하므로, 게이트웨이는 그 위에 사내 규칙만 얹으면 됩니다. 클라이언트는 OpenAI SDK를 그대로 씁니다.
- vLLM에서 **GGUF는 실험적 지원**입니다. 운영 서빙은 AWQ·GPTQ·FP8 같은 vLLM 최적화 포맷을 우선하고, GGUF는 llama.cpp 계열 자산을 그대로 써야 할 때만 선택하십시오.
- 체감 속도는 **스트리밍**이 좌우합니다. 게이트웨이를 동기 `requests`로 만들면 동시 요청에서 병목이 생기므로 `httpx.AsyncClient` 기반 비동기 프록시로 구성하십시오.
- 운영 지표는 **TTFT·대기 요청 수·KV 캐시 사용률** 세 가지부터 봅니다. vLLM의 `/metrics`가 이 값을 Prometheus 형식으로 제공합니다.

## 1. 전체 구조 — 왜 3층으로 나누는가

```text
[사내 웹서비스 / 챗봇 / 배치]
          │  HTTPS, 사내 인증 토큰
          ▼
[FastAPI 게이트웨이]  ── 인증·권한, 요청 검증, 로깅, 속도 제한, 모델 라우팅
          │  사내망 HTTP, 내부 API 키
          ▼
[vLLM OpenAI 호환 서버]  ── 배치 스케줄링, KV 캐시, 토큰 생성
          │
          ▼
[GPU 서버 + 모델 파일]
```

게이트웨이를 따로 두는 이유는 세 가지입니다.

- **추론 서버를 단순하게 유지** — vLLM은 토큰을 빨리 만드는 데 집중하고, 사내 정책(누가 어떤 모델을 얼마나 쓰는지)은 게이트웨이가 맡습니다.
- **모델 교체가 서비스에 영향 없게** — 클라이언트는 게이트웨이의 모델 별칭만 알고, 실제 모델 경로·버전은 게이트웨이 설정에서 바꿉니다.
- **장애 격리** — 추론 서버가 재시작되는 동안 게이트웨이가 명확한 오류 응답(503)과 재시도 정책을 제공합니다.

## 2. 모델과 포맷 선택 — GGUF를 써도 되는가

시리즈 1편에서 GGUF를 예시로 썼지만, vLLM 공식 문서는 GGUF 지원을 **"highly experimental and under-optimized"** 로 명시합니다. 포맷별 판단 기준은 다음과 같습니다.

| 포맷 | vLLM 지원 | 운영 서빙 권장도 | 쓰는 경우 |
| --- | --- | --- | --- |
| FP16 / BF16 원본 | 정식 | 높음 | GPU 메모리가 충분할 때. 품질 기준선 |
| AWQ · GPTQ (4bit) | 정식 | 높음 | 메모리를 줄이면서 처리량 유지 |
| FP8 | 정식(지원 GPU 한정) | 높음 | Ada·Hopper 이상 GPU에서 품질 손실 최소화 |
| GGUF | 실험적 | 낮음 | llama.cpp·Ollama용으로 준비된 모델을 그대로 써야 할 때 |

GGUF를 vLLM에 올릴 때는 **토크나이저를 원본 모델에서 지정**하는 것이 공식 권장입니다.

```bash
vllm serve ./models/Qwen3-8B-Q4_K_M.gguf \
  --tokenizer Qwen/Qwen3-8B \
  --served-model-name qwen3-8b
```

> 4bit 양자화 모델끼리라도 포맷에 따라 vLLM 내부 커널이 다릅니다. 같은 GPU에서 AWQ 모델이 GGUF보다 처리량이 높게 나오는 경우가 많으니, 운영 전에 **같은 프롬프트 세트로 처리량과 품질을 직접 비교**하십시오. 포맷별 차이는 양자화 완전정리 글에서 자세히 다뤘습니다.

모델 파일은 **버전이 드러나는 경로**로 관리합니다. `/opt/models/qwen3-8b-awq/2026-10-01/`처럼 날짜나 리비전을 넣고, 사내망이라면 내부 NAS나 오브젝트 스토리지에 원본을 캐싱해 GPU 서버 재구축 때 외부 다운로드에 의존하지 않게 합니다.

## 3. vLLM 서버 실행 — 운영에 필요한 옵션

최신 vLLM은 `vllm serve` 명령으로 OpenAI 호환 서버를 띄웁니다.

```bash
vllm serve /opt/models/qwen3-8b-awq/2026-10-01 \
  --served-model-name qwen3-8b \
  --host 0.0.0.0 --port 8001 \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 64 \
  --api-key "${VLLM_API_KEY}"
```

| 옵션 | 의미 | 운영 기준 |
| --- | --- | --- |
| `--served-model-name` | API에서 쓰는 모델 이름 | 파일 경로 대신 고정 별칭을 노출 |
| `--max-model-len` | 요청 하나의 최대 컨텍스트 | RAG 프롬프트 길이 + 답변 길이로 산정. 크게 잡을수록 KV 캐시 여유가 줄어듦 |
| `--gpu-memory-utilization` | vLLM이 쓸 GPU 메모리 비율 | 0.85\~0.92. 같은 GPU에 다른 프로세스가 있으면 낮춤 |
| `--max-num-seqs` | 동시에 처리할 최대 시퀀스 수 | 처리량과 개별 지연의 균형점. 부하 테스트로 결정 |
| `--api-key` | 요청 헤더의 Bearer 키 검증 | 게이트웨이만 키를 갖고, 서비스는 직접 호출하지 못하게 |

`--gpu-memory-utilization`을 높이면 KV 캐시 공간이 늘어 동시 처리량이 올라가지만, 너무 높으면 기동 단계나 다른 프로세스와 충돌해 OOM이 납니다. 이 옵션과 OOM의 관계는 CUDA OOM 해결 가이드에서 원인별로 정리했습니다.

기동 후 확인할 엔드포인트입니다.

```bash
curl -s http://localhost:8001/health                     # 200이면 준비 완료
curl -s http://localhost:8001/v1/models \
  -H "Authorization: Bearer ${VLLM_API_KEY}"              # 모델 별칭 확인
curl -s http://localhost:8001/metrics | head -20          # Prometheus 지표
```

## 4. FastAPI 게이트웨이 — 비동기 프록시로 만든다

기존 글의 예시처럼 동기 `requests.post()`로 vLLM을 호출하면, 요청 하나가 수십 초 생성되는 동안 워커가 묶여 동시 처리량이 워커 수로 제한됩니다. 게이트웨이는 **비동기 HTTP 클라이언트를 재사용**하는 프록시로 만듭니다.

```python
# gateway/main.py
import os
import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse

VLLM_URL = os.environ["VLLM_URL"]            # http://gpu-01:8001
VLLM_KEY = os.environ["VLLM_API_KEY"]
MODEL_ALIAS = {"chat-default": "qwen3-8b"}   # 서비스가 쓰는 이름 → 실제 모델

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(
        base_url=VLLM_URL,
        headers={"Authorization": f"Bearer {VLLM_KEY}"},
        timeout=httpx.Timeout(connect=5.0, read=120.0, write=10.0, pool=5.0),
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
    )
    yield
    await app.state.client.aclose()

app = FastAPI(lifespan=lifespan)
```

`httpx.AsyncClient`를 요청마다 만들지 않고 **앱 생명주기 동안 하나를 공유**하는 것이 핵심입니다. 연결을 재사용해야 지연과 소켓 고갈을 막을 수 있습니다. 타임아웃은 연결(`connect`)은 짧게, 읽기(`read`)는 최대 생성 시간에 맞춰 길게 잡습니다.

## 5. 스트리밍 응답 — 체감 속도를 바꾸는 한 줄

LLM 응답은 전체가 끝날 때까지 기다리면 수 초에서 수십 초가 걸리지만, 첫 토큰은 보통 1초 안에 나옵니다. **스트리밍을 켜면 사용자는 첫 토큰부터 읽기 시작**합니다. vLLM은 `"stream": true` 요청에 Server-Sent Events(SSE)로 응답하므로, 게이트웨이는 이를 그대로 흘려보내면 됩니다.

```python
@app.post("/v1/chat/completions")
async def chat(request: Request, user=Depends(verify_user)):
    body = await request.json()
    body["model"] = MODEL_ALIAS.get(body.get("model", "chat-default"))
    if body["model"] is None:
        raise HTTPException(400, "unknown model alias")
    body.setdefault("max_tokens", 1024)          # 상한 없는 생성 방지

    client: httpx.AsyncClient = request.app.state.client

    if body.get("stream"):
        async def relay():
            async with client.stream("POST", "/v1/chat/completions", json=body) as r:
                async for chunk in r.aiter_raw():
                    yield chunk
        return StreamingResponse(relay(), media_type="text/event-stream")

    r = await client.post("/v1/chat/completions", json=body)
    return JSONResponse(r.json(), status_code=r.status_code)
```

리버스 프록시(Nginx 등)를 앞에 두는 경우 **버퍼링을 꺼야** 스트리밍이 끊기지 않고 전달됩니다.

```nginx
location /v1/ {
    proxy_pass http://gateway:8080;
    proxy_http_version 1.1;
    proxy_buffering off;          # SSE를 모아서 보내지 않도록
    proxy_read_timeout 300s;
}
```

## 6. 인증·권한·속도 제한 — 게이트웨이가 맡을 정책

사내 API라도 인증 없이 열어 두면 한 서비스의 배치 작업이 GPU를 독점합니다. 게이트웨이에 최소한 아래 세 가지를 둡니다.

- **인증** — 사내 SSO의 JWT를 검증하거나, 서비스별 API 키를 발급합니다. vLLM의 `--api-key`는 게이트웨이 전용으로 두고 서비스에는 노출하지 않습니다.
- **권한** — 서비스별로 쓸 수 있는 모델 별칭과 최대 `max_tokens`를 제한합니다.
- **속도 제한** — 서비스별 분당 요청 수와 동시 요청 수를 제한합니다. 다중 인스턴스라면 Redis 같은 공유 저장소로 카운터를 관리합니다.

```python
from fastapi import Header

SERVICE_KEYS = {"svc-helpdesk": "chat-default", "svc-batch": "chat-default"}

async def verify_user(x_api_key: str = Header(...)):
    service = lookup_service_by_key(x_api_key)      # 사내 키 저장소 조회
    if service is None:
        raise HTTPException(401, "invalid api key")
    if not await rate_limiter.allow(service):
        raise HTTPException(429, "rate limit exceeded")
    return service
```

> 프롬프트와 응답을 그대로 로그에 남기면 개인정보·영업비밀이 로그 시스템으로 흘러갑니다. 기본은 **메타데이터(서비스, 모델, 토큰 수, 지연)만 기록**하고, 본문 로깅은 감사 목적에 한해 마스킹 후 별도 보관하십시오.

## 7. 사내 서비스 연동 — OpenAI SDK를 그대로 쓴다

게이트웨이가 OpenAI 호환 경로를 유지하면, 사내 서비스는 공식 OpenAI SDK의 `base_url`만 바꿔 연동할 수 있습니다. 나중에 외부 API와 로컬 모델을 섞어 쓸 때도 코드 변경이 최소화됩니다.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm-gateway.internal.example.com/v1",
    api_key="svc-helpdesk-key",
    default_headers={"X-API-Key": "svc-helpdesk-key"},
)

stream = client.chat.completions.create(
    model="chat-default",
    messages=[{"role": "user", "content": "휴가 신청 절차를 요약해 줘"}],
    stream=True,
    max_tokens=512,
)
for event in stream:
    print(event.choices[0].delta.content or "", end="")
```

LangChain 같은 프레임워크도 OpenAI 호환 엔드포인트를 지원하므로, 시리즈 1편의 RAG 파이프라인을 이 게이트웨이로 연결하면 문서 검색과 생성이 같은 정책 아래 묶입니다.

## 8. 배포 — 컨테이너와 재시작 정책

vLLM은 공식 컨테이너 이미지(`vllm/vllm-openai`)를 제공합니다. GPU 드라이버와 NVIDIA Container Toolkit이 준비된 서버라면 Compose로 추론 서버와 게이트웨이를 함께 관리할 수 있습니다.

```yaml
# docker-compose.yml
services:
  vllm:
    image: vllm/vllm-openai:latest      # 운영에서는 검증한 버전 태그로 고정
    command: >
      --model /models/qwen3-8b-awq/2026-10-01
      --served-model-name qwen3-8b
      --max-model-len 16384
      --gpu-memory-utilization 0.90
    environment:
      - VLLM_API_KEY=${VLLM_API_KEY}
    volumes:
      - /opt/models:/models:ro
    ipc: host                          # 텐서 병렬 시 공유 메모리 필요
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      start_period: 300s               # 모델 로딩 시간 확보
    restart: unless-stopped

  gateway:
    build: ./gateway
    environment:
      - VLLM_URL=http://vllm:8000
      - VLLM_API_KEY=${VLLM_API_KEY}
    ports: ["8080:8080"]
    depends_on:
      vllm: { condition: service_healthy }
    restart: unless-stopped
```

`start_period`를 충분히 주지 않으면 **모델을 로딩하는 동안 헬스체크가 실패해 컨테이너가 재시작을 반복**합니다. 대형 모델은 로딩에 수 분이 걸리니 실제 기동 시간을 재서 설정하십시오. 컨테이너 이미지는 `latest` 대신 검증한 버전 태그로 고정합니다. vLLM은 릴리스마다 옵션 기본값이 바뀌는 경우가 있습니다.

## 9. 모니터링 — 무엇을 보고 언제 증설하나

vLLM의 `/metrics`를 Prometheus로 수집하고 아래 지표부터 대시보드에 올립니다.

| 지표 | 의미 | 경고 신호 |
| --- | --- | --- |
| TTFT (첫 토큰 시간) | 요청부터 첫 토큰까지 | 평소 대비 급증하면 대기열 적체 |
| 대기 요청 수 (waiting) | 스케줄을 기다리는 요청 | 지속적으로 0보다 크면 용량 부족 |
| KV 캐시 사용률 | 동시 컨텍스트를 담는 메모리 | 상시 90% 이상이면 선점(preemption) 발생 |
| 초당 생성 토큰 | 실제 처리량 | 요청 증가에도 평평하면 GPU 한계 |
| 게이트웨이 4xx/5xx | 인증 실패·타임아웃·다운 | 5xx 증가는 추론 서버 장애 의심 |

게이트웨이 쪽에서는 **서비스별 토큰 사용량**을 함께 기록해 두면, 어느 서비스가 용량을 쓰는지 근거를 가지고 증설·배분을 결정할 수 있습니다. 지표별 알림 기준과 Grafana 패널 구성은 vLLM 모니터링 완전정리 글에 정리했습니다.

## 10. 흔한 실수

- **추론 서버를 서비스에 직접 노출** — 인증·속도 제한 없이 열리면 한 서비스가 GPU를 독점하고, 모델 교체 때 모든 클라이언트를 고쳐야 합니다.
- **동기 `requests`로 게이트웨이 구현** — 생성 시간 동안 워커가 묶여 동시 요청이 쌓입니다. 비동기 클라이언트를 공유하십시오.
- **`max_tokens` 상한 없음** — 반복 생성에 빠진 요청 하나가 수천 토큰을 만들며 다른 요청의 대기를 늘립니다.
- **GGUF를 기본 운영 포맷으로 선택** — vLLM에서는 실험적 지원입니다. 처리량 비교 없이 결정하지 마십시오.
- **스트리밍 경로의 프록시 버퍼링** — Nginx 기본 설정은 SSE를 모아서 보내 "스트리밍이 안 된다"는 착각을 만듭니다.
- **`--max-model-len`을 모델 최대치로 설정** — 실제로 쓰지 않는 긴 컨텍스트 때문에 KV 캐시 여유가 줄어 동시 처리량이 떨어집니다.
- **헬스체크 유예 시간 부족** — 모델 로딩 중 재시작 루프가 발생합니다.
- **프롬프트 원문 로깅** — 사내 기밀이 로그 시스템에 그대로 남습니다.

## 실전 체크리스트

- 추론 서버·게이트웨이·서비스의 3층 구조로 역할을 나눴다.
- 운영 모델 포맷을 처리량·품질 비교로 결정했다.
- GGUF를 쓰는 경우 원본 모델의 토크나이저를 지정했다.
- 모델 파일을 버전이 드러나는 경로에 두고 사내 저장소에 캐싱했다.
- `--served-model-name`으로 고정 별칭을 노출했다.
- `--max-model-len`과 `--max-num-seqs`를 부하 테스트로 정했다.
- vLLM `--api-key`를 게이트웨이 전용으로 설정했다.
- 게이트웨이를 공유 `httpx.AsyncClient` 기반 비동기 프록시로 구현했다.
- 스트리밍 경로에서 프록시 버퍼링을 껐다.
- 서비스별 인증·권한·속도 제한을 적용했다.
- 기본 `max_tokens` 상한을 설정했다.
- 로그에 본문 대신 메타데이터만 남기도록 했다.
- 컨테이너 이미지 버전을 고정하고 헬스체크 유예 시간을 실제 로딩 시간에 맞췄다.
- TTFT·대기 요청 수·KV 캐시 사용률 대시보드와 알림을 구성했다.

## 마치며

로컬 LLM 서버 구축의 끝은 모델이 답을 내는 순간이 아니라, **여러 서비스가 동시에 붙어도 예측 가능하게 응답하는 순간**입니다. 그 차이를 만드는 것은 모델 성능보다 게이트웨이의 정책과 관측 가능성입니다. 추론은 vLLM에 맡기고, 사내 규칙은 게이트웨이에 모으고, 숫자는 대시보드로 보십시오.

## FAQ

**Q1. FastAPI 게이트웨이 없이 vLLM만으로 운영해도 되나요?**
사용자가 한 팀이고 PoC 단계라면 vLLM의 `--api-key`만으로도 시작할 수 있습니다. 다만 서비스가 둘 이상으로 늘면 서비스별 권한·속도 제한·사용량 집계가 필요해지고, 이 기능은 vLLM이 제공하지 않습니다. 그 시점에 게이트웨이를 두는 것이 일반적입니다.

**Q2. 사내 API에서 가장 먼저 봐야 할 지표는 무엇인가요?**
대기 요청 수와 TTFT입니다. 대기 요청이 지속적으로 0보다 크고 TTFT가 늘어나면, 사용자가 체감하기 전에 용량이 부족해지고 있다는 신호입니다. 처리량(초당 토큰)은 그다음에 봅니다.

**Q3. GPU 한 장으로 여러 모델을 서빙할 수 있나요?**
vLLM 프로세스 하나는 기본적으로 모델 하나를 서빙합니다. 여러 모델이 필요하면 `--gpu-memory-utilization`을 나눠 프로세스를 여러 개 띄우거나, 같은 베이스 모델에 LoRA 어댑터를 얹는 방식을 검토하십시오. 업무별 미세조정 모델이 여러 개라면 LoRA 멀티 어댑터 서빙이 메모리 효율이 좋습니다.

**Q4. 응답이 중간에 끊깁니다.**
세 군데를 확인하십시오. 게이트웨이의 `read` 타임아웃이 최대 생성 시간보다 짧은지, 앞단 프록시의 `proxy_read_timeout`이 짧은지, 그리고 응답의 `finish_reason`이 `length`인지입니다. 마지막 경우는 `max_tokens`나 `--max-model-len`에 걸려 생성이 정상 종료된 것입니다.

## 참고 공식 문서

- vLLM — OpenAI-Compatible Server
- vLLM — GGUF Quantization
- FastAPI — Custom Response: StreamingResponse
- HTTPX — Async Support

## 함께 읽으면 좋은 글

- [로컬 LLM 구축 1편: vLLM·GGUF·FastAPI로 사내 AI 서버 만들기](https://hadesyi.tistory.com/315)
- [로컬 LLM 구축 2편: GPU 서버 사양·인프라 구성 실전 가이드](https://hadesyi.tistory.com/316)
- [vLLM CUDA OOM 해결 가이드 (2026): GPU 메모리 부족 원인별 튜닝 순서](https://hadesyi.tistory.com/373)
- [vLLM 모니터링 완전정리 — Prometheus 메트릭·Grafana 대시보드·알림 기준](https://hadesyi.tistory.com/422)

---

**태그(9개):** AI서버구축, fastapi, gguf, vLLM, 로컬llm, 모델서빙, 사내AI, 스트리밍, 온프레미스AI
