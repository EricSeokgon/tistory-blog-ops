# Kubernetes Probe 완전정리 — Liveness·Readiness·Startup 설계와 흔한 오설정

`CrashLoopBackOff`를 파고들다 보면 결국 probe에 도착합니다. 앱은 멀쩡한데 kubelet이 계속 죽이고 있거나, 반대로 죽은 앱에 트래픽이 계속 꽂히고 있거나. 앞선 글에서 재시작 루프와 OOM을 다뤘지만, **재시작을 유발하는 쪽**은 정작 정리하지 않았습니다. 이 글이 그 자리를 채웁니다. 세 probe의 역할 차이부터 필드 기본값, 실무에서 반복되는 오설정, 종료 흐름과의 상호작용까지 한 번에 정리합니다.

## 핵심 요약

- 세 probe는 **각각 다른 질문**에 답합니다. Liveness는 "죽었나", Readiness는 "지금 받아도 되나", Startup은 "아직 뜨는 중인가"입니다. 하나로 뭉치면 반드시 사고가 납니다.
- **Liveness probe에 의존성 확인을 넣지 마십시오.** DB가 흔들리면 전체 파드가 동시에 재시작하는 장애 증폭 장치가 됩니다.
- **Readiness에는 의존성을 넣어도 되지만** 그것도 전체가 동시에 빠질 수 있습니다. 트래픽을 끊는 게 정말 나은지 따져보십시오.
- `timeoutSeconds` 기본값은 **1초**입니다. 이게 원인인 오탐이 대단히 흔합니다.
- 감지까지 걸리는 시간은 `periodSeconds × failureThreshold`입니다. 기본값이면 **30초**입니다.
- 느린 시작은 `initialDelaySeconds`를 늘리지 말고 **Startup probe**로 처리하십시오.
- gRPC probe는 **1.27 GA**, probe-level `terminationGracePeriodSeconds`는 **1.28 stable**, 네이티브 사이드카는 **1.33 GA**입니다.

## 1. 세 probe는 각각 다른 질문에 답한다

| Probe | 답하는 질문 | 실패하면 | 언제 도는가 |
| --- | --- | --- | --- |
| **Liveness** | 이 컨테이너 죽었나? | 컨테이너를 **재시작** | Startup 성공 후 계속 |
| **Readiness** | 지금 트래픽 받아도 되나? | Service **엔드포인트에서 제외** | Startup 성공 후 계속 |
| **Startup** | 아직 뜨는 중인가? | 컨테이너를 **재시작** | 성공할 때까지만 |

핵심은 **실패의 결과가 다르다**는 것입니다. Liveness 실패는 프로세스를 죽이고, Readiness 실패는 트래픽만 끊습니다. 이 차이를 무시하고 같은 엔드포인트를 세 곳에 그대로 붙이는 것이 사고의 출발점입니다.

```yaml
# 흔히 보는 나쁜 예 — 세 probe가 같은 곳을 본다
livenessProbe:  { httpGet: { path: /health, port: 8080 } }
readinessProbe: { httpGet: { path: /health, port: 8080 } }
```

`/health`가 DB 연결까지 확인한다면, DB가 3초만 흔들려도 **모든 파드가 동시에 재시작**합니다. 트래픽을 받을 파드가 사라진 상태에서 앱이 새로 뜨느라 DB에 커넥션을 다시 몰아치고, 그게 다시 DB를 흔듭니다. 장애가 스스로를 키웁니다.

> ⚠️ **Liveness의 판단 기준은 "재시작하면 나아지는가" 하나뿐입니다.** DB가 죽어서 앱이 응답을 못 한다면 재시작해도 나아지지 않습니다. 그러니 Liveness에 들어가면 안 됩니다. 데드락, 무한루프, 힙 고갈처럼 **프로세스를 새로 띄워야 풀리는 상태**만 Liveness의 대상입니다.

## 2. probe 메커니즘 네 가지

| 방식 | 성공 조건 | 비고 |
| --- | --- | --- |
| `exec` | 명령 종료 코드 **0** | 컨테이너 안에서 프로세스를 새로 띄움 — 가장 비쌈 |
| `httpGet` | 상태 코드 **200~399** | 가장 흔하고 가벼움 |
| `tcpSocket` | TCP 연결 성립 | 포트만 열려 있으면 성공 — 판정이 가장 느슨함 |
| `grpc` | 헬스 체크 응답이 **SERVING** | **1.27 GA**. gRPC 서버에 헬스 체크 서비스 구현 필요 |

`httpGet`에서 자주 걸리는 함정이 **인증**입니다. 성공 범위가 200~399이므로 **401·403은 실패**입니다. 인증 미들웨어가 헬스 엔드포인트까지 감싸고 있으면 앱은 멀쩡한데 probe만 계속 죽습니다. 헬스 경로를 인증에서 빼거나, 헤더를 넣으십시오.

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: http          # 컨테이너 포트 이름 사용 가능
    scheme: HTTPS
    httpHeaders:
      - name: X-Probe
        value: kubelet
```

포트는 숫자 대신 **이름**을 쓸 수 있습니다(`http`, `tcp`, `grpc` 모두 가능). 포트 번호를 바꿀 때 probe 수정을 빠뜨리는 사고를 막아줍니다.

`exec`는 편해 보이지만 **매 주기마다 컨테이너 안에서 프로세스를 새로 포크합니다.** `periodSeconds: 5`면 파드당 1분에 12번입니다. 파드가 수백 개면 노드 부하로 잡힙니다. 가능하면 `httpGet`을 쓰십시오.

> 💡 **kubelet은 노드에서 파드 IP로 직접 요청합니다.** Service를 거치지 않습니다. 그래서 Service나 Ingress가 망가져도 probe는 통과하고, 반대로 NetworkPolicy가 kubelet 트래픽을 막으면 앱이 멀쩡해도 probe가 전부 실패합니다.

## 3. 설정 필드와 기본값

| 필드 | 기본값 | 최솟값 | 의미 |
| --- | --- | --- | --- |
| `initialDelaySeconds` | 0 | 0 | 첫 검사까지 대기 |
| `periodSeconds` | 10 | 1 | 검사 주기 |
| `timeoutSeconds` | **1** | 1 | 응답 대기 한도 |
| `successThreshold` | 1 | 1 | 성공 판정에 필요한 연속 성공 횟수 |
| `failureThreshold` | 3 | 1 | 실패 판정에 필요한 연속 실패 횟수 |

세 가지를 기억하십시오.

**① `timeoutSeconds` 기본값이 1초입니다.** 대부분의 오탐이 여기서 나옵니다. GC가 한 번 길게 돌거나 노드가 잠깐 바쁘면 1초를 넘깁니다. 앱이 죽지도 않았는데 재시작이 걸립니다. 헬스 엔드포인트가 아무리 가벼워도 **3~5초는 주는 편**이 안전합니다.

**② 감지 시간은 곱셈입니다.** `periodSeconds × failureThreshold`가 실제로 문제를 감지하기까지의 시간입니다. 기본값이면 10 × 3 = **30초**입니다. 더 빨리 감지하고 싶다면 주기를 줄이되, 그만큼 오탐도 늘어난다는 점을 감수해야 합니다.

**③ `successThreshold`는 Liveness와 Startup에서 1로 고정**입니다. 다른 값을 넣으면 거부됩니다. Readiness에서만 조정할 수 있고, 여기서는 **플래핑을 줄이는 데** 쓸 만합니다.

## 4. Startup probe — 느린 시작을 위한 유예

JVM 앱이나 대형 모델을 올리는 컨테이너는 뜨는 데 2~3분이 걸립니다. Startup probe가 없던 시절에는 `initialDelaySeconds`를 크게 잡아 버텼는데, 이 방식에는 결함이 있습니다. **한 번 지나가면 다시 못 씁니다.** 초기화가 예상보다 오래 걸리면 그대로 재시작 루프에 빠지고, 반대로 빨리 떴어도 설정한 시간만큼은 무조건 기다립니다.

Startup probe는 이 문제를 **"성공할 때까지 기다리되 상한은 둔다"** 로 바꿉니다.

```yaml
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10
  failureThreshold: 30      # 10 × 30 = 최대 300초까지 기다림
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3       # 뜬 뒤에는 30초 안에 감지
```

**Startup probe가 도는 동안 Liveness와 Readiness는 아예 실행되지 않습니다.** 성공하는 순간부터 두 probe가 시작됩니다. 그래서 위 설정은 "뜰 때는 5분까지 봐주고, 뜬 뒤에는 30초 안에 잡는다"가 됩니다. 하나의 `initialDelaySeconds`로는 표현할 수 없는 동작입니다.

> 💡 **Startup probe를 넣으면 Liveness의 `initialDelaySeconds`는 대체로 0으로 둬도 됩니다.** 이미 Startup이 시작 구간을 책임지고 있으니까요. 두 곳에 지연을 중복해 넣으면 감지가 그만큼 늦어집니다.

## 5. Liveness probe 설계 — 없는 게 나을 때도 있다

가장 논쟁적인 부분입니다. **Liveness probe는 기본으로 넣는 것이 아닙니다.**

넣어야 하는 경우는 좁습니다.

- 스레드 데드락처럼 **프로세스는 살아 있는데 일을 못 하는** 상태가 실제로 관측된 적이 있다
- 그 상태가 **재시작으로 확실히 풀린다**
- 그 상태를 **정확히 감지하는 신호**가 있다

세 가지가 다 맞지 않으면 Liveness는 이득보다 위험이 큽니다. 잘못 걸린 Liveness는 **정상 파드를 주기적으로 죽이는 장치**가 되고, 그 재시작이 남은 파드의 부하를 올려 다음 재시작을 부릅니다.

```yaml
# Liveness는 프로세스 자체만 본다
livenessProbe:
  httpGet:
    path: /livez        # DB·캐시·외부 API를 절대 건드리지 않는 경로
    port: 8080
  timeoutSeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

`/livez`는 이벤트 루프가 살아 있으면 즉시 200을 주는 경로여야 합니다. 안에서 아무것도 조회하지 않습니다.

> ⚠️ **Liveness가 계속 실패하는데 원인을 못 찾겠다면 일단 Liveness를 빼십시오.** probe를 지운다고 앱이 더 나빠지지 않습니다. 재시작 루프가 멈추면 로그를 제대로 읽을 시간이 생기고, 그때 원인이 보입니다. 이건 임시방편이 아니라 정석적인 격리 절차입니다.

## 6. Readiness probe 설계 — 트래픽 스위치

Readiness는 Liveness보다 훨씬 자주 필요하고 훨씬 덜 위험합니다. 실패해도 프로세스를 죽이지 않으니까요.

여기에는 **의존성을 넣어도 됩니다.** DB 커넥션 풀이 고갈됐다면 트래픽을 받아봐야 에러만 냅니다. 다른 파드가 여유 있다면 이 파드를 잠깐 빼는 게 맞습니다.

다만 조건이 있습니다.

> ⚠️ **모든 파드가 같은 의존성을 본다면 동시에 빠집니다.** DB가 흔들리면 엔드포인트가 통째로 비고, 서비스는 502를 냅니다. 일부만 죽는 것보다 나쁠 수 있습니다. **공유 의존성은 Readiness에서 빼고 앱이 degraded 응답을 내도록** 설계하는 편이 나은 경우가 많습니다.

Readiness에 넣기 좋은 것은 **그 파드에만 해당하는 상태**입니다. 로컬 캐시 워밍업, 처리 중인 요청 수, 자기 커넥션 풀 상태 같은 것들이죠.

```yaml
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2       # 10초 안에 트래픽에서 빠짐
  successThreshold: 2       # 두 번 연속 성공해야 복귀 — 플래핑 억제
```

## 7. 흔한 오설정 여섯 가지

| 오설정 | 증상 | 고치는 법 |
| --- | --- | --- |
| Liveness에 DB 확인 | 장애 시 전 파드 동시 재시작 | `/livez`는 의존성을 안 봄 |
| `timeoutSeconds` 기본 1초 | 부하 시 무작위 재시작 | 3~5초로 상향 |
| `initialDelaySeconds`로 느린 시작 대응 | 시작 지연 시 재시작 루프 | Startup probe로 이전 |
| 헬스 경로가 인증에 걸림 | 401 → 계속 실패 | 인증 예외 또는 헤더 추가 |
| `tcpSocket`만 사용 | 포트만 열리면 통과 — 먹통 감지 못 함 | `httpGet`으로 실제 처리 확인 |
| 세 probe가 같은 경로 | 역할 분리 붕괴 | `/livez`·`/readyz` 분리 |

`tcpSocket`은 특히 오해가 많습니다. **소켓이 열려 있다는 것과 요청을 처리할 수 있다는 것은 다릅니다.** 스레드 풀이 꽉 차서 아무것도 못 하는 서버도 TCP 연결은 받습니다. HTTP 서버라면 `httpGet`을 쓰십시오.

### probe 실패를 진단하는 법

probe가 왜 실패하는지는 **이벤트에 그대로 찍힙니다.** 로그부터 뒤지지 말고 여기를 먼저 보십시오.

```bash
# 실패 사유와 실제 응답 코드가 그대로 나온다
kubectl describe pod <pod> | sed -n '/Events:/,$p'

# 예시 출력
#   Warning  Unhealthy  2m (x8 over 5m)  kubelet
#     Liveness probe failed: HTTP probe failed with statuscode: 401
#   Warning  Unhealthy  1m (x3 over 4m)  kubelet
#     Readiness probe failed: Get "http://10.1.2.3:8080/readyz": context deadline exceeded
```

두 메시지가 각각 다른 원인을 가리킵니다.

- `statuscode: 401` — **앱까지 도달했는데 인증에 막혔습니다.** 네트워크 문제가 아닙니다
- `context deadline exceeded` — **`timeoutSeconds` 초과**입니다. 앱이 느리거나 한도가 너무 짧습니다

의심되면 **kubelet과 같은 방식으로 직접 호출**해 보십시오. 파드 IP로 노드에서 때리는 것이 원본에 가장 가깝습니다.

```bash
# 파드 IP 확인 후 같은 네트워크의 임시 파드에서 호출
kubectl get pod <pod> -o jsonpath='{.status.podIP}'
kubectl run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -sv -m 5 http://<POD_IP>:8080/readyz

# 재시작 횟수와 직전 종료 사유
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}'
```

마지막 명령의 결과가 힌트를 줍니다. Liveness가 죽인 경우는 대개 `Error`이고 종료 코드가 `137`(SIGKILL)입니다. `OOMKilled`가 나오면 probe가 아니라 메모리 문제입니다 — 원인이 완전히 다르니 그쪽부터 보십시오.

> 💡 **재시작 횟수가 늘지 않는데 트래픽이 안 들어온다면 Readiness만 실패하고 있는 것**입니다. `kubectl get endpoints <service>` 로 파드 IP가 목록에 있는지 확인하면 바로 판별됩니다.

## 8. 종료 흐름과 probe

파드가 종료될 때 두 가지가 **동시에** 일어납니다.

```
삭제 요청
  ├─ ① 엔드포인트에서 제거 → kube-proxy·Ingress로 전파 (수 초 소요)
  └─ ② 컨테이너에 SIGTERM → terminationGracePeriodSeconds 후 SIGKILL
```

문제는 ①이 **비동기이고 느리다**는 점입니다. 앱이 SIGTERM을 받고 즉시 종료하면, 아직 전파가 안 끝난 프록시가 보낸 요청이 갈 곳을 잃습니다. 배포할 때마다 5xx가 조금씩 찍히는 전형적인 원인입니다.

해법은 **`preStop`으로 몇 초 버티는 것**입니다.

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 10"]
terminationGracePeriodSeconds: 45     # preStop + 실제 종료 시간보다 넉넉하게
```

`preStop`이 도는 동안에도 앱은 계속 요청을 받습니다. 그 사이에 엔드포인트 제거가 전파되고, 그다음에 SIGTERM이 갑니다.

**probe에도 별도 grace period를 줄 수 있습니다.** `terminationGracePeriodSeconds`를 probe 안에 넣으면 **그 probe가 실패해서 죽일 때만** 다른 값을 씁니다(**1.28 stable**). Liveness와 Startup에만 적용되고 Readiness에는 의미가 없습니다.

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
  failureThreshold: 3
  terminationGracePeriodSeconds: 5    # 먹통이면 오래 기다릴 이유가 없다
```

> 💡 정상 배포는 넉넉히(45초), **먹통이라 죽이는 경우는 짧게**(5초) — 이렇게 나누면 롤아웃 속도와 안전성을 동시에 챙길 수 있습니다.

## 9. 사이드카 컨테이너와 probe

`restartPolicy: Always`를 가진 init container, 즉 **네이티브 사이드카**는 **1.28에 도입되어 1.33에서 GA**됐습니다.

일반 init container와 달리 사이드카는 **파드가 사는 내내 함께 살고, probe를 붙일 수 있습니다.**

```yaml
initContainers:
  - name: proxy
    image: envoy:latest
    restartPolicy: Always      # 이 한 줄이 사이드카로 만든다
    startupProbe:
      httpGet: { path: /ready, port: 15000 }
      failureThreshold: 30
```

이게 중요한 이유는 **순서** 때문입니다. 사이드카는 앱 컨테이너보다 먼저 시작하고, 사이드카의 Startup probe가 성공해야 앱 컨테이너가 뜹니다. 프록시가 아직 준비 안 됐는데 앱이 먼저 떠서 아웃바운드 요청이 전부 실패하던 고전적인 문제가 **설정만으로 해결**됩니다.

## 10. 실전 템플릿

기본으로 깔고 시작할 만한 조합입니다.

```yaml
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: app
      ports:
        - name: http
          containerPort: 8080

      # 시작 구간 — 최대 5분까지 기다린다
      startupProbe:
        httpGet: { path: /livez, port: http }
        periodSeconds: 10
        timeoutSeconds: 5
        failureThreshold: 30

      # 트래픽 스위치 — 10초 안에 빠지고, 두 번 성공해야 복귀
      readinessProbe:
        httpGet: { path: /readyz, port: http }
        periodSeconds: 5
        timeoutSeconds: 3
        failureThreshold: 2
        successThreshold: 2

      # 최후 수단 — 정말 먹통일 때만
      livenessProbe:
        httpGet: { path: /livez, port: http }
        periodSeconds: 10
        timeoutSeconds: 5
        failureThreshold: 3
        terminationGracePeriodSeconds: 5

      lifecycle:
        preStop:
          exec: { command: ["sh", "-c", "sleep 10"] }
```

앱 쪽에는 경로 두 개만 만들면 됩니다.

- `/livez` — 아무것도 조회하지 않고 즉시 200
- `/readyz` — 자기 커넥션 풀·캐시 워밍업 등 **자기 상태만** 확인

## 마무리

Probe는 설정 필드가 몇 개 안 되는데도 사고가 잦습니다. 이유는 단순합니다. **세 probe의 역할 차이를 흐린 채 같은 엔드포인트를 붙이기** 때문입니다.

기억할 것은 결국 두 문장입니다. **Liveness는 재시작으로 풀리는 문제에만 건다. Readiness는 트래픽을 끊는 게 정말 나을 때만 건다.** 이 기준으로 지금 클러스터의 probe를 훑어보면, 상당수는 지워도 되거나 `/livez`·`/readyz`로 갈라야 할 것들일 겁니다.

📎 **함께 읽으면 좋은 글**

- Kubernetes CrashLoopBackOff 완전 해결 가이드
- Kubernetes OOMKilled 해결 가이드 — 메모리 제한과 JVM 설정
- Kubernetes ImagePullBackOff 트러블슈팅
- Kubernetes 파드 스케줄링 실패 진단하기

태그(9개): devops, k8s, kubernetes, liveness, probe, readiness, sre, startupprobe, 트러블슈팅
