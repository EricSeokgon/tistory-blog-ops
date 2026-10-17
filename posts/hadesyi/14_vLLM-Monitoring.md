# vLLM 모니터링 완전정리 — Prometheus 메트릭·Grafana 대시보드·알림 기준

사용자들이 "오늘따라 답이 늦게 시작한다"고 말하는데 `nvidia-smi`를 열어 보면 GPU 메모리는 어제와 똑같이 90% 근처에 붙어 있습니다. GPU 사용률도 높고, 프로세스도 살아 있고, 로그에는 에러가 없습니다. 그런데 무엇이 느려졌는지는 아무것도 알려 주지 않습니다. vLLM은 기동 시점에 GPU 메모리를 미리 잡아 두기 때문에 `nvidia-smi`의 숫자는 부하와 거의 무관하게 움직입니다. 실제 상태는 vLLM이 직접 내보내는 Prometheus 메트릭에 있습니다. 이 글은 `/metrics` 엔드포인트에서 무엇을 봐야 하는지, Grafana 대시보드를 어떻게 붙이는지, 그리고 어떤 조건에서 알림을 울려야 하는지를 운영 순서대로 정리합니다.

## 핵심 요약

- vLLM의 OpenAI 호환 서버는 **별도 설정 없이 `/metrics`에서 Prometheus 메트릭을 노출**합니다. 모든 메트릭 이름은 `vllm:` 접두어로 시작합니다.
- 운영에서 먼저 볼 것은 세 묶음입니다. **스케줄러 상태**(`num_requests_running`·`num_requests_waiting`), **KV 캐시**(`kv_cache_usage_perc`·선점 횟수), **지연 시간**(TTFT·ITL·E2E 히스토그램)입니다.
- `vllm:kv_cache_usage_perc`는 **0에서 1 사이 값**이고 1이 100%입니다. 예전 이름 `vllm:gpu_cache_usage_perc`는 폐기됐으므로 옛 대시보드를 그대로 가져오면 빈 패널이 생깁니다.
- 지연 시간 메트릭은 히스토그램이라 **평균이 아니라 `histogram_quantile`로 p95·p99를 계산**해야 의미가 있습니다.
- 알림은 "GPU가 바쁘다"가 아니라 **"대기열이 쌓이는데 KV 캐시가 꽉 찼다"처럼 원인과 증상을 함께 묶은 조건**으로 거십시오. 단일 지표 알림은 오탐이 많습니다.

## 1. 왜 nvidia-smi로는 부족한가 — 미리 잡아 둔 메모리의 함정

vLLM은 기동할 때 `--gpu-memory-utilization` 비율만큼 GPU 메모리를 먼저 확보합니다. 기본값은 0.19 버전까지 0.9였고 0.20부터 0.92입니다. 모델 가중치를 올리고 남은 공간을 KV 캐시 블록으로 통째로 예약해 두는 방식입니다. 그래서 요청이 하나도 없을 때도, 요청이 수백 개 몰릴 때도 `nvidia-smi`의 메모리 사용량은 거의 같습니다.

GPU 사용률(utilization)도 판단 근거로 약합니다. 이 값은 "커널이 돌고 있던 시간의 비율"이라 배치가 작아도 높게 나올 수 있고, 반대로 대기열이 쌓여 사용자가 기다리는 상황과 직접 연결되지 않습니다.

운영자가 알고 싶은 것은 다른 질문입니다.

- 지금 처리 중인 요청과 기다리는 요청이 각각 몇 개인가
- KV 캐시에 여유가 남아 있는가, 이미 꽉 차서 요청을 밀어내고 있는가
- 사용자가 체감하는 첫 토큰 지연과 생성 속도가 SLO 안에 있는가

이 세 질문의 답은 vLLM 내부 스케줄러만 알고 있습니다. 그래서 vLLM 모니터링은 GPU 지표가 아니라 **엔진이 직접 내보내는 메트릭**에서 시작해야 합니다.

> GPU 지표(DCGM exporter 등)는 버리라는 뜻이 아닙니다. 온도·전력·ECC 오류처럼 하드웨어 상태를 보는 용도로는 여전히 필요합니다. 다만 "서비스가 느린 이유"를 찾는 1차 근거는 vLLM 메트릭입니다.

## 2. /metrics 엔드포인트 — 기본으로 켜져 있다

`vllm serve`로 띄운 OpenAI 호환 서버는 Prometheus 메트릭 로깅이 기본으로 켜져 있습니다. 서버 포트의 `/metrics` 경로를 호출하면 바로 확인할 수 있습니다.

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 8192

# 다른 터미널에서
curl -s http://localhost:8000/metrics | grep '^vllm:' | head -20
```

출력은 Prometheus 텍스트 형식이고, 메트릭마다 두 개의 레이블이 붙습니다.

- **`model_name`** — `--served-model-name`으로 지정한 이름(지정하지 않으면 모델 경로)
- **`engine`** — 엔진 인덱스. 데이터 병렬로 엔진을 여러 개 띄우면 0, 1, 2처럼 나뉩니다

```text
vllm:num_requests_running{engine="0",model_name="Qwen/Qwen2.5-7B-Instruct"} 4.0
vllm:num_requests_waiting{engine="0",model_name="Qwen/Qwen2.5-7B-Instruct"} 0.0
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen/Qwen2.5-7B-Instruct"} 0.37
```

카운터는 Prometheus 클라이언트 규칙에 따라 실제 이름 뒤에 `_total`이 붙습니다. 문서에는 `vllm:prompt_tokens`로 적혀 있어도 PromQL에서는 **`vllm:prompt_tokens_total`** 로 써야 합니다. 히스토그램은 `_bucket`·`_sum`·`_count` 세 시계열로 나뉩니다.

> 기동 옵션에 `--disable-log-stats`를 넣으면 엔진의 기본 통계 로거가 꺼지면서 `vllm:` 메트릭도 함께 사라집니다. 로그를 줄이려고 넣은 옵션이 모니터링까지 꺼 버리는 경우가 흔하니, 대시보드가 비어 있다면 이 옵션부터 확인하십시오.

## 3. 메트릭 지도 — 무엇부터 볼 것인가

vLLM이 내보내는 메트릭은 60개가 넘지만, 운영 초기에 대시보드에 올릴 것은 많지 않습니다. 아래 표가 출발점입니다.

| 묶음 | 메트릭 | 형식 | 답하는 질문 |
| --- | --- | --- | --- |
| 스케줄러 | `vllm:num_requests_running` | Gauge | 지금 배치에 들어가 처리 중인 요청 수 |
| 스케줄러 | `vllm:num_requests_waiting` | Gauge | 자리가 없어 대기 중인 요청 수 |
| KV 캐시 | `vllm:kv_cache_usage_perc` | Gauge | KV 캐시 블록 사용률(1 = 100%) |
| KV 캐시 | `vllm:num_preemptions` | Counter | 메모리가 모자라 실행 중 요청을 밀어낸 누적 횟수 |
| KV 캐시 | `vllm:prefix_cache_hits` / `queries` | Counter | 프리픽스 캐시 적중 토큰 / 조회 토큰 |
| 지연 | `vllm:time_to_first_token_seconds` | Histogram | 첫 토큰까지 걸린 시간(TTFT) |
| 지연 | `vllm:inter_token_latency_seconds` | Histogram | 토큰과 토큰 사이 간격(ITL) |
| 지연 | `vllm:e2e_request_latency_seconds` | Histogram | 요청 전체 소요 시간 |
| 지연 | `vllm:request_queue_time_seconds` | Histogram | 대기열(WAITING)에 머문 시간 |
| 처리량 | `vllm:prompt_tokens` / `generation_tokens` | Counter | 프리필·생성 토큰 처리량 |
| 요청 | `vllm:request_success` | Counter | 완료 요청 수(`finished_reason` 레이블로 종료 사유 구분) |

이 열한 줄이 대부분의 장애 질문에 답합니다. 나머지(멀티모달 캐시, KV 전송 커넥터, MFU 추정치 등)는 해당 기능을 켰을 때만 의미가 있으므로 필요해질 때 추가하면 됩니다.

## 4. 스케줄러 상태 — running과 waiting의 비율이 첫 신호다

vLLM 스케줄러는 매 스텝마다 "이번 배치에 어떤 요청을 넣을지"를 정합니다. 배치에 들어간 요청은 `running`, 자리가 없어 밀린 요청은 `waiting`으로 집계됩니다.

정상 상태에서 `num_requests_waiting`은 대부분의 시간 동안 0입니다. 순간적으로 몇 개가 쌓였다가 금방 0으로 돌아오는 것은 문제가 아닙니다. 위험 신호는 **`waiting`이 0으로 돌아오지 않고 계속 우상향하는 패턴**입니다. 들어오는 요청 속도가 처리 속도를 넘어섰다는 뜻이고, 이때부터 사용자 체감 TTFT는 대기 시간만큼 그대로 늘어납니다.

```promql
# 엔진별 처리 중 / 대기 중 요청 수
sum by (engine) (vllm:num_requests_running{model_name="$model"})
sum by (engine) (vllm:num_requests_waiting{model_name="$model"})

# 5분 동안 대기열이 한 번도 비지 않았는가
min_over_time(vllm:num_requests_waiting{model_name="$model"}[5m]) > 0
```

대기가 왜 생겼는지는 두 갈래로 나뉩니다. 하나는 **동시 처리 상한**(`--max-num-seqs`)에 걸린 경우이고, 다른 하나는 **KV 캐시가 모자라** 새 요청을 받을 블록이 없는 경우입니다. 최신 버전은 `vllm:num_requests_waiting_by_reason`으로 대기 사유를 나눠 보여 주지만, 버전과 관계없이 쓸 수 있는 방법은 다음 절의 KV 캐시 사용률을 함께 보는 것입니다.

## 5. KV 캐시 — 사용률, 선점, 프리픽스 적중률

### 사용률: kv_cache_usage_perc

`vllm:kv_cache_usage_perc`는 예약해 둔 KV 캐시 블록 중 실제로 쓰이고 있는 비율입니다. **0에서 1 사이 값**이므로 대시보드에서 퍼센트로 보이려면 단위를 `percentunit`으로 지정하거나 100을 곱하십시오.

이 값이 1에 가까워지면 스케줄러는 새 요청을 배치에 넣지 못하고, 더 나빠지면 이미 실행 중인 요청을 밀어냅니다(선점). 그래서 **대기열 증가와 KV 사용률 포화가 동시에 보이면 원인은 메모리**이고, KV 사용률은 여유가 있는데 대기열만 쌓이면 원인은 동시 처리 상한이나 연산 속도 쪽입니다.

> 예전 대시보드나 블로그 예제에 있는 `vllm:gpu_cache_usage_perc`는 0.9.2에서 폐기가 예고됐고 0.11부터 기본 출력에서 빠졌습니다. `--show-hidden-metrics-for-version` 옵션으로 잠시 되살릴 수는 있지만, 대시보드 쿼리를 `vllm:kv_cache_usage_perc`로 바꾸는 것이 맞습니다. 같은 시기에 `vllm:gpu_prefix_cache_hits`·`queries`도 `vllm:prefix_cache_hits`·`queries`로 이름이 바뀌었습니다.

### 선점: num_preemptions

선점은 KV 캐시가 부족할 때 스케줄러가 실행 중인 요청 일부를 내려놓고 나중에 다시 계산하는 동작입니다. 요청이 실패하지는 않지만, 이미 계산한 KV를 버리고 다시 프리필해야 하므로 해당 요청의 지연이 크게 늘어납니다.

```promql
# 5분 평균 초당 선점 횟수 — 0이 아니면 KV 메모리가 모자라다는 뜻
sum(rate(vllm:num_preemptions_total{model_name="$model"}[5m]))
```

선점이 꾸준히 발생한다면 대응 순서는 KV 캐시를 늘리는 쪽입니다. `--gpu-memory-utilization`을 올리거나, `--max-model-len`을 실제 필요한 만큼으로 줄이거나, KV 캐시를 FP8로 줄이거나, 텐서 병렬로 GPU를 늘리는 방법이 있습니다. 각 선택지의 메모리 계산은 KV 캐시 글에서 자세히 다뤘습니다.

### 프리픽스 캐시 적중률

프리픽스 캐싱을 켰다면 적중률을 봐야 효과를 판단할 수 있습니다. 두 카운터의 증가율을 나누면 됩니다.

```promql
sum(rate(vllm:prefix_cache_hits_total{model_name="$model"}[5m]))
/
sum(rate(vllm:prefix_cache_queries_total{model_name="$model"}[5m]))
```

시스템 프롬프트가 길고 고정된 서비스에서 이 값이 낮게 나온다면, 요청마다 프롬프트 앞부분에 날짜나 요청 ID 같은 가변 값이 들어가 있지 않은지 먼저 확인하십시오. 프리픽스가 한 글자만 달라도 그 뒤는 캐시를 쓰지 못합니다.

## 6. 지연 시간 — 히스토그램은 분위수로 읽는다

사용자 체감 품질은 지연 시간 메트릭으로 측정합니다. 네 가지를 구분해서 보십시오.

| 메트릭 | 의미 | 주로 늘어나는 원인 |
| --- | --- | --- |
| `time_to_first_token_seconds` (TTFT) | 요청부터 첫 토큰까지 | 대기열 적체, 긴 프롬프트의 프리필 |
| `inter_token_latency_seconds` (ITL) | 연속 토큰 사이 간격 | 배치 과밀, 디코드 단계 연산 부담 |
| `request_time_per_output_token_seconds` (TPOT) | 요청별 출력 토큰당 평균 시간 | ITL과 같은 축, 요청 단위로 집계 |
| `request_queue_time_seconds` | 대기열에 머문 시간 | 동시 처리 상한, KV 포화 |

모두 히스토그램이므로 평균만 보면 꼬리 지연이 가려집니다. SLO는 보통 p95나 p99로 정하고, `histogram_quantile`로 계산합니다.

```promql
# TTFT p95 (5분 창)
histogram_quantile(0.95,
  sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{model_name="$model"}[5m])))

# ITL p95
histogram_quantile(0.95,
  sum by (le) (rate(vllm:inter_token_latency_seconds_bucket{model_name="$model"}[5m])))

# 평균 대기 시간
sum(rate(vllm:request_queue_time_seconds_sum{model_name="$model"}[5m]))
/
sum(rate(vllm:request_queue_time_seconds_count{model_name="$model"}[5m]))
```

가장 유용한 해석 습관은 **TTFT를 대기 시간과 나란히 놓는 것**입니다. TTFT가 늘었는데 대기 시간도 같이 늘었다면 원인은 용량 부족입니다. 대기 시간은 그대로인데 TTFT만 늘었다면 프롬프트가 길어졌거나(`vllm:request_prompt_tokens` 분포 확인) 프리필이 디코드와 경쟁하고 있는 것입니다.

> 분위수는 버킷 경계 사이를 선형 보간한 추정값입니다. p99가 버킷 경계값에 딱 붙어 계단처럼 움직인다면 실제 분포가 그 버킷 안에 몰려 있다는 뜻이지, 지연이 정확히 그 값이라는 뜻은 아닙니다.

## 7. Prometheus·Grafana 붙이기 — 공식 예제 기준

vLLM 저장소의 `examples/observability/prometheus_grafana`에는 그대로 따라 할 수 있는 예제가 있습니다. Docker Compose로 Prometheus와 Grafana를 띄우고, 호스트에서 돌고 있는 vLLM을 수집합니다.

```yaml
# prometheus.yaml
global:
  scrape_interval: 5s
  evaluation_interval: 30s

scrape_configs:
  - job_name: vllm
    static_configs:
      - targets:
          - 'host.docker.internal:8000'
```

```yaml
# docker-compose.yaml
services:
  prometheus:
    image: prom/prometheus:latest
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "9090:9090"
    volumes:
      - ${PWD}/prometheus.yaml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    depends_on:
      - prometheus
    ports:
      - "3000:3000"
```

`docker compose up`으로 띄운 뒤 순서는 세 단계입니다.

1. `http://localhost:3000`에 접속해 기본 계정(`admin`/`admin`)으로 로그인합니다.
2. 데이터 소스에 Prometheus를 추가하고 URL을 **`http://prometheus:9090`** 으로 지정합니다. 두 컨테이너가 같은 Compose 네트워크에 있어 서비스 이름으로 접근됩니다.
3. 대시보드 가져오기에서 예제의 `grafana.json`을 올리고 방금 만든 데이터 소스를 선택합니다.

예제 대시보드에는 E2E 지연, 토큰 처리량, ITL, TPOT, 스케줄러 상태, TTFT, KV 캐시 사용률, 프롬프트·생성 길이 분포, 종료 사유, 대기 시간, 프리필·디코드 시간 패널이 들어 있습니다. 처음에는 이것을 그대로 쓰고, 운영하면서 선점 횟수와 프리픽스 적중률 패널을 추가하는 순서를 권합니다.

Kubernetes에 올렸다면 Prometheus Operator의 `ServiceMonitor`로 같은 일을 합니다.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm
  labels:
    release: prometheus        # Prometheus가 선택하는 레이블에 맞출 것
spec:
  selector:
    matchLabels:
      app: vllm
  endpoints:
    - port: http               # Service에 정의한 포트 이름
      path: /metrics
      interval: 15s
```

> 예제의 `scrape_interval: 5s`는 시연용입니다. 운영 환경에서는 보통 15초 정도로 두고, 짧은 스파이크까지 봐야 할 때만 줄이십시오. 수집 간격이 `rate()` 창보다 너무 길면 그래프가 비거나 들쭉날쭉해집니다.

## 8. 알림 기준 — 증상과 원인을 묶어서 건다

대시보드는 사람이 볼 때만 쓸모가 있습니다. 야간에도 문제를 알려면 알림 규칙이 필요한데, 단일 지표로 걸면 오탐이 많습니다. 예를 들어 `kv_cache_usage_perc > 0.9`만으로 알림을 걸면, 처리량이 높고 아무 문제 없는 정상 피크에서도 계속 울립니다. KV 캐시는 원래 꽉 채워 쓰라고 잡아 둔 공간이기 때문입니다.

권장하는 방식은 **사용자 영향(증상)을 주 조건으로, 원인 지표를 보조 조건으로** 묶는 것입니다.

```yaml
groups:
  - name: vllm
    rules:
      - alert: VllmQueueBuildupWithKvSaturation
        expr: |
          min_over_time(vllm:num_requests_waiting[5m]) > 0
          and on (model_name, engine)
          avg_over_time(vllm:kv_cache_usage_perc[5m]) > 0.95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "대기열이 5분 이상 비지 않고 KV 캐시가 포화 상태입니다"

      - alert: VllmPreemptionSustained
        expr: sum by (model_name) (rate(vllm:num_preemptions_total[10m])) > 0
        for: 15m
        labels:
          severity: warning

      - alert: VllmTtftSloBreach
        expr: |
          histogram_quantile(0.95,
            sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[5m]))) > 3
        for: 10m
        labels:
          severity: critical

      - alert: VllmTargetDown
        expr: up{job="vllm"} == 0
        for: 2m
        labels:
          severity: critical
```

임계값(대기 5분, KV 0.95, TTFT 3초)은 예시입니다. 실제 값은 서비스 SLO와 평소 분포를 2주 정도 관찰한 뒤 정하십시오. 특히 TTFT 임계값은 프롬프트 길이 분포에 따라 크게 달라지므로, 다른 팀의 숫자를 그대로 가져오지 마십시오.

> 가장 먼저 걸어야 할 알림은 의외로 `up == 0`입니다. vLLM 프로세스가 죽으면 모든 `vllm:` 메트릭이 사라지고, 사라진 메트릭에 걸린 조건은 참이 되지 않아 다른 알림이 전부 조용해집니다.

## 9. 진단 흐름 — "느려졌다"는 보고를 받았을 때

메트릭을 다 띄워 놓아도 어디서부터 볼지 순서가 없으면 대시보드 앞에서 시간을 씁니다. 아래 순서로 좁혀 가십시오.

```
"응답이 늦다"
  │
  ├─ up == 0 인가? ─────────────── 예 → 프로세스·Pod 상태 확인 (재시작, OOMKilled)
  │
  ├─ TTFT p95가 올랐나?
  │    ├─ 대기 시간도 올랐나? ─── 예 → num_requests_waiting 확인
  │    │      ├─ KV 사용률 ≥ 0.95, 선점 발생 → KV 메모리 부족 (max-model-len, FP8 KV, GPU 증설)
  │    │      └─ KV 여유 있음 → 동시 처리 상한(max-num-seqs) 또는 단순 트래픽 초과 → 수평 확장
  │    └─ 대기 시간은 그대로 ───── 프롬프트 길이 분포 변화 확인 → 긴 입력 유입, 프리필 경쟁
  │
  └─ TTFT는 정상, ITL·TPOT가 올랐나?
       └─ 배치 과밀 → running 수와 생성 길이 분포 확인 → max-num-seqs 조정, 스펙큘러티브 디코딩 검토
```

이 흐름의 핵심은 **TTFT와 ITL을 분리해서 보는 것**입니다. 둘 다 "느리다"로 보고되지만 원인과 처방이 완전히 다릅니다. TTFT는 들어가기 전의 문제(대기, 프리필)이고, ITL은 들어간 뒤의 문제(디코드 배치)입니다.

## 10. 흔한 실수

- **`nvidia-smi` 메모리 사용률로 부하를 판단한다** — vLLM은 기동 시 메모리를 미리 예약하므로 이 값은 부하와 거의 무관합니다. KV 사용률을 보십시오.
- **옛 메트릭 이름이 들어간 대시보드를 그대로 가져온다** — `gpu_cache_usage_perc`, `gpu_prefix_cache_hits`처럼 폐기된 이름은 최신 버전에서 출력되지 않아 패널이 조용히 빈 채로 남습니다.
- **카운터에 `_total`을 빼고 쿼리한다** — `rate(vllm:prompt_tokens[5m])`는 아무것도 반환하지 않습니다. `vllm:prompt_tokens_total`이 실제 이름입니다.
- **히스토그램의 평균만 본다** — 평균 TTFT가 괜찮아 보여도 p99 사용자는 몇 배를 기다리고 있을 수 있습니다.
- **`--disable-log-stats`를 넣은 채 모니터링을 붙인다** — 로그를 줄이려던 옵션이 `vllm:` 메트릭까지 꺼 버립니다.
- **KV 사용률 단독으로 알림을 건다** — KV 캐시는 꽉 채워 쓰도록 설계된 공간이라 정상 피크에서도 계속 울립니다. 대기열·선점과 묶으십시오.
- **엔진이 여러 개인데 레이블을 합치지 않는다** — 데이터 병렬 구성에서 `engine` 레이블을 무시하고 한 엔진만 보면, 나머지 엔진의 적체를 놓칩니다. `sum by (model_name)`과 `by (engine)` 두 관점을 모두 두십시오.
- **`up == 0` 알림을 빠뜨린다** — 프로세스가 죽으면 다른 알림 조건이 전부 평가 불가 상태가 되어 아무 경보도 울리지 않습니다.

## 실전 체크리스트

- `curl http://<host>:<port>/metrics`로 `vllm:` 메트릭이 실제로 나오는지 확인했다.
- 기동 옵션에 `--disable-log-stats`가 없는지 확인했다.
- 대시보드 쿼리에서 `gpu_cache_usage_perc`를 `kv_cache_usage_perc`로 바꿨다.
- 카운터 쿼리에 `_total` 접미어를 붙였다.
- `num_requests_running`과 `num_requests_waiting`을 한 패널에 나란히 배치했다.
- KV 사용률 패널의 단위를 `percentunit`으로 지정했다.
- 선점 횟수(`num_preemptions_total`)의 증가율 패널을 추가했다.
- 프리픽스 캐싱을 켠 경우 적중률 패널을 추가했다.
- TTFT·ITL을 p50·p95·p99 분위수로 그렸다.
- TTFT와 대기 시간을 같은 화면에서 비교할 수 있게 배치했다.
- `up == 0` 알림을 가장 먼저 등록했다.
- 대기열 적체 알림을 KV 포화 조건과 묶어서 걸었다.
- 알림 임계값을 2주 이상의 평소 분포를 보고 정했다.

## 마치며

vLLM 모니터링의 핵심은 GPU를 보는 것이 아니라 **스케줄러의 눈으로 보는 것**입니다. GPU는 미리 잡아 둔 메모리 때문에 늘 바빠 보이지만, 스케줄러는 지금 몇 개를 처리하고 몇 개를 기다리게 하는지, 메모리가 모자라 누구를 밀어냈는지 정확히 알고 있습니다. 대시보드를 처음 만든다면 공식 예제를 그대로 올리고, 장애를 한 번 겪을 때마다 그때 필요했던 패널과 알림을 하나씩 더하는 방식이 가장 오래 살아남는 대시보드를 만듭니다.

## FAQ

**Q1. `/metrics`를 호출했는데 `vllm:`으로 시작하는 줄이 하나도 없습니다.**
기동 옵션에 `--disable-log-stats`가 들어가 있지 않은지 먼저 확인하십시오. 이 옵션은 엔진의 기본 통계 로거를 끄면서 Prometheus 메트릭도 함께 끕니다. 옵션이 없는데도 비어 있다면 호출한 포트가 vLLM API 서버 포트가 맞는지, 앞단 프록시가 `/metrics` 경로를 막고 있지 않은지 확인하십시오. 메트릭 줄은 기동 직후부터 나오지만 카운터와 히스토그램은 요청이 처리되기 전까지 0으로 남아 있습니다.

**Q2. `kv_cache_usage_perc`가 항상 0.9 이상인데 문제입니까?**
그 자체로는 문제가 아닙니다. KV 캐시는 요청을 최대한 많이 담으려고 예약한 공간이라, 트래픽이 많으면 높게 유지되는 것이 정상입니다. 문제는 이 값이 1에 붙은 상태에서 `num_requests_waiting`이 쌓이거나 `vllm:num_preemptions_total`이 증가할 때입니다. 그때 KV 메모리를 늘리는 조치를 검토하십시오.

**Q3. 여러 vLLM 인스턴스를 한 대시보드에서 보려면 어떻게 합니까?**
각 인스턴스를 Prometheus 수집 대상에 모두 등록하고, 인스턴스마다 `--served-model-name`을 일관되게 지정하십시오. 그러면 `model_name` 레이블로 모델별 합계를, Prometheus가 붙이는 `instance` 레이블로 인스턴스별 상태를 나눠 볼 수 있습니다. Grafana 변수(`$model`)를 `label_values(vllm:num_requests_running, model_name)`로 만들면 드롭다운으로 전환할 수 있습니다.

**Q4. 옛 대시보드가 `gpu_cache_usage_perc`를 쓰는데 당장 고치기 어렵습니다.**
`--show-hidden-metrics-for-version` 옵션으로 직전 버전에서 숨겨진 메트릭을 일시적으로 다시 노출할 수 있습니다. 다만 폐기된 메트릭은 이후 버전에서 완전히 제거되므로 임시방편일 뿐입니다. 대시보드 JSON에서 이름을 일괄 치환하는 편이 결국 빠릅니다.

## 참고 공식 문서

- vLLM 공식 문서 — Production Metrics (`docs.vllm.ai`의 usage/metrics)
- vLLM 저장소 — `examples/observability/prometheus_grafana` (`prometheus.yaml`·`docker-compose.yaml`·`grafana.json`)
- Prometheus 공식 문서 — Histograms and summaries (`histogram_quantile` 해석)
- Prometheus Operator 문서 — ServiceMonitor

## 함께 읽으면 좋은 글

- [vLLM KV Cache 완전정리 — 메모리 계산·Prefix Caching·FP8 튜닝법](https://hadesyi.tistory.com/384)
- [vLLM 속도 튜닝 가이드 (2026) — TTFT·ITL·처리량을 개선하는 실전 순서](https://hadesyi.tistory.com/382)
- [vLLM CUDA OOM 해결 가이드 (2026): GPU 메모리 부족 원인별 튜닝 순서](https://hadesyi.tistory.com/373)
- [vLLM 멀티 GPU 서빙 완전정리 — Tensor·Pipeline·Data Parallel 선택 기준](https://hadesyi.tistory.com/398)

태그(9개): vLLM, Prometheus, Grafana, LLM엔지니어링, 모니터링, KV캐시, TTFT, 알림설정, 관측성
