# Kubernetes OOMKilled 해결 가이드 — Exit 137·limits·JVM Heap·cgroup v2 원인별 점검

애플리케이션 로그에는 아무 에러도 없는데 Pod가 조용히 재시작을 반복하는 상황. `kubectl logs`를 아무리 뒤져도 스택트레이스가 없고, 마지막 줄은 평범한 요청 처리 로그에서 끊겨 있습니다. 이 침묵이 OOMKilled의 특징입니다. 프로세스가 예외를 던지고 죽은 게 아니라, **커널이 예고 없이 SIGKILL을 보냈기 때문**입니다.

## 핵심 요약

- OOMKilled는 애플리케이션 오류가 아니라 **cgroup 메모리 한도를 넘겨 커널이 내린 강제 종료 판정**입니다. Exit Code는 `137`(= 128 + SIGKILL 9)입니다.
- 첫 명령은 앞선 세 편과 같습니다. `kubectl describe pod`로 **`Last State`의 `Reason`** 을 확인하십시오. Exit Code 137만 보고 판단하면 안 됩니다.
- 자바 애플리케이션의 OOMKilled는 대부분 **힙이 아니라 힙 바깥(Metaspace·스레드 스택·Direct Buffer)** 에서 발생합니다.
- **OOMKilled와 Evicted는 다른 사건입니다.** 전자는 컨테이너 한도 초과, 후자는 노드 전체의 메모리 압박입니다. 처방이 완전히 다릅니다.
- 재발 방지의 핵심은 limits를 올리는 것이 아니라, **working set 기준 실측값으로 requests·limits를 다시 계산**하는 것입니다.

## 1. OOMKilled란 무엇인가 — 커널이 내린 판정문

컨테이너에 `resources.limits.memory`를 설정하면 쿠버네티스는 이를 cgroup의 메모리 상한으로 씁니다. 컨테이너 안의 프로세스들이 이 상한을 넘기려는 순간, 커널의 OOM Killer가 개입해 프로세스를 죽입니다.

여기서 중요한 성질이 세 가지 있습니다.

- **애플리케이션은 알 수 없습니다.** SIGKILL은 잡을 수 없으므로 종료 훅도, 로그도 남지 않습니다.
- **회수 가능한 페이지 캐시는 먼저 반납됩니다.** 커널은 한도에 부딪히면 페이지 캐시부터 회수하고, 그래도 `memory.current`를 `memory.max` 아래로 못 내릴 때 OOM 킬을 냅니다. 그래서 관측 지표로는 `사용량 − inactive_file`인 **working set**이 실제 압박에 가장 잘 대응합니다(kubelet의 노드 축출 판단도 이 값을 씁니다). 다만 커널의 컨테이너 OOM 판정식 자체가 working set인 것은 아닙니다.
- **한도는 컨테이너 단위입니다.** 사이드카가 메모리를 먹어도 같은 Pod의 다른 컨테이너는 영향을 받지 않지만, Pod 전체 한도 계산에는 포함됩니다.

> `Exit Code: 137`은 **SIGKILL로 죽었다는 사실만** 알려줍니다. OOM 때문일 수도 있고, 종료 유예 시간을 넘겨 kubelet이 강제 종료했을 수도 있습니다. 반드시 `Reason: OOMKilled` 를 함께 확인하십시오.

## 2. 첫 번째 명령 — describe로 Last State 읽기

```bash
kubectl describe pod <pod-name> -n <namespace>
```

컨테이너 섹션에서 다음을 봅니다.

```
    State:          Running
      Started:      Sun, 16 Aug 2026 14:21:03 +0900
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
      Started:      Sun, 16 Aug 2026 14:02:11 +0900
      Finished:     Sun, 16 Aug 2026 14:20:58 +0900
    Restart Count:  7
    Limits:
      memory:  512Mi
    Requests:
      memory:  256Mi
```

여기서 읽어야 할 정보는 네 가지입니다.

- **`Reason: OOMKilled`** — 확정 판정
- **`Restart Count`** — 반복 여부. 1회성인지 지속적인지가 처방을 가릅니다
- **`Started` → `Finished` 간격** — 몇 분 만에 죽는지. 즉시 죽으면 초기 할당, 서서히 죽으면 누수를 의심합니다
- **`Limits.memory`** — 비교 기준값

이벤트도 함께 확인합니다. 다만 **컨테이너 단위 OOM은 이벤트가 아니라 컨테이너 상태에 기록**되고, 노드 레벨 OOM만 kubelet이 Node 오브젝트에 `SystemOOM` 이벤트로 남깁니다. Node 오브젝트는 네임스페이스가 없어 이벤트가 `default`에 쌓입니다.

```bash
# 컨테이너 단위 — 상태에서 읽는다
kubectl get pod <pod> -n <namespace> \
  -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.lastState.terminated.reason}{"\n"}{end}'

# 노드 레벨 — kubelet이 남기는 SystemOOM 이벤트
kubectl get events -A --field-selector reason=SystemOOM --sort-by=.lastTimestamp
```

> `reason=OOMKilling`으로 검색하는 예제가 널리 퍼져 있지만, 이 값은 kubelet이 아니라 **node-problem-detector**의 kernel-monitor 규칙 이름입니다. NPD를 설치하지 않았다면 결과가 항상 비어 있고, 그것을 "OOM이 없다"로 오해하기 쉽습니다.

컨테이너 안에서 직접 확인할 수도 있습니다. cgroup v2 기준입니다.

```bash
kubectl exec -it <pod> -- sh -c '
  echo "limit  : $(cat /sys/fs/cgroup/memory.max)"
  echo "current: $(cat /sys/fs/cgroup/memory.current)"
  echo "--- events ---"
  cat /sys/fs/cgroup/memory.events
'
```

`memory.events`의 `oom_kill` 카운터가 0보다 크면 이 컨테이너에서 실제로 OOM 킬이 일어났다는 뜻입니다.

## 3. 원인 1 — limits가 실제 사용량보다 작다

가장 흔하고 가장 단순한 경우입니다. 진단은 **과거 사용량 추이**로 합니다. `kubectl top`은 현재값만 보여주므로 판단 근거로 부족합니다.

```bash
# 현재값 (참고용)
kubectl top pod <pod> -n <namespace> --containers
```

메트릭 서버가 있다면 다음 지표를 봅니다.

- `container_memory_working_set_bytes` — 회수 불가 메모리에 가장 가까운 값(`usage − total_inactive_file`). **OOM을 예측할 때 봐야 하는 지표**입니다
- `container_memory_usage_bytes` — 페이지 캐시를 포함해 실제보다 높게 나옵니다
- `container_spec_memory_limit_bytes` — 설정된 한도

판단 기준은 다음과 같습니다.

| 관측 패턴 | 해석 | 처방 |
| --- | --- | --- |
| 시작 직후 한도 근처 도달 | 초기 할당량 부족 | limits 상향 |
| 계단식으로 서서히 상승 | 메모리 누수 | 애플리케이션 수정 |
| 특정 요청에서 급증 후 복귀 | 대용량 처리 경로 | 스트리밍·페이징 처리 |
| 톱니 모양으로 안정 | 정상 GC 패턴 | 한도만 소폭 상향 |

> **limits를 올리는 것은 누수 문제의 해결책이 아닙니다.** 계단식 상승 패턴이 보이면 한도를 두 배로 올려도 재시작 주기가 두 배로 늘어날 뿐입니다.

## 4. 원인 2 — JVM이 컨테이너 한도를 모르거나, 힙 바깥이 넘친다

자바 애플리케이션의 OOMKilled는 별도로 다뤄야 할 만큼 패턴이 뚜렷합니다. 핵심은 **`OutOfMemoryError`와 OOMKilled가 다른 사건**이라는 것입니다.

- **`OutOfMemoryError`** — JVM이 힙 한도에 도달. 스택트레이스가 남고 힙 덤프를 뜰 수 있습니다
- **OOMKilled** — JVM 프로세스 전체가 cgroup 한도를 초과. **아무 로그도 남지 않습니다**

즉 OOMKilled가 났다면 문제는 대체로 **힙이 아니라 힙 바깥**입니다.

```
컨테이너 메모리 = 힙(Heap)
               + Metaspace
               + 코드 캐시(JIT)
               + 스레드 스택 (스레드 수 × 1MB 기본)
               + Direct ByteBuffer / Native 라이브러리
               + GC 자체 오버헤드
```

먼저 JVM이 컨테이너 한도를 인식하는지 확인합니다.

```bash
kubectl exec -it <pod> -- java -XX:+PrintFlagsFinal -version | \
  grep -E "MaxHeapSize|UseContainerSupport|MaxRAMPercentage"
```

- `UseContainerSupport`는 JDK 10 이상(및 8u191 이상)에서 **기본 활성화**입니다. `false`라면 컨테이너 한도를 무시하고 노드 전체 메모리를 기준으로 힙을 잡습니다
- `MaxRAMPercentage`의 기본값은 **25%** 입니다. 512Mi 한도라면 힙이 128Mi로 잡혀 오히려 힙 부족이 먼저 발생합니다

권장 설정은 다음과 같습니다.

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=70.0
      -XX:+ExitOnOutOfMemoryError
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/dump
  # NMT는 JAVA_TOOL_OPTIONS로 켜지지 않는다. java 런처가 직접 읽는 경로로 넣는다 (JDK 9+)
  - name: JDK_JAVA_OPTIONS
    value: "-XX:NativeMemoryTracking=summary"
volumeMounts:
  - name: dump
    mountPath: /dump
resources:
  requests:
    memory: "1Gi"
  limits:
    memory: "1Gi"
```

- **`MaxRAMPercentage=70`** — 나머지 30%를 힙 바깥 영역에 남깁니다. 스레드가 많은 서비스는 60%까지 낮추십시오
- **`ExitOnOutOfMemoryError`** — 힙 부족 시 즉시 종료시켜, OOMKilled와 구분 가능한 신호를 남깁니다
- **`NativeMemoryTracking`은 `JAVA_TOOL_OPTIONS`에 넣으면 안 됩니다.** NMT는 JVM이 이 환경변수를 파싱하기 전에 초기화되므로 조용히 무시되고, `jcmd` 실행 시 `Native memory tracking is not enabled`가 뜹니다(JDK 8에서는 크래시가 보고돼 Won't Fix로 종결됐습니다). `JDK_JAVA_OPTIONS`(JDK 9+)나 컨테이너 `command`/`args`의 java 실행 인자에 직접 넣으십시오
- **`HeapDumpPath=/dump`** — 해당 경로에 볼륨이 마운트돼 있어야 합니다. 마운트가 없으면 덤프가 컨테이너와 함께 사라집니다

네이티브 메모리 내역은 이렇게 확인합니다.

```bash
kubectl exec -it <pod> -- jcmd 1 VM.native_memory summary
```

출력에서 `Thread`, `Class`(Metaspace), `Code`, `Internal` 항목이 예상보다 크면 원인이 특정됩니다. 스레드 수가 많다면 `-Xss`를 낮추거나 스레드 풀 크기를 줄이는 것이 직접적인 처방입니다.

## 5. 원인 3 — 파이썬·Node.js 런타임의 네이티브 메모리

JVM 외의 런타임도 같은 함정이 있습니다.

**Node.js** — Node 12부터 cgroup 메모리 한도를 인식하며, Node 20 기준 기본 old space는 **컨테이너 한도에서 산출**됩니다(대략 4Gi 이하 컨테이너에서 한도의 50%, 그보다 크면 2GB 안팎에서 상한). 따라서 `--max-old-space-size`는 반드시 넣어야 하는 값이 아니라, **기본 산출값이 워크로드와 맞지 않을 때 덮어쓰는 값**입니다. 특히 컨테이너가 4Gi를 넘으면 기본 힙이 한도보다 훨씬 작게 잡히므로 이때 명시하십시오.

```yaml
env:
  - name: NODE_OPTIONS
    value: "--max-old-space-size=1536"   # limits가 2Gi일 때 기본값을 덮어쓰는 예
```

**Python** — 인터프리터 차원의 상한이 없어 컨테이너 한도까지 그대로 올라갑니다. 자주 걸리는 지점은 두 가지입니다.

- **glibc malloc arena** — 스레드마다 아레나가 생겨 실제 사용량보다 RSS가 크게 잡힙니다

```yaml
env:
  - name: MALLOC_ARENA_MAX
    value: "2"
```

- **워커 프로세스 수** — Gunicorn·Uvicorn의 워커는 각각 독립적인 메모리를 씁니다. `워커 수 × 워커당 메모리`가 한도를 넘지 않는지 계산하십시오

```bash
kubectl exec -it <pod> -- sh -c 'ps -o pid,rss,comm -e | sort -k2 -rn | head'
```

## 6. 원인 4 — OOMKilled인가 Evicted인가

같은 "메모리 부족"이지만 완전히 다른 사건이고, **혼동하면 엉뚱한 곳을 고치게 됩니다.**

| 구분 | OOMKilled | Evicted |
| --- | --- | --- |
| 주체 | 커널 OOM Killer | kubelet |
| 원인 | 컨테이너가 자기 limits 초과 | 노드 전체 메모리 부족 |
| 확인 위치 | `Last State.Reason` | `Pod.Status.Reason` |
| Pod 상태 | 재시작(같은 노드) | 축출 후 재스케줄 |
| 처방 | limits·애플리케이션 수정 | requests 조정·노드 증설 |

Evicted는 이렇게 확인합니다.

```bash
kubectl get pods -n <namespace> --field-selector status.phase=Failed
kubectl describe node <node> | grep -A5 "Conditions"
```

노드에 `MemoryPressure: True`가 보이면 축출 경로입니다. 이때 kubelet은 **QoS 클래스로 축출 순서를 정하지 않습니다.** 공식 문서가 명시하듯 실제 판정은 ① 사용량이 `requests`를 초과했는가 ② Pod Priority ③ `requests` 대비 초과량 순서로 이뤄지고, 그 결과가 대체로 다음처럼 나타납니다.

- **`requests`를 초과한 BestEffort·Burstable** — 가장 먼저 축출 (Priority 낮은 것부터)
- **`requests` 이하로 쓰는 Burstable / Guaranteed** — 마지막 (Priority 낮은 것부터)

즉 QoS는 규칙이 아니라 **결과를 가늠하는 지표**입니다. Priority가 높고 `requests` 안에서 쓰는 Pod는 QoS와 무관하게 오래 살아남습니다.

> 중요한 워크로드라면 `requests`와 `limits`를 같은 값으로 두십시오. 사용량이 절대 `requests`를 초과할 수 없게 되어 축출 판정의 첫 관문에 걸리지 않습니다. 이는 성능 튜닝이 아니라 **생존 순위를 정하는 설정**입니다.

## 7. 원인 5 — cgroup v1과 v2의 차이

노드의 cgroup 버전에 따라 확인 경로와 동작이 달라집니다.

```bash
kubectl exec -it <pod> -- stat -fc %T /sys/fs/cgroup
# cgroup2fs → v2,  tmpfs → v1
```

| 항목 | cgroup v1 | cgroup v2 |
| --- | --- | --- |
| 한도 파일 | `memory/memory.limit_in_bytes` | `memory.max` |
| 현재값 | `memory/memory.usage_in_bytes` | `memory.current` |
| OOM 킬 횟수 | `memory/memory.oom_control`의 `oom_kill`(커널 4.13+) | `memory.events`의 `oom_kill` |
| 한도 도달 횟수 | `memory/memory.failcnt` | (직접 대응 없음) |
| 부드러운 한도 | `soft_limit_in_bytes` | `memory.high`(스로틀링) |
| 그룹 단위 킬 | 없음 | `memory.oom.group` |

여기서 자주 틀리는 지점이 하나 있습니다. **`memory.failcnt`는 OOM 킬 횟수가 아니라 사용량이 한도에 부딪힌 횟수**입니다. 회수에 성공해 아무 프로세스도 죽지 않아도 증가하므로, 이 값만 보고 OOM을 단정하면 안 됩니다. v1에서 실제 킬 횟수는 `memory.oom_control`의 `oom_kill` 필드를 보십시오.

v2에서 실무적으로 중요한 차이는 두 가지입니다.

- **`memory.high`** — 한도에 도달하기 전에 할당을 지연시켜 압박을 완화합니다. 급사 대신 성능 저하로 바꿔주는 장치입니다
- **`memory.oom.group`** — cgroup 안의 프로세스를 **한꺼번에** 죽입니다. v1에서 흔했던 "자식 프로세스만 죽고 부모는 좀비처럼 남는" 상황이 줄었습니다

## 8. 재발 방지 — requests·limits를 다시 계산하기

감으로 정하지 말고 **실측에서 역산**하십시오.

1. **관측 기간을 정한다** — 최소 7일. 주간 트래픽 주기를 포함해야 합니다
2. **working set의 P95를 구한다** — 평균이 아니라 상위 백분위를 씁니다
3. **requests = P95** — 스케줄러가 자리를 확보할 기준값
4. **limits = P99 × 1.2~1.5** — 급증을 흡수할 여유
5. **중요 워크로드는 requests = limits** — 사용량이 `requests`를 초과할 수 없어 축출 판정의 첫 관문에 걸리지 않습니다

```promql
# working set P95 / P99 (7일)
# quantile_over_time은 시리즈별로 값을 내므로 max로 접어 한 값으로 만든다
max(
  quantile_over_time(0.95,
    container_memory_working_set_bytes{namespace="my-ns", container="my-app"}[7d]
  )
)

max(
  quantile_over_time(0.99,
    container_memory_working_set_bytes{namespace="my-ns", container="my-app"}[7d]
  )
)
```

- 라벨은 `pod=~"my-app-.*"`(카나리·워커까지 걸립니다) 대신 **`container=` 정확 매칭**을 쓰십시오.
- 7일 원시 범위 쿼리는 샘플 수가 커서 `query.max-samples`나 타임아웃에 걸리기 쉽습니다. 운영에서는 5분 단위 recording rule을 먼저 만들고 그 위에서 `quantile_over_time`을 돌리는 편이 안전합니다.

자동화가 필요하다면 VPA를 **`updateMode: "Off"`(권고만 산출)** 로 먼저 붙여 추천값을 관찰하는 방식이 안전합니다.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Off"      # 추천값만 계산, 실제 변경 없음
```

## 9. 모니터링 — 무엇을 알람으로 걸 것인가

OOMKilled는 재시작으로 복구되기 때문에 **아무도 모르는 사이에 계속 일어납니다.** 다음 두 가지는 반드시 알람으로 거십시오.

```promql
# 1) 최근 10분 내 OOM으로 인한 컨테이너 재시작
increase(kube_pod_container_status_restarts_total[10m]) > 0
  and on(namespace, pod, container)
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1

# 2) working set이 limits의 90%를 넘긴 상태가 5분 지속
container_memory_working_set_bytes{container!=""}
  / on(namespace, pod, container)
    max by(namespace, pod, container) (
      container_spec_memory_limit_bytes{container!=""} > 0
    )
  > 0.9
```

두 번째가 특히 중요합니다. **OOM이 나기 전에 알려주는 유일한 신호**이기 때문입니다. 다만 두 가지를 반드시 지켜야 합니다.

- **`> 0` 필터** — `container_spec_memory_limit_bytes`는 limits가 없는 컨테이너에서 **0**으로 보고됩니다. 필터 없이 나누면 `+Inf`가 되어 알람이 영구히 발화합니다.
- **조인 라벨에 `namespace` 포함** — 같은 이름의 사이드카(`istio-proxy` 등)가 여러 네임스페이스에 있으면 조인이 엉킵니다.

## 10. 흔한 실수

- **Exit Code 137만 보고 OOM으로 단정한다** — 종료 유예 시간 초과로 인한 SIGKILL도 137입니다. `Reason`을 확인하십시오.
- **limits만 올리고 끝낸다** — 누수라면 재시작 주기만 늘어납니다. 사용량 추이 모양을 먼저 보십시오.
- **JVM 힙만 조정한다** — OOMKilled는 대체로 힙 바깥 문제입니다. `MaxRAMPercentage`를 100 가까이 올리면 오히려 더 빨리 죽습니다.
- **`container_memory_usage_bytes`로 판단한다** — 페이지 캐시가 포함되어 실제보다 높습니다. `working_set`을 쓰십시오.
- **requests만 올리고 limits를 방치한다** — OOM 판정은 limits 기준입니다. requests는 스케줄링에만 쓰입니다.
- **사이드카 메모리를 계산에서 뺀다** — 로그 수집기·프록시도 Pod 메모리 예산을 씁니다.
- **`kubectl logs`만 보고 원인이 없다고 결론 낸다** — SIGKILL은 로그를 남기지 않습니다. 없는 것이 정상입니다.
- **OOMKilled와 Evicted를 같은 문제로 처리한다** — 전자는 컨테이너, 후자는 노드 문제입니다.

## 실전 체크리스트

- `kubectl describe pod`에서 `Last State.Reason`이 `OOMKilled`인지 확인했다.
- `Restart Count`와 `Started`→`Finished` 간격으로 즉사인지 서서히 죽는지 구분했다.
- `container_memory_working_set_bytes`의 7일 추이를 보고 누수 여부를 판정했다.
- Pod 상태가 `Failed`/`Evicted`인지 확인해 노드 압박과 구분했다.
- 노드의 `MemoryPressure` 컨디션을 확인했다.
- 자바라면 `UseContainerSupport`와 `MaxRAMPercentage` 실제 적용값을 확인했다.
- 자바라면 `VM.native_memory summary`로 힙 바깥 사용량을 확인했다.
- 사이드카를 포함한 Pod 전체 메모리 합계를 계산했다.
- 중요 워크로드의 `requests`와 `limits`를 같게 설정해 축출 1순위 판정을 피했다.
- 알람 PromQL의 조인 라벨에 `namespace`를 포함하고, limits가 0인 컨테이너를 필터로 제외했다.
- NMT를 `JAVA_TOOL_OPTIONS`가 아니라 `JDK_JAVA_OPTIONS` 또는 java 실행 인자로 지정했다.
- working set이 limits의 90%를 넘는 상태에 대한 알람을 등록했다.
- cgroup 버전을 확인하고 그에 맞는 경로로 진단했다.

## 마치며

OOMKilled는 장애라기보다 **커널이 남긴 영수증**입니다. "이 컨테이너가 약속한 한도를 넘겼다"는 사실만 정확히 기록되어 있고, 왜 넘겼는지는 적혀 있지 않습니다.

그래서 순서가 중요합니다. `Reason`으로 사건을 확정하고, working set 추이의 **모양**으로 원인 유형을 나누고, 런타임별 힙 바깥 영역을 확인하는 것. 네 편의 쿠버네티스 가이드가 모두 `kubectl describe pod`에서 시작한다는 점만 기억해도, 현장에서 로그를 뒤지며 보내는 시간이 크게 줄어들 것입니다.

## FAQ

**Q1. limits를 아예 설정하지 않으면 OOMKilled가 안 나나요?**
자기 한도를 넘겨서 죽는 경로는 사라지지만 더 나쁜 상황이 됩니다. `requests`까지 비워두면 QoS가 **BestEffort**가 되어(= `requests`만 설정하면 **Burstable**입니다) 노드 압박 시 사실상 가장 먼저 정리되고, 그 전에 노드 전체 메모리를 마르게 만듭니다. 게다가 노드가 마르면 커널의 글로벌 OOM Killer가 이 컨테이너를 죽여 결국 `Reason: OOMKilled`가 그대로 찍힙니다. 한도는 반드시 설정하십시오.

**Q2. 메모리를 계속 늘렸는데도 같은 지점에서 죽습니다.**
누수이거나, 애플리케이션 내부에 한도가 박혀 있는 경우입니다. JVM이라면 `-Xmx`가 하드코딩되어 `MaxRAMPercentage`가 무시되고 있는지, Node.js라면 `--max-old-space-size`가 고정되어 있는지 확인하십시오.

**Q3. Pod에 컨테이너가 여러 개인데 어느 쪽이 죽었는지 어떻게 아나요?**
`kubectl describe pod` 출력은 컨테이너별로 `Last State`를 각각 표시합니다. `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].name}{"\n"}{.status.containerStatuses[*].lastState.terminated.reason}'` 로 한 줄에 확인할 수도 있습니다.

**Q4. 힙 덤프를 뜨고 싶은데 OOMKilled라 파일이 남지 않습니다.**
SIGKILL 시점에는 덤프를 뜰 수 없습니다. `-XX:+ExitOnOutOfMemoryError`와 `-XX:+HeapDumpOnOutOfMemoryError`를 함께 걸어 **힙 부족을 OOMKilled보다 먼저 발생시키고**, 덤프 경로를 emptyDir이 아닌 영속 볼륨으로 지정하십시오. `MaxRAMPercentage`를 낮추면 이 순서를 만들 수 있습니다.

## 참고 공식 문서

- Kubernetes — Resource Management for Pods and Containers
- Kubernetes — Configure Quality of Service for Pods
- Kubernetes — Node-pressure Eviction

## 함께 읽으면 좋은 글

- Kubernetes Pod Pending 해결 가이드 — 리소스·Taint·Affinity·PVC 원인별 점검
- Kubernetes CrashLoopBackOff 해결 가이드 — 로그·이벤트·Probe·OOM 점검
- Kubernetes ImagePullBackOff 해결 가이드 — 이미지·인증·네트워크 원인별 점검
- Spring Boot Actuator 운영 가이드 — Health·Metrics·Prometheus·보안 설정

---

**태그(9개):** cgroupv2, ExitCode137, JVM튜닝, Kubernetes, OOMKilled, VPA, 메모리누수, 쿠버네티스, 트러블슈팅
