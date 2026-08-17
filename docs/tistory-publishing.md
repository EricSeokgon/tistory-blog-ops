# 티스토리 자동 발행 방법

브라우저 자동화로 티스토리에 글을 올릴 때 **반드시 알아야 하는 함정과 검증된 절차**입니다.

---

## ⚠️ 가장 중요한 함정 — 마크다운 모드는 프로그램 입력이 저장되지 않는다

### 증상

에디터를 **마크다운 모드**로 전환하고 CodeMirror에 값을 넣으면,

- 화면에는 본문이 정상적으로 보이고
- `cm.getValue().length`도 정확한 값을 반환하지만
- **저장하면 본문이 통째로 비어 있습니다.**

제목·카테고리·태그는 정상 저장되기 때문에 겉보기엔 성공한 것처럼 보입니다. 발행된 글을 실제로 열어보기 전에는 알아채기 어렵습니다.

### 원인

티스토리의 마크다운 에디터는 CodeMirror를 **React 제어 컴포넌트**(`ReactCodemirror`)로 감싸고 있습니다. `cm.setValue()`는 DOM만 바꿀 뿐 React state를 갱신하지 못하고, 저장 payload는 React state에서 만들어집니다.

```js
// ❌ 이렇게 하면 안 됨 — 화면엔 보이지만 저장되지 않는다
const cm = [...document.querySelectorAll('.CodeMirror')]
  .find(e => e.className.includes('markdown')).CodeMirror;
cm.setValue(markdown);
```

### 해결 — 기본모드 + TinyMCE에 HTML 주입

마크다운을 **브라우저에서 HTML로 변환**한 뒤, 티스토리 본 에디터(TinyMCE)에 직접 넣습니다. TinyMCE의 `setContent()` + `triggerSave()`는 저장 payload에 정상 반영됩니다.

```js
// ✅ 검증된 방법
await new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js';
  s.onload = res; s.onerror = rej;
  document.head.appendChild(s);
});

const ed = tinymce.get('editor-tistory');
ed.setContent(marked.parse(markdownString));
tinymce.triggerSave();
```

주입 직후 티스토리가 자체 속성(`data-ke-size`, `data-ke-align`)을 붙여줍니다. 이게 보이면 제대로 들어간 것입니다.

**보존되는 것:** 헤딩 · 굵게/기울임 · 목록 · 표 · 인용문 · 코드블록(` ``` `) · 링크 — 전부 정상 렌더링됨을 6편으로 확인했습니다.

---

## 전체 절차

### 0. 사전 준비

- 티스토리에 **카카오 계정으로 로그인**된 브라우저 (AI가 대신 로그인하지 않습니다)
- 글 작성: `https://{블로그}.tistory.com/manage/newpost/`
- 글 수정: `https://{블로그}.tistory.com/manage/newpost/{글번호}`

### 1. 페이지 진입 후 다이얼로그 무력화

에디터 모드 전환 등에서 브라우저 기본 `confirm()`이 뜨면 **렌더러가 멈춰 자동화가 완전히 죽습니다.** 진입 직후 반드시 무력화하십시오.

```js
window.confirm = () => true;
window.alert = () => undefined;
window.prompt = () => null;
window.onbeforeunload = null;   // 페이지 이탈 경고도 제거
```

> 이걸 빼먹고 모드 전환을 누르면 페이지가 응답하지 않게 되고, 사용자가 브라우저에서 직접 확인창을 눌러줘야 복구됩니다.

### 2. 제목 입력

React 제어 textarea이므로 **네이티브 setter + 이벤트 디스패치**가 필요합니다.

```js
const el = document.getElementById('post-title-inp');
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  .set.call(el, title);
el.dispatchEvent(new Event('input',  { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

### 3. 본문 주입

위의 TinyMCE 방식을 사용합니다. 마크다운은 **줄 배열로 만들어 `join('\n')`** 하는 편이 이스케이프 사고가 적습니다.

### 4. 카테고리 선택

`.btn-category` 드롭다운을 클릭한 뒤 원하는 항목을 클릭합니다.

```js
// 선택 결과 확인
document.querySelector('.btn-category').textContent
// → "카테고리 선택실전 투자 노하우더보기"
```

> **주의:** 클릭을 연달아 빠르게 보내면 드롭다운이 열렸다 바로 닫힙니다. 클릭 사이에 **2초 이상** 두고, 열렸는지 스크린샷이나 DOM으로 확인한 뒤 항목을 클릭하십시오.

### 5. 태그 입력

`#tagText` 입력란에 **한 개씩 입력하고 Enter**를 눌러야 태그로 확정됩니다.

```js
document.getElementById('tagText').scrollIntoView({ block: 'center' });
// 이후 실제 키 입력(type + Enter)을 태그 수만큼 반복
```

### 6. 발행

```js
// 완료 버튼
[...document.querySelectorAll('button')]
  .find(x => x.offsetParent && x.textContent.trim() === '완료').click();

// (8~10초 대기 — 발행 패널 슬라이드 애니메이션)

// 공개 범위 라디오: open20=공개, open15=공개(보호), open0=비공개
// 마지막 설정을 기억하므로 이미 비공개면 그대로 두면 됨

// 저장 버튼 — 라벨이 선택에 따라 "공개 발행" / "비공개 저장"으로 바뀜
[...document.querySelectorAll('button')]
  .find(x => x.offsetParent && x.textContent.trim() === '비공개 저장').click();
```

### 7. 검증 (생략 금지)

발행 후 **실제 글 URL을 열어 본문 길이를 확인**하십시오. 이 단계를 건너뛰면 빈 글을 발행하고도 모릅니다.

```js
const a = document.querySelector('.tt_article_useless_p_margin')
       || document.querySelector('article');
JSON.stringify({
  len:    a.innerText.length,
  h2:     document.querySelectorAll('article h2').length,
  tables: document.querySelectorAll('article table').length,
  pre:    document.querySelectorAll('article pre').length,
});
```

원고의 헤딩·표·코드블록 개수와 맞아떨어져야 합니다.

---

## 자동화 안정성 팁

| 상황 | 대처 |
| --- | --- |
| 좌표 클릭이 빗나감 | 창 크기가 중간에 바뀝니다. 좌표 대신 `button.click()`을 JS로 직접 호출하십시오 |
| 드롭다운이 안 열림 | 클릭 간격을 2초 이상 두고, 열림 여부를 확인한 뒤 다음 클릭 |
| 발행 후 화면이 안 넘어감 | 8~15초 걸립니다. 넉넉히 대기하십시오 |
| 페이지가 완전히 멈춤 | 네이티브 다이얼로그입니다. 사용자가 직접 눌러야 복구됩니다 |
| 대기 시간 상한 | 자동화 도구의 `wait`는 보통 10초가 상한입니다. 더 필요하면 나눠서 호출 |

---

## 참고 — 발행 관련 DOM 요약

| 요소 | 셀렉터 |
| --- | --- |
| 제목 | `#post-title-inp` (textarea) |
| 본문 에디터 | `tinymce.get('editor-tistory')` / `#editor-tistory` (textarea) |
| 마크다운 CM | `.CodeMirror.cm-s-tistory-markdown` (**쓰지 말 것**) |
| HTML CM | `.CodeMirror.cm-s-tistory-html` |
| 카테고리 | `.btn-category` |
| 태그 | `#tagText` |
| 모드 전환 | 우측 상단 `기본모드 ▾` 버튼 → `기본모드` / `마크다운` / `HTML` |
