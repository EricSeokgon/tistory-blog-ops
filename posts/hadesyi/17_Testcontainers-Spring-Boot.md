# Testcontainers로 Spring Boot 통합 테스트 완전정리 — @ServiceConnection·싱글톤 컨테이너·CI 설정 실전 가이드

로컬에서는 H2로 모든 테스트가 초록불인데, 운영 PostgreSQL에 배포하자마자 `jsonb` 컬럼 쿼리가 문법 오류로 터지는 상황. 원인은 단순합니다. **테스트가 검증한 것은 H2였지 PostgreSQL이 아니었기 때문**입니다. 임베디드 대체물과 Mock은 빠르지만, 실제 데이터베이스의 방언·트랜잭션 격리·인덱스 동작, 실제 Kafka의 파티션·오프셋 커밋 동작은 흉내 내지 못합니다. 이 글은 Testcontainers로 **운영과 같은 미들웨어를 테스트 안에서 띄우는 방법**과, 그 테스트를 느려지지 않게 유지하는 설계를 정리합니다.

## 핵심 요약

- Testcontainers는 테스트 코드에서 **Docker 컨테이너를 띄우고 정리하는 라이브러리**입니다. H2·임베디드 Kafka 대신 운영과 같은 이미지로 검증합니다.
- Spring Boot에서는 **`@ServiceConnection` 한 줄**로 컨테이너의 접속 정보가 `spring.datasource.*` 같은 설정을 대신합니다. `@DynamicPropertySource`는 지원되지 않는 서비스에만 씁니다.
- Testcontainers 2.x부터 **아티팩트 이름에 `testcontainers-` 접두어**가 붙고 모듈별 패키지(`org.testcontainers.postgresql` 등)로 정리됐습니다. 1.x 예제를 그대로 복사하면 import가 맞지 않습니다.
- 느린 통합 테스트의 주범은 컨테이너 기동입니다. **테스트 클래스마다 새로 띄우지 말고 싱글톤 컨테이너나 Spring 빈으로 공유**하십시오.
- CI에서는 **Docker 데몬 접근**이 전제입니다. GitHub Actions의 Linux 러너는 기본 제공, 다른 환경은 Docker 소켓 또는 원격 Docker 설정을 먼저 확인하십시오.

## 1. 왜 Testcontainers인가 — Mock·임베디드의 한계

테스트 더블의 종류에 따라 검증할 수 있는 범위가 다릅니다.

| 방식 | 속도 | 운영과의 동일성 | 놓치는 것 |
| --- | --- | --- | --- |
| Mock (Mockito) | 매우 빠름 | 낮음 | SQL 문법, 제약조건, 직렬화 |
| 임베디드 대체물 (H2, 임베디드 Kafka) | 빠름 | 중간 | DB 방언, 확장 타입, 브로커 설정 차이 |
| Testcontainers | 느림(초 단위 기동) | 높음 | 운영 인프라 고유 설정(네트워크, 용량) |

Testcontainers는 Mock을 대체하는 도구가 아닙니다. **Repository·메시지 컨슈머·캐시처럼 외부 시스템과의 경계에 있는 코드**를 검증하는 층에 씁니다. 비즈니스 로직 단위 테스트는 여전히 Mock으로 빠르게 돌리고, 경계 테스트만 실제 컨테이너로 돌리는 구성이 현실적입니다.

> H2의 PostgreSQL 호환 모드는 문법 일부를 흉내 낼 뿐입니다. `jsonb`, `ON CONFLICT`, 부분 인덱스, 시퀀스 동작이 운영과 다르면 테스트는 통과하고 운영은 실패합니다.

## 2. 의존성 설정 — Testcontainers 2.x 기준

Testcontainers 2.x는 모듈 아티팩트 이름이 바뀌었습니다. 1.x의 `org.testcontainers:postgresql`은 2.x에서 `org.testcontainers:testcontainers-postgresql`입니다.

```kotlin
// build.gradle.kts
dependencies {
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation(platform("org.testcontainers:testcontainers-bom:2.0.5"))
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.testcontainers:testcontainers-kafka")
    runtimeOnly("org.postgresql:postgresql")   // Testcontainers는 JDBC 드라이버를 포함하지 않음
}
```

Spring Boot를 쓴다면 Boot가 관리하는 Testcontainers 버전을 따르는 편이 안전합니다. BOM 버전을 직접 박으면 Boot 업그레이드 때 충돌이 납니다. 위 예시의 BOM 줄은 Boot 의존성 관리를 쓰지 않는 프로젝트용입니다.

패키지도 모듈별로 정리됐습니다.

| 컨테이너 | 2.x 클래스 |
| --- | --- |
| PostgreSQL | `org.testcontainers.postgresql.PostgreSQLContainer` |
| Kafka (apache/kafka 이미지) | `org.testcontainers.kafka.KafkaContainer` |
| Kafka (confluentinc/cp-kafka 이미지) | `org.testcontainers.kafka.ConfluentKafkaContainer` |
| 범용 | `org.testcontainers.containers.GenericContainer` |
| JUnit 5 연동 | `org.testcontainers.junit.jupiter.Testcontainers`, `Container` |

> 1.x의 `org.testcontainers.containers.KafkaContainer`는 deprecated입니다. 이미지가 `apache/kafka`면 `KafkaContainer`, `confluentinc/cp-kafka`면 `ConfluentKafkaContainer`로 옮기십시오.

## 3. 첫 통합 테스트 — PostgreSQL과 @ServiceConnection

가장 기본 형태입니다. `@Testcontainers`가 `@Container` 필드의 생명주기를 관리하고, `@ServiceConnection`이 접속 정보를 Spring에 넘깁니다.

```java
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers
@SpringBootTest
class OrderRepositoryIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:16-alpine");

    @Autowired
    OrderRepository orderRepository;

    @Test
    void jsonb_조건으로_주문을_조회한다() {
        orderRepository.save(Order.of("A-100", "{\"channel\":\"app\"}"));

        var result = orderRepository.findByChannel("app");

        assertThat(result).extracting(Order::getCode).containsExactly("A-100");
    }
}
```

`@ServiceConnection`이 없던 시절에는 아래처럼 속성을 직접 주입했습니다. 지금도 Spring Boot가 지원하지 않는 서비스나 추가 속성이 필요할 때 씁니다.

```java
@DynamicPropertySource
static void props(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", postgres::getJdbcUrl);
    registry.add("spring.datasource.username", postgres::getUsername);
    registry.add("spring.datasource.password", postgres::getPassword);
}
```

필드는 반드시 **`static`** 으로 선언하십시오. 인스턴스 필드면 테스트 메서드마다 컨테이너가 새로 뜹니다.

## 4. 이미지 버전 고정 — latest를 쓰지 않는다

테스트의 가치는 **운영과 같은 버전**에서 나옵니다.

- **태그를 운영과 맞추기** — 운영이 PostgreSQL 16이면 `postgres:16-alpine`, 메이저 버전까지는 반드시 일치시킵니다.
- **`latest` 금지** — 어느 날 갑자기 메이저 버전이 바뀌어 CI가 깨지고, 그 원인을 코드에서 찾느라 시간을 씁니다.
- **사내 레지스트리 미러** — Docker Hub 요청 제한에 걸리는 CI라면 이미지 이름에 미러 주소를 쓰거나 Testcontainers의 이미지 이름 치환 설정을 사용합니다.

```java
static final DockerImageName PG_IMAGE =
        DockerImageName.parse("registry.example.com/mirror/postgres:16-alpine")
                       .asCompatibleSubstituteFor("postgres");
```

`asCompatibleSubstituteFor`는 "이 사설 이미지는 공식 postgres와 호환된다"고 선언하는 것입니다. 이 선언이 없으면 모듈이 이미지 이름 검증에서 실패합니다.

## 5. 데이터 초기화 — 마이그레이션과 테스트 격리

컨테이너는 빈 데이터베이스로 뜹니다. 스키마는 운영과 같은 경로로 만들어야 의미가 있습니다.

- **Flyway·Liquibase를 그대로 실행** — 애플리케이션 기동 시 마이그레이션이 돌면 스키마 검증까지 함께 됩니다. `ddl-auto=create`로 테스트하면 마이그레이션 스크립트의 버그를 놓칩니다.
- **테스트 간 데이터 격리** — 컨테이너를 공유하면 앞 테스트의 데이터가 남습니다. 방법은 셋입니다.

```java
// 1) 테스트 트랜잭션 롤백 — JPA/JDBC 테스트에 가장 간단
@Transactional
@SpringBootTest
class OrderServiceIT { ... }

// 2) 각 테스트 전에 테이블 비우기 — 비동기·다른 스레드가 쓰는 경우
@BeforeEach
void clean(@Autowired JdbcTemplate jdbc) {
    jdbc.execute("TRUNCATE orders, order_items RESTART IDENTITY CASCADE");
}

// 3) 테스트마다 고유 키 사용 — 병렬 실행 시 충돌 회피
var code = "A-" + UUID.randomUUID();
```

> `@Transactional` 롤백은 **테스트 스레드 안의 작업만** 되돌립니다. `@Async`, 메시지 리스너, 별도 트랜잭션(`REQUIRES_NEW`)이 쓴 데이터는 남습니다. 이런 코드를 테스트할 때는 2번 방식을 쓰십시오.

## 6. Kafka 통합 테스트 — 프로듀서·컨슈머 왕복 검증

Kafka 컨슈머 로직은 Mock으로 검증하기 가장 어려운 영역입니다. 오프셋 커밋, 재시도, 역직렬화 실패 처리는 실제 브로커에서만 드러납니다.

```java
import org.testcontainers.kafka.KafkaContainer;

@Testcontainers
@SpringBootTest
class PaymentEventConsumerIT {

    @Container
    @ServiceConnection
    static KafkaContainer kafka = new KafkaContainer("apache/kafka:3.8.0");

    @Autowired KafkaTemplate<String, String> kafkaTemplate;
    @Autowired PaymentRepository paymentRepository;

    @Test
    void 결제_완료_이벤트를_소비해_상태를_갱신한다() {
        kafkaTemplate.send("payment.completed", "P-1", "{\"paymentId\":\"P-1\"}");

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
            assertThat(paymentRepository.findById("P-1"))
                .get().extracting(Payment::getStatus).isEqualTo(Status.COMPLETED)
        );
    }
}
```

비동기 소비는 **Awaitility의 `await()`** 로 기다립니다. `Thread.sleep()`은 느린 환경에서는 실패하고, 빠른 환경에서는 시간을 낭비합니다.

컨슈머 테스트에서 자주 놓치는 설정이 `auto-offset-reset`입니다. 컨슈머가 구독을 시작하기 전에 메시지가 발행되면 기본값 `latest`에서는 그 메시지를 읽지 못합니다.

```yaml
# src/test/resources/application-test.yml
spring:
  kafka:
    consumer:
      auto-offset-reset: earliest
      group-id: test-${random.uuid}
```

## 7. Redis 등 GenericContainer — name 힌트가 필요한 경우

전용 모듈이 없는 서비스는 `GenericContainer`로 띄웁니다. 이때 Spring Boot는 이미지 이름만으로 어떤 서비스인지 추론하지 못하므로 **`@ServiceConnection(name = ...)`** 으로 알려줘야 합니다.

```java
import org.testcontainers.containers.GenericContainer;

@TestConfiguration(proxyBeanMethods = false)
class RedisTestConfig {

    @Bean
    @ServiceConnection(name = "redis")
    GenericContainer<?> redis() {
        return new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);
    }
}
```

`withExposedPorts`로 내부 포트를 선언하면 Testcontainers가 **호스트의 임의 포트**에 매핑합니다. 테스트 코드에 `6379`를 하드코딩하면 안 되는 이유입니다. 접속 정보는 항상 `getHost()`와 `getMappedPort(6379)`로 얻습니다.

## 8. 속도 — 싱글톤 컨테이너와 Spring 빈 방식

통합 테스트가 느려지는 가장 큰 원인은 **테스트 클래스마다 컨테이너를 새로 띄우는 구조**입니다. `@Container`를 static으로 선언해도 그 생명주기는 **클래스 단위**라, 클래스가 20개면 PostgreSQL이 20번 뜹니다.

방법은 두 가지입니다.

**방법 1. Spring 빈으로 선언** — Spring Boot 공식 문서가 권장하는 방식입니다. 컨테이너가 애플리케이션 컨텍스트와 함께 캐시되므로, 같은 설정을 쓰는 테스트 클래스끼리 재사용됩니다.

```java
@TestConfiguration(proxyBeanMethods = false)
public class ContainersConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer postgres() {
        return new PostgreSQLContainer("postgres:16-alpine");
    }

    @Bean
    @ServiceConnection
    KafkaContainer kafka() {
        return new KafkaContainer("apache/kafka:3.8.0");
    }
}

@SpringBootTest
@Import(ContainersConfig.class)
class OrderServiceIT { ... }
```

**방법 2. 싱글톤 컨테이너 패턴** — 추상 기반 클래스의 static 블록에서 한 번만 시작합니다. JVM이 끝나면 Testcontainers의 정리 컨테이너(Ryuk)가 제거합니다.

```java
public abstract class AbstractIntegrationTest {

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    static {
        POSTGRES.start();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }
}
```

> Spring 테스트 컨텍스트 캐시는 **설정이 같을 때만** 재사용됩니다. 클래스마다 `@MockitoBean`·`@TestPropertySource` 조합이 다르면 컨텍스트가 새로 만들어집니다. 통합 테스트용 설정 조합을 몇 개로 통일하는 것만으로 실행 시간이 크게 줄어듭니다.

로컬 개발에서는 **컨테이너 재사용**도 쓸 수 있습니다. `~/.testcontainers.properties`에 `testcontainers.reuse.enable=true`를 넣고 컨테이너에 `.withReuse(true)`를 지정하면, 테스트가 끝나도 컨테이너가 남아 다음 실행에서 바로 붙습니다. CI에서는 켜지 마십시오. 이전 실행의 데이터가 남아 테스트가 비결정적이 됩니다.

## 9. CI 설정 — Docker 접근과 흔한 실패

Testcontainers는 Docker API에 접근할 수 있어야 동작합니다.

```yaml
# .github/workflows/test.yml
name: test
on: [push, pull_request]
jobs:
  integration-test:
    runs-on: ubuntu-latest        # Docker가 기본 설치된 러너
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - run: ./gradlew test --no-daemon
```

CI에서 실패할 때 확인할 순서입니다.

```text
Could not find a valid Docker environment
├─ Docker 데몬이 있는가?          → 러너 이미지 확인 (macOS·Windows 호스티드 러너는 기본 Docker 없음)
├─ 소켓에 접근 권한이 있는가?      → /var/run/docker.sock 권한, DOCKER_HOST 설정
├─ Docker-in-Docker 구성인가?     → TESTCONTAINERS_HOST_OVERRIDE로 컨테이너 접속 호스트 지정
└─ 이미지 pull이 막혔는가?        → 레지스트리 미러, Docker Hub 요청 제한 확인
```

쿠버네티스 위에서 도는 CI 에이전트(Jenkins 에이전트 Pod 등)는 Docker 소켓이 없는 경우가 대부분입니다. 이때는 원격 Docker 호스트나 클라우드형 컨테이너 런타임을 쓰는 쪽이 현실적입니다.

빌드 도구에서 단위 테스트와 통합 테스트를 분리해 두면 피드백이 빨라집니다.

```kotlin
// build.gradle.kts — 이름이 *IT 로 끝나는 클래스만 별도 태스크로
tasks.test {
    useJUnitPlatform()
    exclude("**/*IT.class")
}

val integrationTest by tasks.registering(Test::class) {
    useJUnitPlatform()
    include("**/*IT.class")
    shouldRunAfter(tasks.test)
}

tasks.check { dependsOn(integrationTest) }
```

## 10. 흔한 실수

- **`@Container` 필드를 static 없이 선언** — 테스트 메서드마다 컨테이너가 새로 떠서 실행 시간이 몇 배로 늘어납니다.
- **`latest` 태그 사용** — 이미지가 바뀌는 날 원인 모를 CI 실패가 시작됩니다. 운영과 같은 버전으로 고정하십시오.
- **포트 하드코딩** — 컨테이너 포트는 호스트의 임의 포트로 매핑됩니다. `getMappedPort()`·`@ServiceConnection`으로 받으십시오.
- **1.x 예제를 2.x에 그대로 복사** — 아티팩트 이름과 패키지가 바뀌어 의존성 해석이나 import에서 실패합니다.
- **`Thread.sleep()`으로 비동기 대기** — 느린 CI에서는 깨지고 빠른 로컬에서는 시간을 버립니다. Awaitility를 쓰십시오.
- **`@Transactional` 롤백으로 모든 격리를 해결하려 함** — 비동기·별도 트랜잭션이 쓴 데이터는 남습니다.
- **`ddl-auto=create`로 스키마 생성** — 마이그레이션 스크립트의 오류를 검증하지 못합니다.
- **CI에서 컨테이너 재사용 활성화** — 이전 실행의 상태가 남아 테스트 결과가 실행 순서에 따라 달라집니다.

## 실전 체크리스트

- 경계 테스트(Repository·컨슈머·캐시)와 비즈니스 로직 단위 테스트의 범위를 나눴다.
- Testcontainers 2.x 아티팩트(`testcontainers-*`)와 모듈 패키지로 의존성을 정리했다.
- JDBC 드라이버를 별도 의존성으로 추가했다.
- 컨테이너 이미지 태그를 운영과 같은 메이저 버전으로 고정했다.
- `@ServiceConnection`으로 접속 정보를 연결하고, 미지원 서비스만 `@DynamicPropertySource`를 썼다.
- 컨테이너 필드를 static으로 선언하거나 Spring 빈으로 등록했다.
- 스키마를 Flyway·Liquibase 마이그레이션으로 생성했다.
- 비동기 코드의 테스트 데이터 정리를 `TRUNCATE` 또는 고유 키로 처리했다.
- Kafka 컨슈머 테스트에 `auto-offset-reset: earliest`와 고유 group-id를 설정했다.
- 비동기 검증에 Awaitility를 사용했다.
- 통합 테스트용 Spring 설정 조합을 통일해 컨텍스트 캐시가 재사용되게 했다.
- CI 러너에서 Docker 접근이 가능한지 확인했다.
- 단위 테스트와 통합 테스트를 별도 태스크로 분리했다.

## 마치며

Testcontainers의 가치는 "진짜 데이터베이스로 테스트한다"는 데 있지 않고, **운영에서 처음 발견될 오류를 PR 단계로 앞당긴다**는 데 있습니다. 그 대가는 실행 시간이고, 그래서 이 도구의 실력은 컨테이너를 띄우는 코드가 아니라 **컨테이너를 덜 띄우는 설계**에서 갈립니다. 경계 테스트에만 쓰고, 컨테이너와 컨텍스트를 공유하는 구조부터 잡으십시오.

## FAQ

**Q1. 로컬에 Docker Desktop이 없으면 쓸 수 없나요?**
Docker API와 호환되는 런타임이면 됩니다. Colima, Rancher Desktop, Podman(Docker 호환 소켓 활성화) 등을 쓸 수 있고, 환경에 따라 `DOCKER_HOST`를 지정해야 합니다. 동작 여부는 `docker info`가 정상 응답하는지로 먼저 확인하십시오.

**Q2. 테스트가 끝났는데 컨테이너가 남아 있습니다.**
Testcontainers는 정리 전용 컨테이너(Ryuk)로 JVM 종료 후 남은 컨테이너를 제거합니다. 일부 CI 환경에서 `TESTCONTAINERS_RYUK_DISABLED=true`로 꺼 두면 정리가 되지 않으니, 그 경우 CI 작업 단위로 Docker 환경 자체가 폐기되는지 확인하십시오. 로컬에서 `withReuse(true)`를 쓰는 경우는 의도적으로 남는 것입니다.

**Q3. 개발 중에도 같은 컨테이너로 애플리케이션을 띄울 수 있나요?**
Spring Boot는 테스트 소스에 별도 메인 클래스를 두고 `SpringApplication.from(MyApplication::main).with(ContainersConfig.class).run(args)`로 실행하는 방식을 지원합니다. Gradle은 `bootTestRun`, Maven은 `spring-boot:test-run`으로 띄우면 테스트와 같은 컨테이너 설정으로 로컬 개발 환경이 구성됩니다.

**Q4. 병렬 테스트에서 싱글톤 컨테이너를 공유해도 되나요?**
컨테이너 공유 자체는 문제가 없습니다. 충돌하는 것은 데이터입니다. 테스트마다 고유 키를 쓰거나, 스키마·데이터베이스를 테스트 단위로 나누십시오. `TRUNCATE`로 정리하는 방식은 병렬 실행과 함께 쓰면 다른 테스트의 데이터를 지우므로 피해야 합니다.

## 참고 공식 문서

- Testcontainers for Java — PostgreSQL Module
- Testcontainers for Java — Kafka Module
- Spring Boot Reference — Testing: Testcontainers
- Spring Boot Reference — Development-time Services (Testcontainers)

## 함께 읽으면 좋은 글

- [테스트 코드 학습 (junit5) - 개념 및 간단한 사용법](https://hadesyi.tistory.com/222)
- [Kafka Consumer Lag 완전정리 — 확인 방법·원인 진단·리밸런싱·처리량 튜닝](https://hadesyi.tistory.com/364)
- [Spring Boot Redis 캐시 적용 전 반드시 확인할 체크리스트: 장애를 막는 운영 기준](https://hadesyi.tistory.com/365)
- [Spring Boot Actuator 운영 가이드 — Health·Metrics·Prometheus·보안 설정](https://hadesyi.tistory.com/391)

---

**태그(9개):** IntegrationTest, JUnit5, Kafka, PostgreSQL, ServiceConnection, SpringBoot, Testcontainers, 테스트자동화, 통합테스트
