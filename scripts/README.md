# scripts

## tistory-inject.js

티스토리 글쓰기/수정 페이지의 **브라우저 콘솔**에 붙여넣어 쓰는 스크립트입니다.
마크다운 → HTML 변환 후 TinyMCE에 주입하므로, 마크다운 에디터의 저장 누락 문제를 우회합니다.

배경과 원인은 [`../docs/tistory-publishing.md`](../docs/tistory-publishing.md)를 먼저 읽으십시오.

### 사용법

```js
// 1. 글쓰기/수정 페이지에서 파일 전체를 콘솔에 붙여넣기
// 2. 초기화 (다이얼로그 무력화 + marked.js 로드)
await T.setup()

// 3. 제목
T.title('파킹통장·CMA·MMF 완전정리 — 투자 대기자금 굴리는 법 (2026)')

// 4. 본문 (백틱 문자열. 내부 백틱은 \` 로 escape)
T.body(`
"투자할 돈은 모아뒀는데..." 로 시작하는 마크다운 전문
`)

// 5. 카테고리는 화면에서 직접 선택 (자동화가 불안정합니다)
T.currentCategory()   // 선택 결과 확인

// 6. 태그
T.tags(['CMA','MMF','단기채ETF','대기자금','비상금','예금자보호','재테크','주린이','파킹통장'])
T.currentTags()       // 확인

// 7. 발행
T.done()              // 완료 버튼 → 8~10초 대기
T.panelState()        // 비공개 선택 여부 확인
T.savePrivate()       // 비공개 저장

// 8. 발행된 글 URL로 이동한 뒤 검증 (생략 금지)
T.verify()
// → { textLength: 4518, h2: 12, tables: 2, codeBlocks: 0, verdict: 'OK' }
```

### 주의

- `T.savePublic()`은 **검토를 마친 뒤에만** 쓰십시오. 기본은 비공개입니다.
- `T.verify()`를 건너뛰면 빈 글을 발행하고도 알 수 없습니다.
- 태그 입력이 실패하면 화면에서 직접 입력하십시오. 반환값으로 확인 가능합니다.
