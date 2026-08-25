# tistory-blog-ops

> **저장소:** https://github.com/EricSeokgon/tistory-blog-ops (Private)

티스토리 블로그 2개(`ericreview` · `hadesyi`)의 **콘텐츠 기획 → 작성 → 검증 → 자동 발행** 전 과정을 기록한 작업 저장소입니다.

> **이 저장소만 열면 이어서 작업할 수 있도록** 구성했습니다. 새 세션을 시작할 때 AI 에이전트에게 이 README와 [`STATE.md`](STATE.md)를 먼저 읽히십시오.

---

## 대상 블로그

| 블로그 | 주소 | 성격 | 글 수 |
| --- | --- | --- | --- |
| 주식 한 입 | https://ericreview.tistory.com | 주식 투자 입문 (초보 교육) | 103 (공개 전환 3편 완료) |
| HadesYI Dev Story | https://hadesyi.tistory.com | 개발 · AI/LLM 엔지니어링 | 410 |

두 블로그 모두 **같은 티스토리 계정(카카오)** 으로 운영됩니다.

---

## 저장소 구조

```
.
├── README.md                       이 문서
├── STATE.md                        ★ 현재 진행 상태 — 새 세션은 여기부터
├── PLAYBOOK.md                     ★ 다른 블로그에도 그대로 쓰는 표준 절차
├── backlog.md                      다음에 쓸 글 주제 후보 (우선순위 포함)
├── docs/
│   ├── blog-analysis.md            두 블로그 구조·카테고리·시리즈 아크 분석
│   ├── style-guide-ericreview.md   「주식 한 입」 문체·구조 규격
│   ├── style-guide-hadesyi.md      「HadesYI」 문체·구조 규격
│   ├── tistory-publishing.md       ★ 티스토리 자동 발행 방법 (함정 포함)
│   ├── traffic-and-seo.md          유입 통계 진단 + SEO 해야 할 일
│   ├── fact-check-log.md           발행 전 사실 검증 18건 기록
│   ├── work-log-2026-08-18.md      8/18 작업 로그 (GSC 실측·색인 요청·렌더링 검증·신규 함정)
│   ├── work-log-2026-08-24.md      8/24 작업 로그 (공개 전환 1회차·Reranker 원고)
│   └── work-log-2026-08-25.md      8/25 작업 로그 (공개 전환 2회차·재검증 결과)
├── posts/
│   ├── ericreview/                 원고 4편 (발행 3 + 발행 대기 1)
│   └── hadesyi/                    원고 6편 (발행 5 + 임시저장 1)
└── scripts/
    ├── tistory-inject.js           브라우저 콘솔용 본문 주입 스크립트
    └── README.md                   스크립트 사용법
```

## 빠르게 파악하기

- **"지금 어디까지 했나?"** → [`STATE.md`](STATE.md)
- **"직전 세션에서 무슨 일이 있었나?"** → [`docs/work-log-2026-08-18.md`](docs/work-log-2026-08-18.md)
- **"어떻게 하는 건가?"** → [`PLAYBOOK.md`](PLAYBOOK.md)
- **"왜 본문이 안 들어갔었나?"** → [`docs/tistory-publishing.md`](docs/tistory-publishing.md)
- **"자동 발행이 통째로 멈췄는데?"** → 글쓰기 페이지 **진입 직후 뜨는 네이티브 확인창**입니다. 코드로 못 막습니다. 식별법과 대처는 [`docs/work-log-2026-08-18.md`](docs/work-log-2026-08-18.md) 4번
- **"다음에 뭘 쓰지?"** → [`backlog.md`](backlog.md)
- **"제일 급한 게 뭔가?"** → 구글 서치콘솔은 **이미 등록·사이트맵 제출 완료로 실측 확인**(8/18)됐습니다. 남은 병목은 ① 네이버 서치어드바이저 등록, ② hadesyi 공개 전환(406·407·410)입니다. **공개 전환 시 발행일 갱신을 반드시 함께** 하십시오(원칙 6). 진단 배경은 [`docs/traffic-and-seo.md`](docs/traffic-and-seo.md), 실측 수치는 워크로그 참고.

## 작업 이력

| 날짜 | 요약 | 기록 |
| --- | --- | --- |
| ~2026-08-17 | 블로그 분석·문체 규격화, 원고 6편 작성·사실검증 18건, 티스토리 비공개 발행(TinyMCE 방식 확립), 문서화 | STATE.md, PLAYBOOK.md, docs/ |
| 2026-08-18 | **구글 서치콘솔 실측** — 두 블로그 모두 이미 등록·사이트맵 제출 상태 확인(기존 "미등록" 가설 수정), ericreview 12편 리디렉션 오류 발견 → 재검증 요청, 대표글 10편 색인 생성 요청. **신규 6편 렌더링 검증 전부 통과**(본문 길이 기록과 완전 일치). **신규 원고 1편 작성**(RAG Hybrid Search, 링크 부채 해소). **신규 원고 407번으로 비공개 발행·검증 완료**(본문 11,253자). 그 과정에서 **신규 함정 발견** — 글쓰기 진입 직후 네이티브 확인창이 `window.confirm` 무력화보다 먼저 실행돼 자동화가 멈춤(사람이 닫고 재개). GitHub 웹 에디터 타이핑은 줄바꿈 유실로 사용 불가 → **Upload files 방식**으로 전환. 네이버는 확장프로그램 차단으로 미완(수동 절차 문서화) | [`docs/work-log-2026-08-18.md`](docs/work-log-2026-08-18.md) |
| 2026-08-24 | **공개 전환 1회차** — ericreview 101 + hadesyi 404 공개 전환 + 둘 다 구글 색인 요청 완료. GSC 실적 상승 확인(ericreview 클릭 11→15회, 97번 노출 +5,750%). **RAG Reranker 원고 작성·사실검증 완료**(마지막 링크 부채 해소, 발행 대기) | [`docs/work-log-2026-08-24.md`](docs/work-log-2026-08-24.md) |
| 2026-08-25 | **공개 전환 2회차** — ericreview 102 + hadesyi 405 공개·색인요청 완료(누적 공개 4편). GSC 색인 증가 확인(ericreview 60→67, hadesyi 314→326). **리디렉션 오류 재검증 8/22 만료** — 12편 중 3편만 재크롤링, 남은 9편은 개별 색인 요청으로 전환. **05 원고(RAG Reranker) 410번 비공개 발행·검증 완료**(본문 11,136자, 마지막 링크 부채 해소). **리디렉션 9편 중 4편 색인 요청 + 92번 색인 확인**. **06 원고(임베딩 모델 평가) 작성·검증 완료**(발행 대기). **공개 상태 재검증** — 로그아웃 상태 실렌더로 101·102 공개 확인(103은 비공개, 예정대로). 다만 **티스토리는 비공개→공개 전환 시 발행일을 갱신하지 않아** 공개해도 RSS·피드·티스토리 홈에 새 글로 노출되지 않는다는 사실을 확인 → **ericreview 101·102·103 발행일을 8/25로 갱신 + 103 공개 전환**(최신글 3칸이 오늘 날짜). **06 원고 티스토리 임시저장 완료**(본문 11,156자) — 이 과정에서 base64 전사 오차 5건 발생, **1,000자 블록 SHA-256 대조**로 전량 복구(전체 해시·바이트 수 일치 확인) → 표준 검증 절차로 승격. **신규 원고 1편 작성**(원자재·유가 ETF 입문, 사실검증 11건) — 8/17 이후 비어 있던 ericreview 콘텐츠 공백 해소 | [`docs/work-log-2026-08-25.md`](docs/work-log-2026-08-25.md) |



## 새 세션 시작 프롬프트 (복사용)

```
이 저장소(tistory-blog-ops)의 README.md, STATE.md, PLAYBOOK.md를 먼저 읽어줘.
그리고 docs/ 아래 문서로 문체 규격과 티스토리 발행 방법을 파악한 뒤,
STATE.md의 "다음 할 일"부터 이어서 진행해줘.
```

## 원칙

1. **발행은 항상 비공개(비공개 저장)부터.** 렌더링을 눈으로 확인한 뒤 공개로 전환합니다.
2. **사실 검증 없이 발행하지 않습니다.** 특히 세법·규정·수치는 1차 출처로 교차 확인합니다 (docs/fact-check-log.md 참고).
3. **하루에 여러 편을 몰아서 공개하지 않습니다.** 1~2일 간격을 권장합니다.
4. **원고의 정본은 이 저장소입니다.** 티스토리에서 수정했다면 여기에도 반영하십시오.
5. **작업한 날은 작업 로그를 남깁니다.** `docs/work-log-YYYY-MM-DD.md` 형식으로 기록하고 STATE.md와 이 README의 작업 이력을 갱신하십시오.
6. **공개 전환은 발행일 갱신까지 한 세트입니다.** 비공개→공개만 바꾸면 발행일이 최초 저장일로 남아 RSS·구독 피드·티스토리 홈에 새 글로 뜨지 않습니다. 에디터에서 발행일을 전환 시점으로 바꾼 뒤 공개 저장하십시오.
7. **base64로 본문을 주입할 때는 1,000자 블록 SHA-256으로 대조합니다.** 길이 확인만으로는 같은 길이의 문자 치환을 잡지 못합니다. 틀린 블록만 교체하고, 마지막에 전체 해시와 디코드 바이트 수를 확인하십시오.
8. **저장소 파일 수정은 Upload files 방식으로.** GitHub 웹 에디터에 직접 타이핑하면 줄바꿈이 유실되고, "Cancel changes"가 확인창을 띄워 탭이 멈춥니다. 파일을 만들어 업로드하고 커밋하십시오.

## 이 저장소를 로컬로 가져오기

```bash
git clone https://github.com/EricSeokgon/tistory-blog-ops.git
cd tistory-blog-ops
```

### 최초 업로드 방법 (이력 보존)

> 배포된 `tistory-blog-ops.bundle`에는 커밋 이력이 들어 있습니다.

```bash
git clone tistory-blog-ops.bundle tistory-blog-ops
cd tistory-blog-ops
git remote set-url origin https://github.com/EricSeokgon/tistory-blog-ops.git
git push -u origin master
```

ZIP으로 받았다면:

```bash
unzip tistory-blog-ops.zip && cd blog-ops
git init && git add -A && git commit -m "초기 커밋"
git branch -M main
git remote add origin https://github.com/EricSeokgon/tistory-blog-ops.git
git push -u origin main
```
