# Kafka Consumer Lag 완전정리 — 확인 방법·원인 진단·리밸런싱·처리량 튜닝

"Lag이 10만인데 괜찮은 건가요?" Kafka를 운영하면 반드시 이 질문 앞에 섭니다. 답부터 말하면 **건수만 보고는 알 수 없습니다.** 초당 10만 건을 처리하는 그룹의 lag 10만은 1초짜리이고, 초당 100건을 처리하는 그룹의 lag 10만은 17분짜리입니다. 이 글은 lag을 제대로 읽는 법에서 시작해, 원인을 여섯 갈래로 좁히는 진단 순서, 그리고 파라미터·파티션·리밸런싱이라는 세 개의 레버를 실전 순서대로 정리합니다.

## 핵심 요약

- **Lag = LOG-END-OFFSET − CURRENT-OFFSET.** 브로커에 쌓인 마지막 오프셋과 **커밋된** 오프셋의 차이입니다. "처리한 위치"가 아니라 "커밋한 위치"라는 점이 함정입니다.
- **건수 lag보다 시간 lag을 보십시오.** 알림 임계값을 건수로 잡으면 트래픽이 바뀔 때마다 오탐이 납니다.
- **파티션 수가 병렬성의 천장입니다.** 컨슈머를 파티션 수보다 많이 띄우면 나머지는 놀기만 합니다.
- **lag 그래프가 톱니 모양이면 처리 지연이 아니라 리밸런싱 루프**입니다. 범인은 대개 `max.poll.interval.ms`(기본 5분)입니다.
- **파티션 증설은 되돌릴 수 없고 키 순서를 깨뜨립니다.** 마지막 수단으로 두십시오.
- **리밸런싱은 줄일 수 있습니다.** `CooperativeStickyAssignor` → 정적 멤버십 → Kafka 4.0의 새 프로토콜(KIP-848) 순서로 올라갑니다.

## 1. Lag의 정의 — 무엇과 무엇의 차이인가

Consumer lag은 파티션 단위로 정의됩니다.

```
LAG = LOG-END-OFFSET (브로커의 마지막 오프셋) − CURRENT-OFFSET (그룹이 커밋한 오프셋)
```

여기서 중요한 것은 **CURRENT-OFFSET이 "처리 완료 지점"이 아니라 "커밋 지점"** 이라는 사실입니다. 둘은 다릅니다.

| 값 | 의미 | 누가 갱신하나 |
| --- | --- | --- |
| LOG-END-OFFSET | 파티션에 쓰인 마지막 레코드 다음 위치 | 프로듀서 |
| CURRENT-OFFSET | `__consumer_offsets`에 커밋된 위치 | 컨슈머(커밋 시점) |
| LAG | 위 둘의 차 | 계산값 |

`enable.auto.commit=true`(기본값)이면 커밋은 `poll()` 호출 중에 `auto.commit.interval.ms`(기본 5초) 간격으로 일어납니다. 즉 **이미 처리한 레코드인데 아직 커밋 전이라 lag에 잡히는 구간이 상시로 존재**합니다. 최대 5초어치입니다. 초당 처리량이 큰 그룹이라면 이 "정상 lag"만으로도 수만 건이 나옵니다.

> 💡 **lag이 0이 아니라고 장애가 아닙니다.** 기저선(baseline)을 먼저 재두십시오. 평상시 lag이 얼마인지 모르면 알림 임계값을 정할 수 없습니다.

## 2. Lag 확인하는 세 가지 방법

### ① CLI — 지금 당장 보는 용도

```bash
kafka-consumer-groups.sh \
  --bootstrap-server broker1:9092 \
  --describe --group order-processor
```

```
GROUP           TOPIC    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG    CONSUMER-ID   HOST
order-processor orders   0          1049213         1049240         27     consumer-1-a  /10.0.1.11
order-processor orders   1          1048002         1092310         44308  consumer-1-b  /10.0.1.12
order-processor orders   2          1050110         1050133         23     consumer-2-a  /10.0.1.13
```

**파티션별로 봐야 합니다.** 위 예시는 합계 lag이 44,358이지만 실제로는 **파티션 1 하나만 밀린** 상황입니다. 합계만 보면 "컨슈머를 늘리자"는 잘못된 결론으로 갑니다.

그룹 상태와 멤버도 같이 확인하십시오.

```bash
# 그룹이 안정 상태인지 (Stable / PreparingRebalance / CompletingRebalance / Empty)
kafka-consumer-groups.sh --bootstrap-server broker1:9092 --describe --group order-processor --state

# 멤버별로 어떤 파티션을 잡고 있는지
kafka-consumer-groups.sh --bootstrap-server broker1:9092 --describe --group order-processor --members --verbose
```

`--state`가 `PreparingRebalance`에서 자꾸 잡힌다면 이미 원인의 절반은 나온 셈입니다(7번 항목).

### ② 컨슈머 JMX — 애플리케이션 관점

컨슈머 클라이언트가 직접 노출하는 지표입니다.

| 지표 | 의미 |
| --- | --- |
| `records-lag-max` | 이 컨슈머가 담당한 파티션 중 최대 lag |
| `records-lag` (파티션 태그) | 파티션별 lag |
| `fetch-latency-avg` | 브로커 응답 지연 |
| `commit-latency-avg` | 오프셋 커밋 지연 |

CLI와의 결정적 차이는 **`records-lag`가 커밋 오프셋이 아니라 컨슈머가 실제로 읽은 위치 기준**이라는 점입니다. 두 값이 크게 벌어진다면 커밋이 밀리고 있다는 신호입니다.

### ③ Exporter — 상시 모니터링

`kafka_exporter`를 붙이면 Prometheus에서 바로 잡힙니다.

```promql
# 그룹·토픽 단위 합계 lag
sum by (consumergroup, topic) (kafka_consumergroup_lag)

# 5분간 lag이 계속 증가하는가 — 절대량보다 이 쪽이 유용합니다
deriv(sum by (consumergroup) (kafka_consumergroup_lag)[5m:]) > 0
```

LinkedIn의 **Burrow**는 접근 방식이 다릅니다. 임계값을 사람이 정하는 대신 슬라이딩 윈도로 **lag의 추세**를 평가해 `OK / WARN / ERR`을 냅니다. "임계값을 몇으로 잡아야 할지 모르겠다"가 조직의 실제 문제라면 검토할 만합니다.

## 3. 건수 lag보다 시간 lag을 보십시오

운영에서 답해야 하는 질문은 "몇 건 밀렸나"가 아니라 **"몇 분 늦은 데이터를 보고 있나"** 입니다.

```
시간 lag ≈ 건수 lag ÷ 초당 처리 건수
```

| 그룹 | 건수 lag | 초당 처리 | 시간 lag | 판정 |
| --- | --- | --- | --- | --- |
| A | 100,000 | 50,000 | 2초 | 정상 |
| B | 100,000 | 100 | 약 17분 | 장애 |
| C | 3,000 | 5 | 10분 | 장애 |

**같은 10만인데 하나는 정상이고 하나는 장애입니다.** 알림을 건수로 걸어두면 트래픽이 두 배가 된 날 전부 오탐이 됩니다.

정확한 시간 lag이 필요하면 다음 미소비 오프셋의 레코드 타임스탬프와 현재 시각을 비교하십시오.

```bash
# 파티션별 최신 오프셋
kafka-get-offsets.sh --bootstrap-server broker1:9092 --topic orders --time -1
```

컨슈머 애플리케이션 안에서 계산하는 편이 더 간단합니다. `ConsumerRecord.timestamp()`와 현재 시각의 차를 게이지로 내보내면 그대로 시간 lag이 됩니다.

## 4. 진단 순서 — 5분 안에 원인 좁히기

원인을 아무 순서로나 뒤지면 오래 걸립니다. 이 순서가 가장 빠릅니다.

| 단계 | 확인 | 여기서 갈리면 |
| --- | --- | --- |
| ① | lag이 **특정 파티션만**인가, 전 파티션인가 | 특정 파티션 → 8번(키 쏠림) |
| ② | 그래프가 **톱니 모양**인가, 우상향 직선인가 | 톱니 → 7번(리밸런싱) |
| ③ | 그룹 `--state`가 `Stable`인가 | 아니면 → 7번 |
| ④ | 컨슈머 수 < 파티션 수인가 | 같거나 크면 → 6번(파티션 천장) |
| ⑤ | 프로듀서 유입량이 늘었는가 | 늘었으면 → 5번(처리량 부족) |
| ⑥ | `isolation.level=read_committed`인가 | 맞으면 → 10번(LSO) |

먼저 **그래프 모양**을 보십시오. 우상향 직선이면 처리량 문제이고, 주기적으로 치솟았다 떨어지는 톱니면 리밸런싱입니다. 이 하나로 절반이 갈립니다.

## 5. 원인 ① 처리 속도가 유입 속도보다 느림

가장 흔하지만 가장 자주 오진되는 경우입니다. **"Kafka가 느리다"고 진단되는 상황의 대부분은 Kafka가 아니라 컨슈머 안의 외부 호출이 느린 것**입니다.

컨슈머 루프 한 바퀴의 시간을 분해해 보십시오.

```
poll() 대기  +  역직렬화  +  비즈니스 로직  +  DB/외부 API  +  커밋
```

실측해 보면 DB·외부 API가 대부분을 차지하는 경우가 압도적입니다. 이 경우 컨슈머 인스턴스를 늘려도 DB 커넥션 풀이 천장이라 lag이 안 줄어듭니다.

| 증상 | 진짜 원인 | 대응 |
| --- | --- | --- |
| CPU는 노는데 lag 증가 | 외부 I/O 대기 | 배치 처리·커넥션 풀 확대 |
| 컨슈머 늘려도 그대로 | 공유 자원(DB)이 천장 | DB 쪽을 먼저 손봐야 함 |
| 특정 시간대만 증가 | 배치 작업과 경합 | 스케줄 분리 |

**레코드 단위 처리를 배치 단위로 바꾸는 것이 보통 가장 큰 이득**입니다.

```java
// 나쁨: 500건이면 500번 왕복
for (ConsumerRecord<String, String> r : records) {
    repository.save(convert(r));
}

// 좋음: 한 번의 배치 삽입
List<Entity> batch = new ArrayList<>(records.count());
for (ConsumerRecord<String, String> r : records) {
    batch.add(convert(r));
}
repository.saveAll(batch);   // bulk insert
consumer.commitSync();
```

`max.poll.records`(기본 500)를 그대로 두고 안쪽만 배치화해도 처리량이 몇 배가 되는 일이 흔합니다.

## 6. 원인 ② 파티션 수가 병렬성의 천장

한 파티션은 **그룹 내에서 정확히 하나의 컨슈머**에게만 할당됩니다. 따라서 유효 병렬도는 이렇게 결정됩니다.

```
유효 병렬도 = min(컨슈머 인스턴스 수, 파티션 수)
```

| 파티션 | 컨슈머 | 실제 일하는 컨슈머 | 결과 |
| --- | --- | --- | --- |
| 6 | 3 | 3 | 컨슈머당 2파티션 |
| 6 | 6 | 6 | 1:1, 이상적 |
| 6 | 10 | 6 | **4대가 유휴** |

파티션 6개에 컨슈머 10대를 띄우면 4대는 아무것도 하지 않습니다. `--members`로 확인하면 할당 파티션이 비어 있는 멤버가 보입니다.

```bash
kafka-consumer-groups.sh --bootstrap-server broker1:9092 \
  --describe --group order-processor --members
```

**스케일 아웃 전에 파티션 수부터 확인하십시오.** 이걸 안 보고 오토스케일링을 걸어두면 인스턴스만 늘어나고 lag은 그대로인 상태로 비용만 나갑니다.

## 7. 원인 ③ 리밸런싱 루프 — lag 그래프가 톱니인 이유

lag이 올랐다 떨어졌다를 반복한다면 처리가 느린 게 아니라 **그룹이 계속 재편성되고 있는** 것입니다.

전형적인 악순환은 이렇습니다.

```
처리 시간 > max.poll.interval.ms (기본 300,000ms = 5분)
   ↓
브로커가 해당 컨슈머를 그룹에서 제외
   ↓
리밸런싱 시작 — 처리 중이던 작업 유실, 파티션 재할당
   ↓
재할당 직후 밀린 물량을 한 번에 처리 → 또 5분 초과
   ↓
   반복
```

관련 설정을 구분해 두십시오. **자주 혼동되는 두 값입니다.**

| 설정 | 기본값 | 무엇을 재나 |
| --- | --- | --- |
| `session.timeout.ms` | 45000 | **하트비트**가 끊긴 시간. 프로세스 생존 여부 |
| `heartbeat.interval.ms` | 3000 | 하트비트 전송 주기 |
| `max.poll.interval.ms` | 300000 | **poll() 사이**의 최대 간격. 처리 지연 여부 |

`session.timeout.ms`는 별도 스레드가 보내는 하트비트 기준이라 **처리가 아무리 오래 걸려도 프로세스가 살아 있으면 안 걸립니다.** 처리 지연으로 쫓겨나는 것은 언제나 `max.poll.interval.ms` 쪽입니다.

> ⚠️ **`max.poll.interval.ms`를 무작정 늘리는 것은 임시방편입니다.** 진짜 장애가 났을 때 감지가 그만큼 늦어집니다. 먼저 `max.poll.records`를 줄여 한 번에 가져오는 양을 낮추십시오. 500건 처리가 5분을 넘는다면 100건으로 줄이는 쪽이 정답에 가깝습니다.

```properties
# 처리가 무거운 컨슈머의 현실적인 조합
max.poll.records=100
max.poll.interval.ms=600000
```

## 8. 원인 ④ 특정 파티션만 밀림 — 키 쏠림

CLI 출력에서 **한두 파티션의 LAG만 유독 큰** 경우입니다. 컨슈머를 늘려도 해결되지 않습니다. 그 파티션은 여전히 한 대가 담당하니까요.

원인은 파티셔닝 키입니다. 키가 있는 레코드는 키의 해시를 파티션 수로 나눈 나머지로 배정됩니다.

```
partition = hash(key) % numPartitions
```

특정 고객사 ID나 특정 상품 코드가 전체 트래픽의 상당 부분을 차지하면 그 키가 매핑된 파티션 하나만 폭주합니다.

| 상황 | 대응 |
| --- | --- |
| 순서 보장이 **필요 없음** | 키를 `null`로 두어 분산 |
| 순서가 **키 단위로만** 필요 | 키에 샤드 접미사 추가 (`custA#0` ~ `custA#7`) |
| 전역 순서가 필요 | 애초에 파티션 1개여야 함 — 병렬화 포기 |

**"순서 보장이 정말 필요한가"를 다시 물어보십시오.** 실무에서 전역 순서가 진짜로 필요한 경우는 드물고, 대개는 "같은 주문 건 안에서의 순서"면 충분합니다.

## 9. 원인 ⑤ 커밋 방식이 만드는 가짜 lag

lag은 커밋 기준이라 **커밋 전략이 잘못되면 처리는 정상인데 lag만 커집니다.**

| 전략 | 특징 | lag에 미치는 영향 |
| --- | --- | --- |
| `enable.auto.commit=true` | poll() 중 5초 간격 자동 커밋 | 최대 5초어치 상시 lag |
| `commitSync()` | 배치마다 동기 커밋 | 정확하지만 커밋 지연이 처리량을 깎음 |
| `commitAsync()` | 비동기 | 처리량 유리, 실패 시 재시도를 직접 처리 |
| 커밋 누락 | 예외 경로에서 커밋 안 함 | **처리는 됐는데 lag은 계속 증가** |

특히 위험한 패턴은 **비동기 처리 후 커밋**입니다.

```java
// 위험: 처리 완료 전에 커밋됨 — 장애 시 유실
for (ConsumerRecord<String, String> r : records) {
    executor.submit(() -> handle(r));   // 별도 스레드로 던지고
}
consumer.commitSync();                  // 곧바로 커밋
```

이렇게 하면 lag은 예쁘게 0이지만 **실제로는 아무것도 보장되지 않습니다.** lag 그래프가 좋아 보이는데 데이터가 비는 상황의 전형적 원인입니다.

## 10. 원인 ⑥ read_committed와 LSO

컨슈머가 `isolation.level=read_committed`(기본값은 `read_uncommitted`)라면 lag을 다르게 읽어야 합니다.

이 모드에서 컨슈머는 **LSO(Last Stable Offset)** 를 넘어서 읽지 못합니다. 진행 중인 트랜잭션이 하나라도 열려 있으면 그 뒤의 레코드는 소비 대상이 아닙니다.

```
[커밋된 레코드][열린 트랜잭션 ← LSO][커밋된 레코드][커밋된 레코드]
                                    └── 여기부터는 읽을 수 없음
```

프로듀서가 트랜잭션을 열어놓고 죽으면 `transaction.timeout.ms`가 지날 때까지 LSO가 멈춥니다. 그동안 **컨슈머는 정상인데 lag만 계속 증가**합니다.

> 💡 컨슈머 CPU도 낮고 리밸런싱도 없는데 lag만 우상향이라면 `isolation.level`을 확인하십시오. 이 경우 손봐야 할 곳은 컨슈머가 아니라 프로듀서입니다.

## 11. 대응 ① 컨슈머 파라미터 정리

자주 만지는 값들을 한 표로 모았습니다. **기본값은 Apache Kafka 4.1 문서 기준**입니다.

| 설정 | 기본값 | 올리면 | 내리면 |
| --- | --- | --- | --- |
| `max.poll.records` | 500 | 배치 효율↑, poll 간격↑ | 리밸런싱 위험↓ |
| `max.poll.interval.ms` | 300000 | 긴 처리 허용 | 장애 감지 빨라짐 |
| `session.timeout.ms` | 45000 | 일시적 지연에 관대 | 죽은 컨슈머 감지 빠름 |
| `heartbeat.interval.ms` | 3000 | 네트워크 부하↓ | 감지 정밀도↑ |
| `fetch.min.bytes` | 1 | 처리량↑, 지연↑ | 지연↓ |
| `fetch.max.wait.ms` | 500 | 배치 커짐 | 응답 빨라짐 |
| `max.partition.fetch.bytes` | 1048576 | 파티션당 더 많이 | 메모리 절약 |

권장 조합은 목적에 따라 갈립니다.

```properties
# (A) 지연에 민감한 실시간 처리
max.poll.records=100
fetch.min.bytes=1
fetch.max.wait.ms=100

# (B) 처리량 우선 배치성 소비
max.poll.records=1000
fetch.min.bytes=1048576
fetch.max.wait.ms=500
```

`heartbeat.interval.ms`는 관례적으로 `session.timeout.ms`의 **3분의 1 이하**로 둡니다. 기본값 3000 / 45000이 정확히 그 비율입니다.

## 12. 대응 ② 파티션 증설 — 하기 전에 알아야 할 것

파티션 증설은 효과가 확실하지만 **되돌릴 수 없습니다.**

```bash
kafka-topics.sh --bootstrap-server broker1:9092 \
  --alter --topic orders --partitions 12
```

증설 전에 반드시 확인할 세 가지입니다.

| 확인 | 이유 |
| --- | --- |
| **줄일 수 없다** | Kafka는 파티션 감소를 지원하지 않습니다. 되돌리려면 토픽 재생성 |
| **키 순서가 깨진다** | `hash(key) % numPartitions`의 분모가 바뀌어 같은 키가 다른 파티션으로 갑니다 |
| **기존 데이터는 이동하지 않는다** | 새 파티션은 비어서 시작하고, 과거 레코드의 재분배는 일어나지 않습니다 |

두 번째가 핵심입니다. 증설 시점을 경계로 **같은 키의 레코드가 두 파티션에 나뉘어 존재**하게 되고, 그 구간에서는 순서 보장이 성립하지 않습니다. 순서에 의존하는 소비 로직이 있다면 증설은 무중단으로 할 수 없습니다.

**따라서 순서는 이렇습니다.** ① 컨슈머 내부 처리 최적화 → ② 컨슈머 인스턴스 증설(파티션 수까지) → ③ 파티션 증설. ③은 앞의 둘이 소진된 다음입니다.

## 13. 대응 ③ 리밸런싱 자체를 줄이기

리밸런싱은 없앨 수 없지만 **비용을 크게 낮출 수 있습니다.** 세 단계로 올라갑니다.

### ① CooperativeStickyAssignor

기존 방식(eager)은 리밸런싱 때 **모든 컨슈머가 모든 파티션을 반납**하고 다시 받습니다. 그 사이 그룹 전체가 멈춥니다. 협조적 방식은 실제로 재배치가 필요한 파티션만 옮깁니다.

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

기본값이 `RangeAssignor, CooperativeStickyAssignor` 순서라 **협조적 방식이 저절로 켜지지는 않습니다.** 명시적으로 지정해야 합니다. 다만 전환은 롤링으로 두 번 배포해야 하므로 순서를 확인하고 진행하십시오.

### ② 정적 멤버십(static membership)

컨슈머에 고정 ID를 부여하면 **재시작이 리밸런싱을 유발하지 않습니다.**

```properties
group.instance.id=order-processor-3
session.timeout.ms=120000
```

`session.timeout.ms` 안에 같은 ID로 돌아오면 브로커는 같은 멤버로 인정하고 이전 할당을 그대로 유지합니다. 쿠버네티스 StatefulSet처럼 **파드 이름이 고정된 환경**과 잘 맞습니다. 배포마다 리밸런싱이 나던 것이 사라집니다.

### ③ 새 리밸런스 프로토콜 (KIP-848)

Apache Kafka **4.0에서 정식 제공**된 차세대 컨슈머 그룹 프로토콜입니다.

```properties
group.protocol=consumer
```

| 항목 | 기존(classic) | 새 프로토콜(consumer) |
| --- | --- | --- |
| 할당 주체 | 그룹 리더(클라이언트) | **브로커(서버)** |
| 동기화 | 전역 동기화 장벽 | **완전 증분** |
| 타임아웃 설정 | 클라이언트 | 서버(`group.consumer.*`) |

전역 동기화 장벽이 사라져 **한 컨슈머가 들어오고 나가는 동안 그룹 전체가 멈추지 않습니다.** 다만 클라이언트 측 커스텀 assignor는 아직 지원되지 않으니 자체 assignor를 쓰고 있다면 확인이 필요합니다.

## 14. 모니터링과 알림 기준

알림을 건수로 거는 것이 오탐의 주범입니다. **추세와 시간**으로 거십시오.

| 알림 | 조건 | 의미 |
| --- | --- | --- |
| WARN | 시간 lag > 1분이 5분 지속 | 밀리기 시작 |
| CRIT | 시간 lag > 5분이 5분 지속 | 사용자 영향 |
| CRIT | lag 기울기 > 0이 15분 지속 | 따라잡지 못하는 중 |
| CRIT | 그룹 상태 ≠ Stable 이 5분 지속 | 리밸런싱 루프 |

```promql
# 따라잡지 못하는 중 — 절대량이 아니라 기울기를 봅니다
deriv(sum by (consumergroup) (kafka_consumergroup_lag)[15m:]) > 0
```

**"lag이 크다"보다 "lag이 계속 커진다"가 훨씬 중요한 신호**입니다. 트래픽 급증 직후 lag이 커졌다가 30분 뒤 0으로 돌아온다면 시스템은 정상입니다. 반대로 lag 1,000이 3시간째 줄지 않는다면 이미 처리 능력이 유입을 못 따라가고 있는 것입니다.

## 15. 실전 체크리스트

lag 알림을 받았을 때 이 순서로 내려가십시오.

1. `--describe`로 **파티션별** lag 확인 — 한 곳만인가 전체인가
2. 그래프 모양 확인 — 톱니(리밸런싱) vs 우상향(처리량)
3. `--state`로 그룹이 `Stable`인지 확인
4. 컨슈머 수와 파티션 수 비교 — 유휴 컨슈머가 있는가
5. 컨슈머 CPU·GC·외부 I/O 지연 확인 — 진짜 병목 찾기
6. 최근 배포·트래픽 변화 확인
7. `isolation.level=read_committed`면 프로듀서 트랜잭션 확인
8. 대응은 **처리 최적화 → 컨슈머 증설 → 파티션 증설** 순서로

```bash
# 1~3번을 한 번에
G=order-processor
BS=broker1:9092
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $G
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $G --state
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $G --members
```

## 마무리

정리하면 세 문장입니다.

**Lag은 커밋 기준의 건수이고, 판단은 시간으로 하십시오.** 건수 임계값 알림은 트래픽이 변할 때마다 거짓말을 합니다.

**그래프 모양이 원인을 절반 좁혀줍니다.** 톱니면 `max.poll.interval.ms`와 리밸런싱을, 우상향 직선이면 컨슈머 안의 외부 I/O를 먼저 보십시오.

**파티션 증설은 마지막입니다.** 되돌릴 수 없고 키 순서를 깨뜨립니다. 그 앞에 배치 처리, 컨슈머 증설, `CooperativeStickyAssignor`, 정적 멤버십이라는 되돌릴 수 있는 카드가 넷이나 있습니다.

📎 **함께 읽으면 좋은 글**

- 실전 운영 장애 사례 10선 + 장애 복구 플레이북
- Kubernetes OOMKilled 해결 가이드 — Exit 137·limits·JVM Heap·cgroup v2 원인별 점검
- Kubernetes CrashLoopBackOff 해결 가이드 — 로그·이벤트·Probe·OOM 점검
- Kubernetes Probe 완전정리 — Liveness·Readiness·Startup 설계 기준
- Spring Boot Redis 캐시 적용 전 반드시 확인할 체크리스트

태그(9개): consumer-lag, devops, kafka, 리밸런싱, 메시지큐, 모니터링, 장애대응, 처리량, 트러블슈팅
