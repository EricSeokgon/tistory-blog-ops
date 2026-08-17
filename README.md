# tistory-blog-ops

> **저장소:** https://github.com/EricSeokgon/tistory-blog-ops (Private)

티스토리 블로그 2개(`ericreview` · `hadesyi`)의 **콘텐츠 기획 → 작성 → 검증 → 자동 발행** 전 과정을 기록한 작업 저장소입니다.

> **이 저장소만 열면 이어서 작업할 수 있도록** 구성했습니다. 새 세션을 시작할 때 AI 에이전트에게 이 README와 [`STATE.md`](STATE.md)를 먼저 읽히십시오.

---

## 대상 블로그

| 블로그 | 주소 | 성격 | 글 수 |
| --- | --- | --- | --- |
| 주식 한 입 | https://ericreview.tistory.com | 주식 투자 입문 (초보 교육) | 103 |
| HadesYI Dev Story | https://hadesyi.tistory.com | 개발 · AI/LLM 엔지니어링 | 406 |

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
│   └── fact-check-log.md           발행 전 사실 검증 18건 기록
├── posts/
│   ├── ericreview/                 발행 완료 원고 3편
│   └── hadesyi/                    발행 완료 원고 3편
└── scripts/
    ├── tistory-inject.js           브라우저 콘솔용 본문 주입 스크립트
    └── README.md                   스크립트 사용법
```

---

## 빠르게 파악하기

**"지금 어디까지 했나?"** → [`STATE.md`](STATE.md)

**"어떻게 하는 건가?"** → [`PLAYBOOK.md`](PLAYBOOK.md)

**"왜 본문이 안 들어갔었나?"** → [`docs/tistory-publishing.md`](docs/tistory-publishing.md)

**"다음에 뭘 쓰지?"** → [`backlog.md`](backlog.md)

**"제일 급한 게 뭔가?"** → [`docs/traffic-and-seo.md`](docs/traffic-and-seo.md) — 약 500편을 썼는데 검색 유입이 사실상 0입니다. 콘텐츠 생산보다 **검색 노출**이 병목입니다.

---

## 새 세션 시작 프롬프트 (복사용)

```
이 저장소(tistory-blog-ops)의 README.md, STATE.md, PLAYBOOK.md를 먼저 읽어줘.
그리고 docs/ 아래 문서로 문체 규격과 티스토리 발행 방법을 파악한 뒤,
STATE.md의 "다음 할 일"부터 이어서 진행해줘.
```

---

## 원칙

- **발행은 항상 비공개(`비공개 저장`)부터.** 렌더링을 눈으로 확인한 뒤 공개로 전환합니다.
- **사실 검증 없이 발행하지 않습니다.** 특히 세법·규정·수치는 1차 출처로 교차 확인합니다 (`docs/fact-check-log.md` 참고).
- **하루에 여러 편을 몰아서 공개하지 않습니다.** 1~2일 간격을 권장합니다.
- 원고의 **정본은 이 저장소**입니다. 티스토리에서 수정했다면 여기에도 반영하십시오.

---

## 이 저장소를 로컬로 가져오기

```bash
git clone https://github.com/EricSeokgon/tistory-blog-ops.git
cd tistory-blog-ops
```

## 최초 업로드 방법 (이력 보존)

배포된 `tistory-blog-ops.bundle`에는 커밋 이력이 들어 있습니다.

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
