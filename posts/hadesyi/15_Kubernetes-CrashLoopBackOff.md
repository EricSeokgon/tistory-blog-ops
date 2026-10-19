# Kubernetes CrashLoopBackOff 해결 가이드 — 로그·이벤트·Probe·OOM 점검

배포 직후 `kubectl get pod`를 치면 `STATUS` 칸에 `CrashLoopBackOff`가 찍혀 있고, `RESTARTS` 숫자는 볼 때마다 하나씩 늘어 있습니다. 급한 마음에 `kubectl logs`를 열어 보면 로그가 텅 비어 있거나, 방금 막 기동을 시작한 평범한 줄만 보입니다. 이 상황이 헷갈리는 이유는 CrashLoopBackOff가 **에러의 이름이 아니라 "계속 죽어서 재시작을 미루는 중"이라는 상태 표시**이기 때문입니다. 원인은 그 앞, 컨테이너가 마지막으로 종료된 순간에 남아 있습니다. 이 글은 그 종료 증거를 어디서 어떤 순서로 꺼내는지, 그리고 증거별로 무엇을 고쳐야 하는지를 정리합니다.

## 핵심 요약

- CrashLoopBackOff는 원인이 아니라 결과입니다. **kubelet이 반복 종료되는 컨테이너의 재시작을 점점 늦추고 있다**는 뜻이고, 고쳐야 할 대상은 "왜 종료됐는가"입니다.
- 트러블슈팅 시리즈의 공통 출발점은 같습니다. **`kubectl describe pod`로 `Last State`의 `Reason`과 `Exit Code`** 를 먼저 확인하십시오.
- 로그는 반드시 **`kubectl logs --previous`** 로 봅니다. 현재 로그는 막 재시작된 새 컨테이너의 것이라 원인이 남아 있지 않은 경우가 많습니다.
- Exit Code가 원인 범주를 알려 줍니다. **1은 애플리케이션 오류, 137은 SIGKILL(대개 OOM), 143은 SIGTERM, 0은 "정상 종료인데 재시작되는" 설계 문제**입니다.
- Liveness Probe 오설정과 메모리 한도는 CrashLoopBackOff의 단골 원인입니다. 증거가 그쪽을 가리키면 **Probe·OOM 전용 글의 점검 순서**로 넘어가십시오.

## 1. CrashLoopBackOff의 정체 — 재시작 지연 장치

Pod의 `restartPolicy`가 `Always`(Deployment의 유일한 허용값)나 `OnFailure`이면, 컨테이너가 종료될 때 kubelet이 같은 노드에서 컨테이너를 다시 띄웁니다. 문제는 컨테이너가 뜨자마자 다시 죽는 경우입니다. 그대로 두면 kubelet이 초당 몇 번씩 재시작을 시도하며 노드 자원을 낭비하게 됩니다.

그래서 kubelet은 **재시작 사이에 지수적으로 늘어나는 대기 시간(back-off)** 을 둡니다. 공식 문서 기준 기본 동작은 다음과 같습니다.

- 대기 시간은 **10초, 20초, 40초처럼 두 배씩** 늘어나고 **최대 300초(5분)** 에서 멈춥니다
- 컨테이너가 **10분 동안 문제없이 실행되면** 대기 시간이 초기화되어, 다음 종료는 첫 종료처럼 취급됩니다
- 이 대기 구간에 있는 동안 `kubectl get pod`가 `CrashLoopBackOff`를 표시합니다

```text
NAME                   READY   STATUS             RESTARTS      AGE
api-7d9c6b5f4d-x2kqp   0/1     CrashLoopBackOff   6 (2m31s ago)   9m
```

`STATUS`는 시점에 따라 `Error`, `OOMKilled`, `Completed`, `CrashLoopBackOff`를 오갑니다. 재시작 직후 잠깐은 `Running`으로 보이기도 합니다. 그래서 `STATUS` 한 번만 보고 판단하면 틀리기 쉽습니다.

> 최대 대기 시간은 버전과 설정에 따라 다를 수 있습니다. 1.33부터 알파로 들어온 `ReduceDefaultCrashLoopBackOffDecay`를 켜면 1초에서 시작해 최대 60초로 줄고, `KubeletCrashLoopBackOffMax`(1.35 베타)를 쓰면 노드별 kubelet 설정의 `crashLoopBackOff.maxContainerRestartPeriod`로 상한을 낮출 수 있습니다. 어느 쪽이든 **대기 시간을 줄이는 것은 진단 속도를 높일 뿐, 원인을 고치지는 않습니다.**

## 2. 첫 5분 진단 순서 — describe에서 시작한다

트러블슈팅 시리즈의 다른 글(ImagePullBackOff, Pending, OOMKilled)과 마찬가지로 **첫 명령은 `kubectl describe pod`** 입니다. 순서를 고정해 두면 장애 상황에서도 빠뜨리는 단계가 없습니다.

```bash
# 1) 어떤 Pod가 몇 번 재시작했는가
kubectl get pod -n app -o wide

# 2) 직전 종료의 Reason·Exit Code·종료 시각, 그리고 Events
kubectl describe pod api-7d9c6b5f4d-x2kqp -n app

# 3) 직전 컨테이너(죽은 쪽)의 로그
kubectl logs api-7d9c6b5f4d-x2kqp -n app --previous

# 4) 컨테이너가 여러 개면 대상을 지정
kubectl logs api-7d9c6b5f4d-x2kqp -n app -c api --previous

# 5) 네임스페이스 이벤트를 시간순으로
kubectl get events -n app --sort-by=.lastTimestamp
```

`describe` 출력에서 봐야 할 곳은 컨테이너 블록의 세 줄과 맨 아래 Events입니다.

```text
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
      Started:      Mon, 19 Oct 2026 21:02:11 +0900
      Finished:     Mon, 19 Oct 2026 21:02:14 +0900
    Restart Count:  6
...
Events:
  Warning  BackOff  2m (x25 over 9m)  kubelet  Back-off restarting failed container api in pod api-7d9c6b5f4d-x2kqp
```

**`State`가 아니라 `Last State`** 를 보십시오. `State`는 지금 대기 중이라는 사실만 알려 주고, 원인은 `Last State`의 `Reason`과 `Exit Code`에 있습니다. `Started`와 `Finished`의 간격도 단서입니다. 3초 만에 죽었다면 기동 단계의 설정 오류, 몇 분을 버티다 죽었다면 메모리 누적이나 Probe 실패 쪽을 먼저 의심합니다.

여러 Pod를 한 번에 훑을 때는 `jsonpath`로 직전 종료 정보만 뽑으면 빠릅니다.

```bash
kubectl get pod -n app -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.containerStatuses[0].lastState.terminated.reason}{"\t"}{.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}{end}'
```

## 3. Exit Code로 원인 범주 좁히기

컨테이너 종료 코드는 원인을 범주로 나눠 줍니다. 128보다 큰 값은 **128 + 시그널 번호**라는 관례를 따르므로, 137은 SIGKILL(9), 143은 SIGTERM(15)입니다.

| Exit Code / Reason | 의미 | 먼저 볼 곳 |
| --- | --- | --- |
| `0` / `Completed` | 프로세스가 정상 종료했는데 정책상 다시 띄워짐 | 워크로드 종류(Deployment인가 Job인가), 포그라운드 실행 여부 |
| `1` / `Error` | 애플리케이션이 예외로 종료 | `logs --previous`의 첫 스택트레이스, 설정·Secret |
| `126` | 셸 안에서 실행한 파일에 실행 권한 없음 | 엔트리포인트 스크립트의 실행 권한(`chmod +x`), `securityContext` |
| `127` | 셸(`sh -c`·래퍼 스크립트) 안에서 명령을 찾지 못함 | 스크립트 안의 명령 오타, `PATH`, 이미지에 없는 도구 |
| `128` / `StartError` | 런타임이 프로세스를 시작하지 못함(containerd에서 흔함) | `describe`의 메시지(실행 파일 없음, 마운트 실패) |
| `137` / `OOMKilled` | 메모리 한도 초과로 커널이 SIGKILL | 메모리 limit과 실제 사용량, 노드 메모리 압박 |
| `137` / `Error` | OOM이 아닌 SIGKILL | Liveness 실패 후 유예 시간 초과, 수동 종료 |
| `139` | SIGSEGV(세그멘테이션 폴트) | 네이티브 라이브러리, 이미지 아키텍처 불일치 |
| `143` | SIGTERM을 받고 종료 | Liveness 실패, 배포·축출 시점과 겹치는지 |

같은 137이라도 `Reason`이 `OOMKilled`이면 메모리 문제이고, `Error`이면 다른 주체가 SIGKILL을 보낸 것입니다. 숫자와 Reason을 반드시 함께 읽으십시오.

> Exit Code가 `1`인데 로그가 비어 있다면, 애플리케이션이 로그를 남기기도 전에 죽었거나 표준 출력이 아닌 파일로 로그를 쓰고 있는 경우입니다. 다음 절의 종료 메시지 설정이 이 공백을 메워 줍니다.

## 4. 로그가 비어 있을 때 — --previous와 종료 메시지

CrashLoopBackOff 진단에서 가장 흔한 실수는 `--previous` 없이 로그를 보는 것입니다. 현재 로그는 백오프가 끝나고 새로 뜬 컨테이너의 것이라, 재시작 직후에는 기동 배너 몇 줄만 있거나 아예 비어 있습니다. 원인이 담긴 것은 **직전에 죽은 컨테이너의 로그**입니다.

`--previous`로도 아무것도 나오지 않는다면 세 가지를 확인합니다.

- **로그를 파일로만 쓰는 애플리케이션** — 표준 출력(stdout/stderr)으로 내보내도록 로깅 설정을 바꾸십시오
- **기동 스크립트가 출력을 삼키는 경우** — `exec` 없이 래퍼 스크립트에서 실행하거나 `> /dev/null`로 리다이렉트하고 있지 않은지 확인합니다
- **로그를 쓰기 전에 죽는 경우** — 라이브러리 로딩 실패, 실행 파일 누락은 애플리케이션 로그가 아니라 `describe`의 메시지에 남습니다

종료 원인을 확실히 남기려면 **종료 메시지(termination message)** 를 활용합니다. 컨테이너는 `/dev/termination-log`에 쓴 내용을 `describe`의 `Last State` 아래 `Message`로 노출합니다(최대 4096바이트). 애플리케이션을 고치기 어렵다면 정책을 바꿔 로그 마지막 부분을 대신 쓰게 할 수 있습니다.

```yaml
containers:
  - name: api
    image: registry.example.com/api:1.8.3
    terminationMessagePolicy: FallbackToLogsOnError   # 실패 종료 시 로그 마지막 부분을 메시지로 사용
```

## 5. 설정·Secret·의존성 오류 — 가장 흔한 Exit 1

Exit Code 1의 상당수는 코드 버그가 아니라 **환경과의 불일치**입니다. 로컬에서는 잘 뜨던 이미지가 클러스터에서만 죽는다면 아래를 순서대로 확인하십시오.

- **필수 환경변수 누락·오타** — 애플리케이션이 시작 시 설정을 검증하다 종료합니다. 로그에 "required", "missing", "not set" 같은 단어가 보입니다
- **ConfigMap·Secret 값 자체의 오류** — 키는 있는데 값이 틀린 경우(잘못된 JDBC URL, 줄바꿈이 섞인 토큰)입니다
- **의존 서비스 연결 실패** — DB·Kafka·외부 API에 연결하지 못하면 즉시 종료하도록(fail-fast) 만들어진 애플리케이션이 많습니다. DNS 이름, 포트, NetworkPolicy를 확인합니다
- **마이그레이션 경합** — 모든 레플리카가 기동 시 DB 마이그레이션을 동시에 돌리다 잠금 대기나 충돌로 종료합니다. 마이그레이션은 Job이나 init 컨테이너로 분리하십시오
- **이미지 태그 착오** — `latest`나 덮어쓴 태그가 예상과 다른 빌드를 가리킵니다. `describe`의 `Image ID` 다이제스트로 실제 이미지를 확인합니다

> 환경변수로 참조한 ConfigMap이나 Secret, 또는 그 안의 키가 **아예 존재하지 않으면** 컨테이너는 시작조차 하지 않고 `CreateContainerConfigError` 상태가 됩니다(볼륨으로 마운트한 경우는 `ContainerCreating`에서 `FailedMount` 이벤트와 함께 멈춥니다). CrashLoopBackOff가 아니라는 점이 오히려 단서입니다. 이 경우 재시작 횟수는 늘지 않고, `describe`의 Events에 없는 리소스 이름이 그대로 찍힙니다.

의존 서비스가 잠깐 늦게 뜨는 것만으로 CrashLoopBackOff가 반복된다면, 애플리케이션에 **연결 재시도와 대기 시간**을 넣는 것이 근본 해결입니다. 재시작 루프에 기대어 "언젠가는 붙겠지"로 버티면, 백오프가 5분까지 늘어나 복구가 오히려 늦어집니다.

## 6. Exit 0이 반복될 때 — 워크로드 종류를 잘못 고른 경우

Exit Code 0, Reason `Completed`인데 CrashLoopBackOff가 뜨는 경우가 있습니다. 프로세스는 할 일을 마치고 정상 종료했는데, Deployment의 `restartPolicy: Always`가 계속 다시 띄우기 때문입니다.

| 상황 | 맞는 워크로드 | restartPolicy |
| --- | --- | --- |
| 계속 떠 있어야 하는 서버 | Deployment·StatefulSet | `Always`(유일한 허용값) |
| 한 번 실행하고 끝나는 배치 | Job | `OnFailure` 또는 `Never` |
| 주기적으로 실행되는 배치 | CronJob | `OnFailure` 또는 `Never` |

또 하나의 흔한 원인은 **프로세스를 백그라운드로 띄우는 엔트리포인트**입니다. `nginx`를 데몬 모드로 실행하거나, 셸 스크립트 끝에서 서버를 `&`로 띄우고 스크립트가 끝나면, 컨테이너의 메인 프로세스(PID 1)가 종료된 것으로 간주돼 컨테이너도 끝납니다. 메인 프로세스는 반드시 **포그라운드**로 실행하고, 래퍼 스크립트의 마지막 줄은 `exec`로 넘기십시오.

```bash
#!/bin/sh
set -e
/app/bin/check-config
exec java -jar /app/app.jar   # exec로 PID 1을 넘겨야 SIGTERM도 애플리케이션에 전달된다
```

## 7. Liveness Probe 악순환 — 정상 기동을 죽이는 설정

Liveness Probe가 실패하면 kubelet은 컨테이너를 재시작합니다. 기동에 40초가 걸리는 애플리케이션에 Liveness가 10초 뒤부터 검사를 시작하면, **멀쩡히 올라오던 컨테이너가 매번 기동 도중에 죽습니다.** Events에 `Liveness probe failed`와 `Container api failed liveness probe, will be restarted`가 반복되고, 종료 코드는 대개 143이나 137입니다.

```yaml
startupProbe:                 # 기동이 끝날 때까지 liveness를 보류
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  periodSeconds: 5
  failureThreshold: 30        # 최대 150초까지 기동을 기다림
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  periodSeconds: 10
  failureThreshold: 3
```

핵심은 두 가지입니다. 기동이 느리면 **Startup Probe로 Liveness 시작을 늦추고**, DB 연결 같은 **외부 의존성 검사는 Liveness가 아니라 Readiness에** 넣는 것입니다. 외부 장애를 Liveness에 섞으면 DB가 잠깐 흔들릴 때 전체 Pod가 재시작 루프에 빠집니다. Probe 세 종류의 역할 분리와 수치 설계는 Probe 전용 글에서 자세히 다뤘습니다.

## 8. OOMKilled(137) — 한도를 올리기 전에 볼 것

`Last State`가 `Reason: OOMKilled`, `Exit Code: 137`이면 컨테이너가 메모리 limit을 넘어 커널이 강제 종료한 것입니다. 로그에는 아무 흔적이 없는 것이 특징입니다. 애플리케이션이 예외를 던진 게 아니라 SIGKILL로 즉시 죽었기 때문입니다.

limit을 바로 두 배로 올리는 것은 가장 흔하고 가장 위험한 대응입니다. 먼저 다음을 확인하십시오.

- **종료 직전 실제 사용량** — `kubectl top pod` 추이나 모니터링의 working set 그래프에서 기동 직후 급증인지, 시간이 지나며 쌓이는 누수인지 구분합니다
- **런타임의 힙 설정과 limit의 관계** — JVM이라면 힙 외에도 Metaspace, 스레드 스택, Direct Buffer가 메모리를 씁니다. 힙을 limit에 꽉 맞추면 나머지가 들어갈 자리가 없습니다
- **노드 메모리 압박** — 컨테이너 limit 초과가 아니라 노드 전체가 부족해 축출(Eviction)된 경우는 Pod 상태가 `Evicted`로 남습니다. 대응 방법이 다릅니다

OOMKilled의 원인별 점검 순서와 JVM·cgroup v2 관련 세부 사항은 OOMKilled 전용 글에 정리해 두었습니다.

## 9. kubectl debug — 셸이 없는 이미지 들여다보기

로그와 이벤트만으로 원인을 못 찾으면 컨테이너 안을 직접 봐야 합니다. 그런데 CrashLoopBackOff 상태의 컨테이너는 금방 죽어서 `kubectl exec`로 들어갈 틈이 없고, distroless 이미지는 셸조차 없습니다. 이때 쓰는 것이 `kubectl debug`입니다.

```bash
# (1) 실행 중인 Pod에 디버깅용 임시 컨테이너를 붙여 같은 프로세스 공간을 본다
kubectl debug -it api-7d9c6b5f4d-x2kqp -n app --image=busybox:1.28 --target=api

# (2) 죽는 컨테이너의 명령을 셸로 바꾼 "복사본 Pod"를 만들어 안에서 직접 실행해 본다
kubectl debug api-7d9c6b5f4d-x2kqp -n app -it --copy-to=api-debug --container=api -- sh

# (3) 다 봤으면 복사본은 지운다
kubectl delete pod api-debug -n app
```

두 번째 방법이 CrashLoopBackOff에 특히 유용합니다. 원래 명령 대신 `sh`로 기동하므로 컨테이너가 죽지 않고, 그 안에서 환경변수(`env`), 마운트된 설정 파일, 엔트리포인트를 직접 실행해 보며 어디서 실패하는지 확인할 수 있습니다.

> 임시 컨테이너(ephemeral container)는 한 번 추가하면 Pod에서 제거할 수 없고, `--target`은 컨테이너 런타임이 프로세스 네임스페이스 공유를 지원해야 동작합니다. 운영 클러스터에서는 RBAC로 `pods/ephemeralcontainers` 권한을 통제하고, 작업 내역이 감사 로그에 남는지 확인한 뒤 사용하십시오.

## 10. 흔한 실수

- **`STATUS`만 보고 원인을 단정한다** — `STATUS`는 시점마다 바뀌는 표시일 뿐입니다. 원인은 `Last State`의 Reason과 Exit Code에 있습니다.
- **`--previous` 없이 로그를 본다** — 새로 뜬 컨테이너의 빈 로그를 보고 "로그가 없다"고 결론 내립니다.
- **재시작 루프를 리소스 증설로 덮는다** — 원인이 설정 오류인데 CPU·메모리만 올리면 비용만 늘고 루프는 그대로입니다.
- **Pod를 지웠다 다시 만들기만 반복한다** — 새 Pod도 같은 이미지·같은 설정으로 뜨므로 같은 방식으로 죽습니다. 지우는 순간 직전 종료 증거도 사라집니다.
- **Liveness에 외부 의존성을 넣는다** — DB 장애 한 번이 전체 서비스의 재시작 루프로 번집니다.
- **배치 작업을 Deployment로 띄운다** — 정상 종료(Exit 0)가 CrashLoopBackOff로 보입니다. Job이나 CronJob을 쓰십시오.
- **`CreateContainerConfigError`를 같은 문제로 취급한다** — 참조 리소스가 없어 시작조차 못 한 상태라 로그를 아무리 봐도 나오지 않습니다. Events의 리소스 이름을 확인하십시오.
- **백오프 상한을 줄이는 것으로 문제를 해결했다고 생각한다** — 재시작이 빨라질 뿐 원인은 그대로입니다.

## 실전 체크리스트

- `kubectl describe pod`로 `Last State`의 `Reason`·`Exit Code`·`Started`·`Finished`를 확인했다.
- `kubectl logs --previous`(다중 컨테이너면 `-c` 포함)로 직전 종료 로그를 확인했다.
- Exit Code와 Reason을 함께 읽어 원인 범주를 정했다.
- Events에서 `BackOff` 외에 Probe 실패, OOM, 이미지·마운트 오류 메시지가 있는지 확인했다.
- 로그가 비는 경우 `terminationMessagePolicy: FallbackToLogsOnError`를 설정했다.
- 필수 환경변수·ConfigMap·Secret 값이 실제 매니페스트와 일치하는지 확인했다.
- 의존 서비스 연결 실패 시 재시도하도록 애플리케이션을 보완했다.
- 배치 작업을 Job·CronJob으로 옮기고, 서버 프로세스는 포그라운드(`exec`)로 실행했다.
- 기동이 느린 서비스에 Startup Probe를 두고, 외부 의존성 검사는 Readiness로 옮겼다.
- OOMKilled라면 limit을 올리기 전에 실제 사용 패턴과 런타임 힙 설정을 확인했다.
- 필요할 때 `kubectl debug --copy-to`로 복사본 Pod를 띄워 안에서 직접 재현했다.
- 재시작 횟수와 종료 Reason에 대한 알림을 구성했다.

## 마치며

CrashLoopBackOff는 장애의 원인이 아니라 **kubelet이 "이 컨테이너는 계속 죽는다"고 적어 둔 기록**입니다. 그래서 상태 이름을 아무리 검색해도 답이 나오지 않고, 답은 언제나 직전 종료의 Reason과 Exit Code, 그리고 `--previous` 로그에 있습니다. 재시작 버튼을 누르기 전에 그 세 가지 증거부터 확보하는 습관이 복구 시간을 가장 크게 줄입니다.

## FAQ

**Q1. CrashLoopBackOff 상태에서 재시작 대기 시간을 강제로 초기화할 수 있습니까?**
대기 시간은 컨테이너 단위로 관리되므로, 원인을 고친 새 버전으로 롤아웃하면 새 Pod는 백오프 없이 시작합니다. 같은 설정으로 다시 확인만 하려면 `kubectl rollout restart deployment/<이름>`으로 Pod를 새로 만들 수 있습니다. 다만 원인을 고치지 않았다면 새 Pod도 곧 같은 루프에 들어갑니다.

**Q2. `RESTARTS`가 계속 늘다가 어느 순간 멈췄는데 해결된 것입니까?**
컨테이너가 10분 이상 정상 실행되면 백오프가 초기화되므로, 재시작이 멈췄다면 적어도 지금은 살아 있다는 뜻입니다. 하지만 메모리 누수처럼 시간이 지나 다시 죽는 유형도 있으니, 재시작 시각 간격과 `Last State`를 한동안 지켜보십시오.

**Q3. 로그에는 아무 에러가 없는데 Exit Code가 137입니다.**
`Reason`이 `OOMKilled`라면 메모리 한도 초과입니다. 커널이 SIGKILL로 즉시 종료하므로 애플리케이션이 로그를 남길 기회가 없습니다. `Reason`이 `Error`라면 Liveness 실패 후 유예 시간(`terminationGracePeriodSeconds`) 안에 종료하지 못해 SIGKILL을 받은 경우가 흔합니다. Events에서 Probe 실패 기록을 확인하십시오.

**Q4. init 컨테이너에서 같은 문제가 나면 어떻게 보입니까?**
`STATUS`가 `Init:CrashLoopBackOff`로 표시되고 앱 컨테이너는 시작조차 하지 않습니다. 진단 방법은 같으며, 로그를 볼 때 `-c`로 init 컨테이너 이름을 지정하고 `--previous`를 붙이면 됩니다.

## 참고 공식 문서

- Kubernetes 공식 문서 — Pod Lifecycle (Container restarts, CrashLoopBackOff, 재시작 백오프)
- Kubernetes 공식 문서 — Debug Running Pods (`kubectl debug`, 임시 컨테이너, `--copy-to`)
- Kubernetes 공식 문서 — Determine the Reason for Pod Failure (종료 메시지, `terminationMessagePolicy`)
- Kubernetes 공식 문서 — Configure Liveness, Readiness and Startup Probes

## 함께 읽으면 좋은 글

- [Kubernetes OOMKilled 해결 가이드 — Exit 137·limits·JVM Heap·cgroup v2 원인별 점검](https://hadesyi.tistory.com/406)
- [Kubernetes Probe 완전정리 — Liveness·Readiness·Startup 설계와 흔한 오설정](https://hadesyi.tistory.com/415)
- [Kubernetes ImagePullBackOff 해결 가이드 — 이미지·인증·네트워크 원인별 점검](https://hadesyi.tistory.com/399)
- [Kubernetes Pod Pending 해결 가이드 — 리소스·Taint·Affinity·PVC 원인별 점검](https://hadesyi.tistory.com/401)

태그(9개): CrashLoopBackOff, DevOps, ExitCode, kubectl, Kubernetes, livenessProbe, OOMKilled, 쿠버네티스, 트러블슈팅
