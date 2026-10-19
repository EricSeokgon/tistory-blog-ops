# Kubernetes Pod Evicted 해결 가이드 — DiskPressure·MemoryPressure·ephemeral-storage 원인별 점검

아침에 `kubectl get pods`를 쳤더니 `Evicted` 상태의 Pod가 수십 개 쌓여 있는 상황. Deployment는 새 Pod를 띄워 서비스는 돌아가고 있지만, 목록은 지저분하고 어떤 노드에서 무슨 일이 있었는지는 아무도 모릅니다. OOMKilled가 **컨테이너 하나가 자기 한도를 넘겨 커널에게 죽은 사건**이라면, Evicted는 **노드 전체가 자원 압박에 빠져 kubelet이 Pod를 골라 내보낸 사건**입니다. 범인은 그 Pod가 아닐 수도 있습니다. 이 글은 Evicted의 판정 구조와 원인별 점검 순서를 정리합니다.

## 핵심 요약

- Evicted는 애플리케이션 오류가 아니라 **kubelet이 노드 자원(메모리·디스크·inode·PID)을 지키려고 Pod를 `Failed`로 만든 결과**입니다.
- 첫 명령은 트러블슈팅 시리즈의 공통 앵커와 같습니다. `kubectl describe pod`로 **`Message`에 적힌 부족 자원 이름**부터 확인하십시오.
- 실무에서 가장 흔한 원인은 메모리가 아니라 **디스크(`nodefs`·`imagefs`)와 컨테이너 로그·`emptyDir`** 입니다.
- kubelet은 QoS 클래스가 아니라 **"요청량(requests) 초과 여부 → Priority → 요청 대비 사용량"** 순서로 내보낼 Pod를 고릅니다. requests를 정직하게 잡는 것이 최선의 방어입니다.
- 노드 압박 퇴출은 **PodDisruptionBudget과 `terminationGracePeriodSeconds`를 무시**합니다. 하드 임계치에서는 유예 시간 없이 즉시 종료됩니다.

## 1. Evicted란 무엇인가 — OOMKilled와 다른 판정

Kubernetes에서 "Eviction"이라는 단어는 두 가지 전혀 다른 경로를 가리킵니다.

| 구분 | 노드 압박 퇴출 (Node-pressure Eviction) | API 기반 퇴출 (API-initiated Eviction) |
| --- | --- | --- |
| 주체 | 각 노드의 kubelet | Eviction API 호출자 (`kubectl drain`, 오토스케일러 등) |
| 계기 | 메모리·디스크·inode·PID가 임계치 도달 | 운영자·컨트롤러의 의도적 요청 |
| PDB 존중 | **존중하지 않음** | 존중함 |
| 유예 시간 | 하드 임계치는 0초, 소프트는 설정값 | `terminationGracePeriodSeconds` |
| Pod 상태 | `Failed` / `Reason: Evicted` | 정상 종료 후 삭제 |

이 글이 다루는 것은 왼쪽, 즉 kubelet이 내리는 판정입니다. `kubectl get pods`에 `Evicted`가 남아 있다면 거의 항상 이쪽입니다.

OOMKilled와의 차이도 분명히 해 둡니다.

- **OOMKilled** — 컨테이너가 자기 `limits.memory`를 넘었거나 노드 메모리가 바닥나 **커널 OOM Killer가 SIGKILL**을 보냈습니다. `restartPolicy`에 따라 **같은 Pod 안에서 컨테이너가 재시작**됩니다.
- **Evicted** — kubelet이 노드를 지키려고 **Pod 자체를 `Failed`로 종료**했습니다. 재시작이 아니라 **컨트롤러가 다른 Pod를 새로 만듭니다.** 그래서 Evicted Pod는 지워지지 않고 목록에 남습니다.

> kubelet의 퇴출은 커널 OOM Killer보다 **먼저** 움직이도록 설계되어 있습니다. Evicted가 보인다는 것은 kubelet이 제때 개입했다는 뜻이고, OOMKilled가 보인다는 것은 kubelet이 개입하기 전에 메모리가 바닥났다는 뜻입니다.

## 2. 첫 확인 — kubectl describe pod의 Message 읽기

시리즈의 다른 글과 마찬가지로 출발점은 같습니다.

```bash
kubectl describe pod <pod-name> -n <namespace>
```

Evicted Pod에서는 `Status`, `Reason`, `Message` 세 줄이 핵심입니다.

```text
Status:   Failed
Reason:   Evicted
Message:  The node was low on resource: ephemeral-storage. Threshold quantity: 10Gi, available: 8Gi.
          Container app was using 14Gi, request is 0, has larger consumption of ephemeral-storage.
```

`Message`에서 읽을 것은 세 가지입니다.

1. **부족 자원 이름** — `memory`, `ephemeral-storage`, `inodes`, `pids` 중 무엇인가
2. **임계치와 남은 양** — 노드가 어느 선에서 압박을 판정했는가
3. **사용량과 request** — 이 Pod가 request 대비 얼마나 많이 쓰고 있었는가 (`request is 0`이면 requests 미설정)

메시지가 아래처럼 다르게 찍힌다면 노드 압박이 아니라 **Pod 자체의 한도 초과**입니다. 이 경우는 7번에서 따로 다룹니다.

```text
Message:  Pod ephemeral local storage usage exceeds the total limit of containers 2Gi.
Message:  Usage of EmptyDir volume "cache" exceeds the limit "1Gi".
```

여러 Pod가 한꺼번에 퇴출됐다면 하나씩 describe하기보다 한 번에 모아 봅니다.

```bash
kubectl get pods -A --field-selector=status.phase=Failed \
  -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,NODE:.spec.nodeName,REASON:.status.reason,MSG:.status.message' \
  | grep Evicted
```

`NODE` 열이 특정 노드에 몰려 있으면 문제는 Pod가 아니라 **그 노드**입니다.

## 3. 노드 상태 확인 — Pressure 컨디션과 Taint

퇴출이 일어난 노드를 바로 확인합니다.

```bash
kubectl describe node <node-name>
```

`Conditions` 섹션에서 세 가지 압박 컨디션을 봅니다.

| 노드 컨디션 | 연결된 퇴출 신호 | 의미 |
| --- | --- | --- |
| `MemoryPressure` | `memory.available` | 노드 가용 메모리가 임계치에 도달 |
| `DiskPressure` | `nodefs.*`, `imagefs.*`, `containerfs.*` | 루트·이미지·컨테이너 파일시스템의 공간 또는 inode가 임계치에 도달 |
| `PIDPressure` | `pid.available` | 노드의 프로세스 ID가 임계치 아래로 감소 |

컨디션이 `True`가 되면 컨트롤 플레인은 같은 이름의 Taint를 붙입니다(`node.kubernetes.io/disk-pressure:NoSchedule` 등). 그래서 압박 상태인 노드에는 **새 Pod가 스케줄되지 않고**, 그 사이 대기 중인 Pod는 Pending으로 남을 수 있습니다. Pending 쪽 증상은 앞선 Pod Pending 글의 점검 순서와 겹칩니다.

`Events`에도 단서가 남습니다.

```bash
kubectl get events -A --field-selector reason=Evicted --sort-by=.lastTimestamp
kubectl get events -A --field-selector involvedObject.kind=Node --sort-by=.lastTimestamp | tail -20
```

`EvictionThresholdMet`, `FreeDiskSpaceFailed`, `ImageGCFailed` 같은 이벤트가 보이면 kubelet이 디스크를 확보하려다 실패한 흔적입니다.

## 4. kubelet은 언제 퇴출을 시작하나 — 퇴출 신호와 기본 임계치

kubelet은 기본 10초 주기(`housekeeping-interval`)로 노드 자원을 측정해 아래 신호를 임계치와 비교합니다.

| 신호 | 측정 대상 | Linux 기본 하드 임계치 |
| --- | --- | --- |
| `memory.available` | 노드 가용 메모리 | `<100Mi` |
| `nodefs.available` | kubelet 루트 파일시스템 (로그·`emptyDir` 등) | `<10%` |
| `nodefs.inodesFree` | 루트 파일시스템 inode | `<5%` |
| `imagefs.available` | 이미지(및 쓰기 레이어) 파일시스템 | `<15%` |
| `imagefs.inodesFree` | 이미지 파일시스템 inode | `<5%` |
| `pid.available` | 노드 PID | (기본값 없음) |

`containerfs.*` 신호는 이미지와 컨테이너 쓰기 레이어를 분리 구성한 노드에서만 의미가 있고, 임계치는 같은 물리 파일시스템을 쓰는 `nodefs` 또는 `imagefs` 값을 자동으로 따라갑니다.

> **기본값을 하나라도 직접 지정하면 나머지 기본값이 0으로 바뀝니다.** `evictionHard`에 `memory.available`만 적으면 디스크 임계치가 사라져 디스크가 끝까지 차오를 수 있습니다. 덮어쓸 때는 항상 전체 세트를 함께 적으십시오. 최신 kubelet은 `mergeDefaultEvictionSettings: true`로 나머지 기본값을 상속받게 할 수도 있으니, 사용 중인 버전의 문서를 확인하십시오.

임계치는 두 종류입니다.

- **하드 임계치(`evictionHard`)** — 도달 즉시 퇴출합니다. 유예 시간이 **0초**라 애플리케이션의 graceful shutdown이 실행되지 않습니다.
- **소프트 임계치(`evictionSoft`)** — `evictionSoftGracePeriod`만큼 상태가 지속돼야 퇴출합니다. 이때 Pod 종료 유예는 `evictionMaxPodGracePeriod`와 Pod 설정값 중 작은 쪽입니다.

```yaml
# KubeletConfiguration 예시 — 소프트로 먼저 정리하고 하드는 최후의 선으로
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
  imagefs.available: "20%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "2m"
  imagefs.available: "2m"
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  imagefs.inodesFree: "5%"
evictionMaxPodGracePeriod: 60
evictionMinimumReclaim:
  nodefs.available: "1Gi"
  imagefs.available: "2Gi"
```

`evictionMinimumReclaim`은 임계치를 겨우 넘기는 수준에서 멈추지 않고 **지정한 양만큼 더 확보**하게 합니다. 기본값은 0이라, 큰 로그 파일 하나가 계속 자라는 노드에서는 퇴출이 연달아 반복될 수 있습니다.

## 5. 누가 먼저 나가나 — 퇴출 대상 선정 순서

"BestEffort부터 죽는다"는 설명이 흔하지만 정확하지 않습니다. 공식 문서 기준으로 kubelet은 **QoS 클래스 자체를 정렬 기준으로 쓰지 않습니다.** 기준은 세 가지입니다.

1. 해당 자원의 사용량이 **requests를 넘었는가**
2. **Pod Priority**
3. **requests 대비 사용량**이 얼마나 큰가

그 결과 실제 순서는 다음과 같습니다.

```text
퇴출 우선순위
├─ 1순위: 사용량 > requests 인 Pod (BestEffort, 초과한 Burstable)
│         └─ 이 안에서 Priority 낮은 순 → 초과량 큰 순
└─ 2순위: 사용량 ≤ requests 인 Pod (Guaranteed, 범위 안의 Burstable)
          └─ Priority 낮은 순 (시스템 데몬이 reserved를 넘겼을 때만 해당)
```

BestEffort는 requests가 0이므로 무엇을 쓰든 "requests 초과"에 걸려 결과적으로 앞쪽에 서게 됩니다. QoS가 순서를 대략 예측해 주는 이유가 이것입니다. 다만 두 가지 예외를 기억해야 합니다.

- **디스크 압박에는 QoS 추정이 통하지 않습니다.** QoS는 CPU·메모리로만 계산되고 `ephemeral-storage` requests와 무관합니다. Guaranteed Pod라도 ephemeral-storage requests가 없으면 디스크 압박 때 1순위가 될 수 있습니다.
- **inode·PID 압박은 Priority만 봅니다.** 이 자원에는 requests 개념이 없기 때문입니다.

정렬에 쓰이는 사용량도 압박 종류에 따라 다릅니다. 파일시스템을 하나만 쓰는 노드에서 `nodefs` 압박이 오면 **로컬 볼륨 + 로그 + 컨테이너 쓰기 레이어의 합**으로 정렬하고, `imagefs`를 분리한 노드에서 `imagefs` 압박이 오면 쓰기 레이어 사용량으로 정렬합니다.

## 6. DiskPressure — 가장 흔한 원인과 점검 순서

현장에서 Evicted를 가장 많이 만드는 것은 디스크입니다. kubelet은 Pod를 내보내기 전에 노드 수준 자원부터 회수합니다. 파일시스템이 하나인 노드라면 **죽은 Pod·컨테이너 정리 → 사용하지 않는 이미지 삭제** 순서이고, 그래도 임계치 아래로 내려가지 않을 때 비로소 Pod를 퇴출합니다. 즉 Evicted가 났다면 **이미지 GC로도 공간이 확보되지 않았다**는 뜻입니다.

노드에 접속할 수 있다면 다음 순서로 범인을 좁힙니다.

```bash
# 1) 어느 파일시스템이 찼는가
df -h /var/lib/kubelet /var/lib/containerd /var/log
df -i /var/lib/kubelet          # inode 고갈도 함께 확인

# 2) 큰 디렉터리 찾기
sudo du -xh --max-depth=2 /var/lib/kubelet/pods 2>/dev/null | sort -rh | head -15
sudo du -xh --max-depth=1 /var/log/pods 2>/dev/null | sort -rh | head -15

# 3) 런타임 이미지·컨테이너 현황
sudo crictl images | sort -k4 -h | tail -10
sudo crictl stats --output table | sort -k4 -h | tail -10
```

노드 접속 없이 Pod 단위 사용량을 보려면 kubelet Summary API를 씁니다.

```bash
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/stats/summary" \
  | jq -r '.pods[] | [.podRef.namespace, .podRef.name, (."ephemeral-storage".usedBytes // 0)] | @tsv' \
  | sort -t$'\t' -k3 -n | tail -10
```

원인은 대부분 아래 넷 중 하나입니다.

- **컨테이너 로그 폭주** — 디버그 로그를 켠 채 배포했거나 예외 루프가 stdout을 채웁니다. kubelet의 `containerLogMaxSize`(기본 10Mi)·`containerLogMaxFiles`(기본 5)로 회전되지만, 노드에 Pod가 많으면 합계가 커집니다.
- **`emptyDir`에 쌓이는 임시 파일** — 업로드 버퍼, 빌드 캐시, 모델 파일 다운로드 경로가 `emptyDir`로 잡혀 있고 정리 로직이 없습니다.
- **컨테이너 쓰기 레이어 사용** — 볼륨을 마운트하지 않은 경로(`/tmp`, 애플리케이션 작업 디렉터리)에 파일을 씁니다.
- **이미지 누적** — 대형 이미지(ML 런타임, CUDA 베이스)를 자주 교체하는 노드에서 디스크 여유가 부족합니다.

> 로그 문제라면 애플리케이션을 고치기 전에 **로그 레벨과 샘플링**부터 조정하십시오. 퇴출은 증상이고, 노드 디스크를 채운 쓰기 패턴이 원인입니다.

## 7. ephemeral-storage 한도 초과 — 노드가 멀쩡해도 퇴출되는 경우

노드 디스크에 여유가 있는데도 특정 Pod만 반복해서 Evicted된다면 **Pod 자신의 ephemeral-storage 한도**를 넘긴 경우입니다. kubelet은 다음 두 수준에서 사용량을 감시합니다.

- **컨테이너 수준** — 컨테이너의 쓰기 레이어 + 로그가 그 컨테이너의 `limits.ephemeral-storage`를 넘으면 Pod를 퇴출 대상으로 표시합니다.
- **Pod 수준** — 모든 컨테이너의 사용량에 `emptyDir` 사용량을 더한 값이 컨테이너 limits 합계를 넘으면 퇴출합니다.
- **`emptyDir.sizeLimit`** — 볼륨 하나가 자기 `sizeLimit`을 넘으면 그 Pod를 퇴출합니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: worker
spec:
  containers:
    - name: app
      image: registry.example.com/worker:1.8.2
      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
          ephemeral-storage: "2Gi"   # 스케줄링 기준 + 디스크 압박 시 정렬 기준
        limits:
          memory: "1Gi"
          ephemeral-storage: "4Gi"   # 넘으면 노드 상태와 무관하게 퇴출
      volumeMounts:
        - name: scratch
          mountPath: /work/tmp
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 3Gi
```

여기서 `requests.ephemeral-storage`를 함께 적는 것이 중요합니다. 5번에서 본 것처럼 디스크 압박 때 정렬 기준이 **requests 대비 사용량**이기 때문입니다. requests를 비워 두면 그 Pod는 디스크를 조금만 써도 "requests 초과"로 분류됩니다.

> 메모리 기반 `emptyDir`(`medium: Memory`)은 디스크가 아니라 **컨테이너 메모리 사용량으로 계산**됩니다. 여기에 파일을 많이 쓰면 Evicted가 아니라 OOMKilled로 나타날 수 있습니다.

## 8. MemoryPressure — 노드 메모리 압박과 system-reserved

메모리 압박에 의한 퇴출은 대개 **노드 할당 가능량(Allocatable) 계산이 실제와 어긋날 때** 생깁니다. 노드 메모리가 아래처럼 나뉘기 때문입니다.

```text
Node Capacity
├─ kube-reserved       (kubelet, 컨테이너 런타임)
├─ system-reserved     (OS, sshd, journald 등)
├─ eviction-hard       (퇴출 임계치 여유분)
└─ Allocatable         ← 스케줄러가 Pod requests를 채워 넣는 공간
```

Pod들이 requests 범위 안에서 움직여도, **시스템 데몬이 reserved보다 많이 쓰거나 Pod들이 requests를 크게 넘겨 쓰면** `memory.available`이 임계치 아래로 떨어집니다. 확인할 지점은 다음과 같습니다.

```bash
# 노드의 Capacity와 Allocatable 비교
kubectl get node <node-name> -o jsonpath='{.status.capacity.memory}{" / "}{.status.allocatable.memory}{"\n"}'

# 노드에 배치된 Pod들의 requests 합과 실제 사용량 비교
kubectl describe node <node-name> | sed -n '/Allocated resources/,/Events/p'
kubectl top pods -A --sort-by=memory | head -15
```

`kubectl top`의 실제 사용량이 `Allocated resources`의 requests 합보다 크게 높다면, **requests를 낮게 잡고 limits만 넉넉히 준 Burstable Pod들**이 노드를 압박하고 있는 것입니다. 이 패턴은 평소에는 문제가 없다가 트래픽이 몰리는 시간에 한꺼번에 퇴출을 일으킵니다.

## 9. 재발 방지 설계 — requests·Priority·노드 설정

원인을 찾았다면 다음 순서로 재발을 막습니다.

1. **requests를 실측 기반으로 잡기** — 메모리와 `ephemeral-storage` 모두 p95 사용량 근처로 설정합니다. VPA의 추천값(recommendation 모드)을 참고하면 근거가 생깁니다.
2. **중요 워크로드에 PriorityClass 부여** — 같은 조건이면 Priority가 낮은 Pod가 먼저 나갑니다. 단, 모든 Pod에 높은 Priority를 주면 아무 의미가 없습니다.
3. **DaemonSet은 Priority로 보호** — 로그 수집기·노드 에이전트가 퇴출되면 원인 분석 자체가 불가능해집니다.
4. **로그·임시 파일 경로 정리** — 큰 파일은 `emptyDir` 대신 PVC나 오브젝트 스토리지로 보내고, `emptyDir`에는 `sizeLimit`을 겁니다.
5. **노드 디스크 여유 확보** — 이미지가 큰 워크로드 노드풀은 루트 볼륨을 넉넉히 잡고, 필요하면 `imagefs`를 분리합니다.
6. **소프트 임계치 도입** — 하드 임계치만 있으면 graceful shutdown 없이 즉시 종료됩니다. 소프트 임계치로 먼저 정리할 기회를 줍니다.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: business-critical
value: 100000
globalDefault: false
description: "결제·주문 등 퇴출 시 영향이 큰 워크로드"
---
# Deployment의 Pod 템플릿에서 사용
# spec.template.spec.priorityClassName: business-critical
```

마지막으로 남은 Evicted Pod는 정리합니다. kube-controller-manager의 `--terminated-pod-gc-threshold`(기본 12500)에 도달하기 전까지는 자동으로 지워지지 않습니다.

```bash
# 원인 기록을 남긴 뒤 삭제
kubectl get pods -A --field-selector=status.phase=Failed -o wide > evicted-$(date +%F).txt
kubectl delete pods -A --field-selector=status.phase=Failed
```

> `status.phase=Failed`에는 Evicted 외의 실패 Pod(완료된 Job의 실패 등)도 포함됩니다. 지우기 전에 목록을 저장해 두면 나중에 원인 분석에 쓸 수 있습니다.

## 10. 흔한 실수

- **Evicted Pod만 지우고 끝내기** — 목록은 깨끗해지지만 노드 디스크를 채운 원인은 그대로입니다. 다음 날 같은 시간에 다시 쌓입니다.
- **"BestEffort부터 나간다"고만 이해하기** — 실제 기준은 requests 초과 여부와 Priority입니다. Guaranteed라도 ephemeral-storage requests가 없으면 디스크 압박에서 앞줄에 섭니다.
- **`evictionHard`를 일부만 덮어쓰기** — 지정하지 않은 기본 임계치가 0이 되어 디스크 보호가 사라집니다.
- **PDB가 지켜줄 거라 기대하기** — 노드 압박 퇴출은 PDB를 무시합니다. PDB는 drain 같은 API 기반 퇴출에만 작동합니다.
- **requests를 낮게, limits를 높게 주는 습관** — 스케줄러는 requests만 보고 노드를 채웁니다. 실제 사용량이 몰리는 순간 MemoryPressure가 옵니다.
- **`emptyDir`을 무제한 스크래치 공간으로 쓰기** — `sizeLimit` 없이 큰 파일을 쓰면 노드 전체가 DiskPressure에 빠지고 다른 Pod까지 퇴출됩니다.
- **노드 컨디션을 확인하지 않고 Pod만 보기** — Evicted가 특정 노드에 몰려 있다면 그 노드의 `DiskPressure`·`MemoryPressure`부터 봐야 합니다.
- **OOMKilled와 같은 대응을 하기** — limits를 올리는 것은 OOMKilled의 처방입니다. Evicted에서 limits만 올리면 노드 압박은 오히려 커집니다.

## 실전 체크리스트

- `kubectl describe pod`로 `Reason: Evicted`와 `Message`의 부족 자원 이름을 확인했다.
- Evicted Pod가 특정 노드에 몰려 있는지 `NODE` 열로 확인했다.
- `kubectl describe node`로 `MemoryPressure`·`DiskPressure`·`PIDPressure` 컨디션을 확인했다.
- 메시지가 노드 압박인지 Pod 자체의 ephemeral-storage 한도 초과인지 구분했다.
- `df -h`와 `df -i`로 공간과 inode를 모두 확인했다.
- 로그·`emptyDir`·쓰기 레이어·이미지 중 어디가 디스크를 채웠는지 특정했다.
- 메모리와 `ephemeral-storage`의 requests를 실측 기반으로 다시 잡았다.
- `emptyDir`에 `sizeLimit`을 설정했다.
- 중요 워크로드와 DaemonSet에 적절한 PriorityClass를 부여했다.
- `evictionHard`를 덮어쓸 때 전체 임계치 세트를 함께 적었다.
- 하드 임계치 앞에 소프트 임계치를 두는 것을 검토했다.
- Evicted Pod 목록을 저장한 뒤 정리했다.

## 마치며

Evicted는 **Pod가 아니라 노드가 보내는 신호**입니다. 퇴출된 Pod는 피해자일 때가 많고, 진짜 원인은 같은 노드에서 디스크나 메모리를 조용히 채운 다른 무언가입니다. 그래서 대응은 "이 Pod를 어떻게 살릴까"가 아니라 "이 노드에서 무엇이 자원을 먹었나"에서 시작해야 합니다. requests를 정직하게 적는 것만으로도 kubelet이 내리는 판정은 훨씬 예측 가능해집니다.

## FAQ

**Q1. Evicted Pod는 왜 자동으로 지워지지 않나요?**
퇴출된 Pod는 원인 분석을 위해 `Failed` 상태로 남겨 둡니다. kube-controller-manager가 종료된 Pod를 정리하는 기준은 `--terminated-pod-gc-threshold`(기본 12500개)라 작은 클러스터에서는 사실상 남아 있습니다. 주기적으로 정리하려면 CronJob으로 `kubectl delete pods -A --field-selector=status.phase=Failed`를 돌리되, 삭제 전 목록을 로그로 남기십시오.

**Q2. Guaranteed QoS로 만들면 퇴출되지 않나요?**
메모리 압박에서는 사용량이 requests를 넘지 않으므로 거의 마지막 순서가 됩니다. 하지만 시스템 데몬이 reserved를 넘겨 쓰면 Guaranteed Pod도 Priority 낮은 순으로 퇴출될 수 있습니다. 또 디스크 압박에는 QoS가 적용되지 않으므로 `requests.ephemeral-storage`를 별도로 설정해야 합니다.

**Q3. Pod 하나가 디스크를 다 채웠는데 왜 다른 Pod까지 퇴출되나요?**
`requests.ephemeral-storage`가 없는 Pod는 디스크를 조금만 써도 "requests 초과"로 분류되기 때문입니다. 범인 Pod를 먼저 내보내도 확보량이 부족하면 다음 순위 Pod가 이어서 퇴출됩니다. 범인 Pod에 `limits.ephemeral-storage`를 걸면 노드 전체가 압박에 빠지기 전에 그 Pod만 정리됩니다.

**Q4. 퇴출 이력을 어떻게 모니터링하나요?**
`kube-state-metrics`의 `kube_pod_status_reason{reason="Evicted"}`와 `kube_node_status_condition{condition="DiskPressure",status="true"}`를 대시보드와 알림에 걸어 두십시오. 노드의 `node_filesystem_avail_bytes`가 임계치 근처로 내려가는 추세를 함께 보면 퇴출이 일어나기 전에 대응할 수 있습니다.

## 참고 공식 문서

- Kubernetes — Node-pressure Eviction
- Kubernetes — API-initiated Eviction
- Kubernetes — Local ephemeral storage
- Kubernetes — Pod Priority and Preemption

## 함께 읽으면 좋은 글

- [Kubernetes OOMKilled 해결 가이드 — Exit 137·limits·JVM Heap·cgroup v2 원인별 점검](https://hadesyi.tistory.com/406)
- [Kubernetes Pod Pending 해결 가이드 — 리소스·Taint·Affinity·PVC 원인별 점검](https://hadesyi.tistory.com/401)
- [Kubernetes CrashLoopBackOff 해결 가이드 — 로그·이벤트·Probe·OOM 점검](https://hadesyi.tistory.com/393)
- [Kubernetes Probe 완전정리 — Liveness·Readiness·Startup 설계와 흔한 오설정](https://hadesyi.tistory.com/415)

---

**태그(9개):** DiskPressure, EphemeralStorage, Evicted, Kubernetes, kubelet, PriorityClass, 노드압박, 쿠버네티스, 트러블슈팅
