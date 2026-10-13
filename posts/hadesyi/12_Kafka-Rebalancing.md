# Kafka 컨슈머 리밸런싱 완전정리 — 발생 원인·Cooperative Sticky·정적 멤버십·KIP-848 선택 기준

배포가 끝난 직후 5분 동안 주문 처리가 멈추고, 모니터링의 lag 그래프는 톱니처럼 치솟았다 내려오기를 반복합니다. 컨슈머 로그에는 `Attempt to heartbeat failed since group is rebalancing`과 `Revoking previously assigned partitions`가 번갈아 찍혀 있습니다. 처리 코드는 바뀐 게 없는데 그룹이 계속 재편성되고 있는 상황, 이 글은 그 **리밸런싱 자체**를 다룹니다. lag을 읽고 원인을 여섯 갈래로 좁히는 전체 진단은 「[Kafka Consumer Lag 완전정리](https://hadesyi.tistory.com/364)」에서 정리했고, 여기서는 그중 한 갈래인 리밸런싱을 꺼내 **왜 일어나는지, 왜 그룹 전체가 멈추는지, 어떤 순서로 줄여 가는지**만 깊게 봅니다.

## 핵심 요약

- 리밸런싱은 **그룹 멤버 변화·구독 변화·파티션 수 변화**, 이 세 가지 사건에서만 시작됩니다. 톱니형 lag의 범인은 대개 `max.poll.interval.ms` 초과로 생기는 "멤버 이탈"입니다.
- 기본 전략은 여전히 **eager(RangeAssignor)** 입니다. 리밸런싱이 시작되면 모든 컨슈머가 모든 파티션을 반납하므로 **그룹 전체가 멈춥니다.**
- `CooperativeStickyAssignor`로 바꾸면 **실제로 옮겨야 할 파티션만 멈춥니다.** 기본 설정 목록에 이미 들어 있어 **롤링 재시작 한 번**으로 전환할 수 있습니다.
- 배포·재시작마다 일어나는 리밸런싱은 **정적 멤버십(`group.instance.id`)** 으로 없앱니다. 세션 타임아웃 안에 같은 ID로 돌아오면 이전 할당이 그대로 유지됩니다.
- Kafka 4.0에서 정식 제공된 **새 그룹 프로토콜(KIP-848, `group.protocol=consumer`)** 은 할당을 브로커가 맡고 전역 동기화 장벽을 없앴습니다. 하트비트·세션 설정이 **서버 쪽으로 이동**했다는 점을 알고 써야 합니다.

## 1. 리밸런싱이 하는 일 — 파티션 소유권의 재분배

컨슈머 그룹의 규칙은 단순합니다. **한 파티션은 그룹 안에서 정확히 한 컨슈머만 읽습니다.** 리밸런싱은 이 소유권 표를 다시 쓰는 절차입니다. 그룹에 컨슈머가 들어오거나 나가면 표가 더 이상 맞지 않으므로, 그룹 코디네이터(브로커)가 전원을 모아 새 표를 만들고 나눠 줍니다.

문제는 표를 다시 쓰는 동안의 **동작**입니다. 기존 프로토콜에서는 새 표가 완성될 때까지 **아무도 파티션을 읽지 못합니다.** 컨슈머가 50개든 500개든, 한 개가 재시작되면 나머지 전부가 멈춥니다. 이것이 리밸런싱이 "비용"이라고 불리는 이유이고, 이 글의 모든 대응은 결국 **멈추는 범위와 횟수를 줄이는 일**입니다.

```
리밸런싱 1회의 비용
= (멈추는 컨슈머 수) × (멈추는 시간)
   ↑ 전략으로 줄인다           ↑ 타임아웃·멤버십으로 줄인다
```

## 2. 언제 시작되는가 — 세 가지 방아쇠

리밸런싱을 일으키는 사건은 정확히 세 종류입니다. 이 밖의 이유로 리밸런싱이 났다면 그것은 세 가지 중 하나가 **다른 모습으로 나타난 것**입니다.

| 방아쇠 | 실제로 자주 보는 모습 |
| --- | --- |
| **멤버 변화** — 컨슈머 합류·이탈 | 배포, 파드 재시작, 오토스케일링, **`max.poll.interval.ms` 초과로 쫓겨남**, 세션 타임아웃 |
| **구독 변화** — 구독 토픽 목록이 바뀜 | 정규식 구독에 새 토픽이 매칭됨, 롤링 배포 중 신구 버전의 구독이 다름 |
| **파티션 수 변화** | 토픽 파티션 증설 (`metadata.max.age.ms` 주기로 감지, 기본 5분) |

운영 현장에서 압도적으로 많은 것은 첫 번째, 그중에서도 **의도하지 않은 이탈**입니다. 컨슈머가 죽지 않았는데 브로커가 죽었다고 판정하는 경우가 여기에 들어갑니다.

> 리밸런싱 횟수를 세기 전에 **"누가 왜 나갔는가"** 부터 확인하십시오. 로그의 `member ... has left the group` 또는 `removing member ... on heartbeat expiration`, `consumer poll timeout has expired`가 그 답입니다.

## 3. 두 개의 타임아웃 — 죽은 것과 느린 것을 구분한다

컨슈머가 그룹에서 빠지는 경로는 둘입니다. 둘을 섞어 생각하면 엉뚱한 값을 늘리게 됩니다.

| 설정 | 기본값 | 재는 것 | 걸리면 |
| --- | --- | --- | --- |
| `session.timeout.ms` | 45000 | **하트비트**가 끊긴 시간 | 프로세스가 죽었다고 판정 |
| `heartbeat.interval.ms` | 3000 | 하트비트 전송 주기 (세션의 1/3 이하 권장) | — |
| `max.poll.interval.ms` | 300000 | **`poll()` 호출 사이** 간격 | 처리가 멈췄다고 판정, 스스로 그룹 이탈 |

하트비트는 **별도 스레드**가 보냅니다. 그래서 처리 코드가 아무리 오래 걸려도 프로세스만 살아 있으면 `session.timeout.ms`에는 걸리지 않습니다. 처리 지연으로 쫓겨나는 것은 언제나 `max.poll.interval.ms`입니다. 이 값은 컨슈머가 **자기 자신을 감시**하는 값이고, 초과하면 컨슈머가 먼저 `LeaveGroup`을 보냅니다.

```
한 번의 poll()이 가져온 레코드를 다 처리하는 시간
= max.poll.records × 레코드당 처리 시간(P99)
→ 이 값이 max.poll.interval.ms 를 넘으면 리밸런싱
```

> `max.poll.interval.ms`를 늘리는 것은 **장애 감지를 그만큼 늦추는 것**과 같은 말입니다. 500건 처리가 5분을 넘긴다면 먼저 `max.poll.records`를 100으로 줄이십시오. 그래도 모자라면 처리를 별도 스레드 풀로 넘기고 `poll()` 루프는 가볍게 유지하는 쪽이 정답에 가깝습니다.

## 4. 리밸런싱 루프 — 톱니형 lag이 만들어지는 과정

가장 흔한 장애 패턴은 리밸런싱 **한 번**이 아니라 **반복**입니다.

```
처리 시간 > max.poll.interval.ms
   ↓
컨슈머 A가 그룹 이탈 → 리밸런싱 ①
   ↓
A의 파티션이 B·C로 재할당, A는 재합류 → 리밸런싱 ②
   ↓
B·C는 밀린 물량까지 떠안아 처리 시간 증가 → B 이탈 → 리밸런싱 ③
   ↓
   반복
```

리밸런싱 한 번에 그룹이 멈추고, 멈춘 만큼 밀린 물량이 다음 컨슈머의 처리 시간을 늘려 또 쫓겨나게 만듭니다. **lag이 주기적으로 치솟았다 떨어지는 톱니 모양**은 이 루프의 지문입니다. 우상향 직선(처리량 부족)과 구분하는 가장 빠른 기준이고, 그룹 상태가 `Stable`로 돌아오지 못하는 것으로도 확인됩니다.

```bash
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
  --describe --group order-processor --state
# STATE 가 PreparingRebalance / CompletingRebalance 를 오간다면 루프
```

루프를 끊는 순서는 **① `max.poll.records` 축소 → ② 처리 분리 → ③ 그 다음에야 `max.poll.interval.ms` 상향**입니다. 타임아웃부터 늘리면 루프 주기가 길어질 뿐 사라지지 않습니다.

## 5. Eager 프로토콜 — 왜 전원이 멈추는가

기본 전략인 `RangeAssignor`는 **eager** 방식으로 동작합니다. 절차를 보면 왜 그룹 전체가 멈추는지 분명해집니다.

```
1. 코디네이터가 리밸런싱 시작을 알림
2. 모든 컨슈머가 보유 파티션을 전부 반납 (onPartitionsRevoked)
3. 모든 컨슈머가 JoinGroup 요청 → 리더 선출
4. 리더가 할당표 계산 → SyncGroup 으로 배포
5. 각 컨슈머가 새 파티션을 받음 (onPartitionsAssigned)
```

2번에서 5번 사이에 **읽히는 파티션이 하나도 없습니다.** 실제로 소유자가 바뀌는 파티션이 전체의 2%라도 100%가 멈춥니다. "stop-the-world"라고 부르는 이유입니다.

Range 전략에는 또 다른 함정이 있습니다. **토픽별로** 파티션을 나누기 때문에, 토픽 3개를 각각 파티션 4개로 구독하는 컨슈머 6개가 있으면 앞의 4개 컨슈머만 일하고 2개는 유휴 상태가 됩니다. 토픽 수가 많고 파티션 수가 컨슈머 수보다 작은 구성이라면 전략을 바꿀 또 하나의 이유입니다.

## 6. Cooperative Sticky — 옮겨야 할 파티션만 멈춘다

`CooperativeStickyAssignor`는 두 가지를 바꿉니다. **sticky**는 가능한 한 이전 할당을 유지한다는 뜻이고, **cooperative**는 리밸런싱을 두 라운드로 쪼개 **실제로 옮길 파티션만 반납**하게 한다는 뜻입니다.

```
라운드 1: 전원 JoinGroup — 보유 파티션은 그대로 둔 채 할당표 계산
          "옮겨야 할 파티션"만 소유자가 반납 (onPartitionsRevoked)
라운드 2: 반납된 파티션만 새 소유자에게 배정 (onPartitionsAssigned)
```

컨슈머 10개 중 1개가 재시작되면 그 1개가 쥐고 있던 파티션만 잠시 멈추고, 나머지 9개는 **계속 읽습니다.** 리밸런싱 비용 공식에서 "멈추는 컨슈머 수"가 N에서 1 근처로 내려오는 것입니다.

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

**전환 절차가 중요합니다.** eager와 cooperative는 같은 그룹 안에서 공존할 수 없어서, 그룹 전체가 공통으로 지원하는 전략으로 합의해야 합니다.

- Kafka 3.0 이후 기본값은 `[RangeAssignor, CooperativeStickyAssignor]` 두 개가 **나란히** 들어 있습니다. 공식 문서 표현대로 **"RangeAssignor를 목록에서 빼는 롤링 재시작 한 번"** 이면 전환이 끝납니다.
- 기본값을 쓰지 않고 `RangeAssignor` 하나만 명시해 두었다면 두 번 필요합니다. **1차 롤링: 목록에 `CooperativeStickyAssignor`를 추가** → **2차 롤링: `RangeAssignor` 제거.** 한 번에 바꾸면 신구 컨슈머가 공통 전략을 찾지 못해 리밸런싱이 실패합니다.

> 전환 중에 `INCONSISTENT_GROUP_PROTOCOL` 오류로 합류가 실패하면 두 단계를 건너뛴 것입니다. 되돌려서 순서대로 다시 하십시오.

## 7. 정적 멤버십 — 재시작이 리밸런싱을 만들지 않게

배포 때마다 리밸런싱이 나는 것은 컨슈머가 **나갔다가 새 멤버로 다시 들어오기** 때문입니다. 브로커 입장에서는 "하나가 떠나고 모르는 하나가 왔다"이므로 두 번의 리밸런싱이 정당합니다. 정적 멤버십은 이 전제를 바꿉니다.

```properties
group.instance.id=order-processor-3
session.timeout.ms=120000
```

`group.instance.id`가 있는 컨슈머는 **같은 ID로 `session.timeout.ms` 안에 돌아오면 같은 멤버**로 인정됩니다. 브로커는 이전 할당을 그대로 돌려주고 리밸런싱은 일어나지 않습니다. 재시작 시간이 세션 타임아웃보다 짧도록 값을 잡는 것이 핵심이며, 그래서 보통 기본값 45초보다 크게 둡니다.

쿠버네티스에서는 **StatefulSet**과 자연스럽게 맞습니다. `order-processor-0`, `order-processor-1`처럼 파드 이름이 고정되므로 그 이름을 그대로 ID로 쓰면 됩니다.

```yaml
env:
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
# 애플리케이션에서 group.instance.id=${POD_NAME} 으로 주입
```

두 가지는 알고 써야 합니다.

- **ID가 겹치면 뒤에 들어온 쪽이 `FencedInstanceIdException`으로 펜싱됩니다.** Deployment처럼 파드 이름이 매번 바뀌는 워크로드에서 ID를 고정값으로 박으면 바로 이 오류가 납니다.
- 정적 멤버가 **진짜로 죽었을 때**는 세션 타임아웃이 지나야 파티션이 풀립니다. `max.poll.interval.ms`를 넘겨도 즉시 재할당되지 않고 하트비트만 멈추며, 세션 타임아웃 뒤에 재할당됩니다. 장애 감지가 그만큼 늦어지는 대가입니다.

## 8. KIP-848 — 브로커가 할당하는 새 프로토콜

Kafka **4.0에서 정식 제공**된 차세대 컨슈머 그룹 프로토콜입니다. 리밸런싱의 구조 자체를 바꿨습니다.

```properties
group.protocol=consumer
# 기본값은 classic — 명시해야 켜집니다
```

| 항목 | classic | consumer (KIP-848) |
| --- | --- | --- |
| 할당 계산 | 그룹 리더(클라이언트) | **브로커** |
| 동기화 | JoinGroup/SyncGroup 전역 장벽 | **하트비트에 실려 오는 증분 할당** |
| 하트비트·세션 설정 | 클라이언트 `session.timeout.ms` 등 | **브로커** `group.consumer.session.timeout.ms`(45000) · `group.consumer.heartbeat.interval.ms`(5000) |
| 할당 전략 | `partition.assignment.strategy` | 서버 측 `group.consumer.assignors` — 기본 `uniform,range`, 클라이언트는 `group.remote.assignor`로 선택 |
| 클라이언트 커스텀 assignor | 가능 | **미지원** |

전역 동기화 장벽이 없다는 말은, 한 컨슈머가 들어오고 나가는 동안 **다른 컨슈머는 하던 일을 계속한다**는 뜻입니다. cooperative 전략이 클라이언트 쪽에서 흉내 내던 것을 프로토콜 수준에서 보장합니다.

도입 전 확인 사항은 셋입니다.

- 브로커가 4.0 이상이고 `group.coordinator.rebalance.protocols`에 `consumer`가 포함되어 있어야 합니다 (4.1 기본값 `classic,consumer,streams`).
- 클라이언트에 `session.timeout.ms`·`heartbeat.interval.ms`·`partition.assignment.strategy`를 넣어 두었다면 **무시되거나 거부**됩니다. 설정을 브로커 쪽으로 옮기십시오.
- 자체 구현한 assignor가 있다면 아직 쓸 수 없습니다. 기존 그룹을 옮기려면 브로커의 `group.consumer.migration.policy`가 `upgrade` 또는 `bidirectional`이어야 합니다.

> 선택 기준을 한 줄로 줄이면 이렇습니다. **브로커가 4.x이면 KIP-848, 아니면 Cooperative Sticky + 정적 멤버십.** 둘은 배타적이지 않으며, 정적 멤버십은 새 프로토콜에서도 그대로 유효합니다.

## 9. 리밸런싱 중 데이터를 지키는 코드 — ConsumerRebalanceListener

전략을 바꿔도 **반납 직전에 커밋하지 않으면** 재할당받은 컨슈머가 같은 레코드를 다시 읽습니다. 중복 처리의 가장 흔한 출처가 여기입니다.

```java
consumer.subscribe(List.of("orders"), new ConsumerRebalanceListener() {
    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        // 반납 전: 지금까지 처리한 오프셋을 동기 커밋
        consumer.commitSync(currentOffsets);
    }
    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        // 새 파티션: 필요하면 외부 저장소의 오프셋으로 seek
    }
    @Override
    public void onPartitionsLost(Collection<TopicPartition> partitions) {
        // 세션 만료 등으로 이미 뺏긴 경우 — 커밋하면 안 됨 (다른 소유자가 있음)
        currentOffsets.clear();
    }
});
```

세 콜백의 차이를 정확히 알아야 합니다.

- **`onPartitionsRevoked`** — 정상적인 반납. 이 시점의 커밋은 유효하며, cooperative에서는 **옮겨지는 파티션에 대해서만** 호출됩니다.
- **`onPartitionsLost`** — 이미 소유권을 잃은 뒤에 호출됩니다(세션 만료, 펜싱). 여기서 커밋하면 `CommitFailedException`이거나, 더 나쁘게는 새 소유자의 진행을 덮어씁니다.
- **`onPartitionsAssigned`** — 할당 직후. 오프셋을 외부에 보관하는 설계라면 여기서 `seek()`합니다.

Spring Kafka를 쓴다면 `ConsumerAwareRebalanceListener`가 같은 역할을 하며, `AckMode.MANUAL_IMMEDIATE`와 함께 쓸 때 반납 직전 커밋이 보장되는지 확인하십시오.

## 10. 흔한 실수

- **`max.poll.interval.ms`만 계속 늘린다** — 루프 주기만 길어지고 장애 감지는 느려집니다. `max.poll.records`를 먼저 줄이는 것이 순서입니다.
- **`session.timeout.ms`를 줄여서 처리 지연을 잡으려 한다** — 하트비트는 별도 스레드라 처리 지연과 무관합니다. 네트워크 흔들림에 더 쉽게 쫓겨날 뿐입니다.
- **전략을 한 번에 eager에서 cooperative로 바꾼다** — 신구 컨슈머가 공통 전략을 못 찾아 리밸런싱이 실패합니다. 기본 목록이면 한 번, 아니면 두 번의 롤링이 필요합니다.
- **Deployment에 `group.instance.id`를 고정값으로 넣는다** — 파드가 교체될 때 ID가 겹쳐 `FencedInstanceIdException`이 납니다. StatefulSet의 파드 이름을 쓰십시오.
- **정적 멤버십을 켜고 세션 타임아웃은 기본값으로 둔다** — 재시작이 45초를 넘기면 결국 리밸런싱이 납니다. 재시작 시간보다 넉넉하게 잡아야 합니다.
- **`onPartitionsLost`에서 커밋한다** — 이미 다른 컨슈머가 소유한 파티션입니다. 커밋이 실패하거나 남의 진행을 덮습니다.
- **컨슈머 수를 파티션 수보다 늘린다** — 초과분은 유휴 상태이고, 들어오고 나갈 때마다 리밸런싱만 유발합니다.
- **정규식 구독에 임시 토픽이 걸린다** — 테스트 토픽 하나가 생길 때마다 그룹 전체가 리밸런싱됩니다. 패턴을 좁히십시오.
- **쿠버네티스 `terminationGracePeriodSeconds`를 짧게 둔다** — 종료 중 `close()`가 끝나기 전에 SIGKILL이 오면 `LeaveGroup` 없이 사라져 세션 타임아웃까지 파티션이 묶입니다.

## 실전 체크리스트

- lag 그래프가 톱니형인지 우상향인지 먼저 확인했다.
- `--describe --state`로 그룹이 `Stable`인지, 아니면 `PreparingRebalance`를 오가는지 확인했다.
- 컨슈머 로그에서 이탈 사유(`poll timeout`·`heartbeat expiration`·`left the group`)를 특정했다.
- `max.poll.records × P99 처리 시간`이 `max.poll.interval.ms`의 절반 이하가 되도록 조정했다.
- `partition.assignment.strategy`에 `RangeAssignor`가 남아 있는지 확인하고 롤링 횟수를 정했다.
- StatefulSet 파드 이름을 `group.instance.id`로 주입하고 `session.timeout.ms`를 재시작 시간보다 크게 잡았다.
- `onPartitionsRevoked`에서 동기 커밋하고 `onPartitionsLost`에서는 커밋하지 않도록 했다.
- `terminationGracePeriodSeconds`가 `close()` 완료 시간보다 긴지 확인했다.
- 컨슈머 수가 파티션 수를 넘지 않도록 레플리카 상한을 두었다.
- 브로커 4.x라면 `group.protocol=consumer` 전환 시 클라이언트 측 타임아웃 설정을 제거했다.
- 리밸런싱 횟수(`rebalance-total`)·소요 시간(`rebalance-latency-avg`)·실패(`failed-rebalance-total`)를 대시보드에 올렸다.
- 그룹 상태가 `Stable`이 아닌 상태로 5분 이상 지속되면 알림이 가도록 했다.

## 마치며

리밸런싱은 장애가 아니라 **그룹이 약속을 지키는 방식**입니다. "한 파티션은 한 컨슈머만 읽는다"는 약속을 멤버가 바뀔 때마다 다시 확인하는 절차일 뿐이고, 비용이 큰 이유는 그 확인을 전원이 멈춘 채 했기 때문입니다. Cooperative Sticky는 멈추는 범위를, 정적 멤버십은 확인하는 횟수를, KIP-848은 확인하는 방식 자체를 바꿉니다. 타임아웃을 늘리기 전에 **어느 것이 비용을 만들고 있는지**부터 고르십시오.

## FAQ

**Q1. 리밸런싱이 몇 번 나면 문제인가요?**
횟수보다 **그룹이 `Stable`로 돌아오는 데 걸리는 시간**과 **같은 멤버가 반복해서 나가는지**를 보십시오. 배포 1회에 컨슈머 수만큼의 리밸런싱은 eager 전략에서 정상이지만, 배포가 없는데 10분에 한 번씩 난다면 `max.poll.interval.ms` 초과입니다. JMX의 `last-rebalance-seconds-ago`가 계속 작은 값이면 루프입니다.

**Q2. `max.poll.interval.ms`를 30분으로 늘려도 되나요?**
됩니다만, 그 컨슈머가 실제로 멈췄을 때 30분 동안 아무도 모릅니다. 먼저 `max.poll.records`를 100 이하로 줄이고, 그래도 부족하면 `poll()` 스레드와 처리 스레드를 분리해 `poll()` 간격을 처리 시간과 떼어 놓으십시오. 타임아웃 상향은 그 다음입니다.

**Q3. Cooperative Sticky로 바꿨는데 여전히 배포마다 멈춥니다.**
cooperative는 **멈추는 범위**를 줄이지 **횟수**를 줄이지 않습니다. 재시작된 컨슈머의 파티션은 여전히 반납·재할당됩니다. 배포 자체를 리밸런싱 없이 넘기려면 정적 멤버십(`group.instance.id` + 넉넉한 `session.timeout.ms`)이 필요합니다. 둘은 함께 쓰는 조합입니다.

**Q4. KIP-848로 가면 `session.timeout.ms`는 어디서 바꾸나요?**
브로커 설정 `group.consumer.session.timeout.ms`(기본 45000)와 `group.consumer.heartbeat.interval.ms`(기본 5000)입니다. 클라이언트의 같은 이름 설정은 `group.protocol=consumer`에서 지원되지 않습니다. 그룹별로 다른 값이 필요하면 브로커의 `group.consumer.min/max.session.timeout.ms` 범위 안에서 조정합니다.

## 참고 공식 문서

- Apache Kafka 4.1 Documentation — Consumer Configs (`partition.assignment.strategy`, `group.instance.id`, `group.protocol`, `max.poll.interval.ms`)
- Apache Kafka 4.1 Documentation — Broker Configs (`group.consumer.session.timeout.ms`, `group.consumer.heartbeat.interval.ms`, `group.consumer.assignors`, `group.consumer.migration.policy`)
- KIP-848: The Next Generation of the Consumer Rebalance Protocol
- KIP-429: Kafka Consumer Incremental Rebalance Protocol / KIP-345: Static Membership

## 함께 읽으면 좋은 글

- [Kafka Consumer Lag 완전정리 — 확인 방법·원인 진단·리밸런싱·처리량 튜닝](https://hadesyi.tistory.com/364)
- [Kubernetes Probe 완전정리 — Liveness·Readiness·Startup 설계와 흔한 오설정](https://hadesyi.tistory.com/415)
- [Kubernetes CrashLoopBackOff 해결 가이드 — 로그·이벤트·Probe·OOM 점검](https://hadesyi.tistory.com/393)
- [5편. 실전 운영 장애 사례 10선 + 장애 복구 플레이북](https://hadesyi.tistory.com/344)

태그(9개): ConsumerGroup, CooperativeSticky, kafka, kafka운영, KIP-848, rebalance, 리밸런싱, 장애대응, 트러블슈팅
