/**
 * tistory-inject.js
 * ------------------------------------------------------------------
 * 티스토리 글쓰기/수정 페이지의 브라우저 콘솔에 붙여넣어 사용합니다.
 * 마크다운을 HTML로 변환해 TinyMCE에 주입하는 방식이므로
 * 마크다운 모드의 저장 누락 문제(README/docs 참고)를 우회합니다.
 *
 * 사용 순서
 *   1) https://{블로그}.tistory.com/manage/newpost/        (신규)
 *      https://{블로그}.tistory.com/manage/newpost/{글번호}  (수정)
 *   2) 개발자도구 콘솔에서 이 파일 전체를 붙여넣고 실행
 *   3) await T.setup()
 *   4) T.title('제목')
 *   5) T.body(`# 마크다운 ...`)          ← 백틱 문자열. 내부 백틱은 \` 로 escape
 *   6) 카테고리는 화면에서 직접 선택 (드롭다운 자동화는 불안정)
 *   7) T.tags(['태그1','태그2', ...])    ← 실패하면 화면에서 직접 입력
 *   8) T.done()  →  (8~10초 대기)  →  T.savePrivate()
 *   9) T.verify() 로 실제 글 URL에서 본문 길이 확인 (별도 탭)
 * ------------------------------------------------------------------
 */

window.T = (() => {
  const MARKED_CDN =
    'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js';

  /** 네이티브 setter로 React 제어 input/textarea에 값을 넣는다 */
  function nativeSet(el, value) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function btn(label) {
    return [...document.querySelectorAll('button')].find(
      (b) => b.offsetParent && b.textContent.trim() === label
    );
  }

  return {
    /** 다이얼로그 무력화 + marked.js 로드. 페이지 진입 직후 반드시 먼저 실행 */
    async setup() {
      window.confirm = () => true;
      window.alert = () => undefined;
      window.prompt = () => null;
      window.onbeforeunload = null;

      if (typeof window.marked === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = MARKED_CDN;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      const ed = tinymce.get('editor-tistory');
      return {
        marked: typeof window.marked,
        editorReady: !!ed,
        currentTitle: (document.getElementById('post-title-inp') || {}).value,
        currentBodyLen: ed ? ed.getContent().length : null,
      };
    },

    /** 제목 설정 */
    title(text) {
      const el = document.getElementById('post-title-inp');
      if (!el) throw new Error('제목 입력란(#post-title-inp)을 찾을 수 없습니다.');
      nativeSet(el, text);
      return el.value;
    },

    /**
     * 본문 설정 — 마크다운 문자열 또는 줄 배열을 받는다.
     * ⚠️ 마크다운 모드 CodeMirror에 넣으면 저장되지 않으므로 반드시 이 함수를 쓸 것.
     */
    body(markdown) {
      const md = Array.isArray(markdown) ? markdown.join('\n') : markdown;
      const ed = tinymce.get('editor-tistory');
      if (!ed) throw new Error('TinyMCE 인스턴스(editor-tistory)가 없습니다.');
      ed.setContent(window.marked.parse(md));
      tinymce.triggerSave();
      return {
        htmlLen: ed.getContent().length,
        textareaLen: document.getElementById('editor-tistory').value.length,
      };
    },

    /**
     * 태그 입력 — 각 태그마다 Enter가 필요하다.
     * 프로그램 입력이 막히는 환경에서는 실패할 수 있으므로 반환값을 확인하고,
     * 안 되면 화면에서 직접 입력하십시오.
     */
    tags(list) {
      const el = document.getElementById('tagText');
      if (!el) throw new Error('태그 입력란(#tagText)을 찾을 수 없습니다.');
      el.scrollIntoView({ block: 'center' });
      el.focus();
      for (const tag of list) {
        nativeSet(el, tag);
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            bubbles: true,
          })
        );
      }
      return this.currentTags();
    },

    /** 현재 붙어 있는 태그 목록 */
    currentTags() {
      return [...document.querySelectorAll('a, span, li')]
        .map((e) => e.textContent.trim())
        .filter((t) => /^#\S+$/.test(t) && t !== '#태그입력');
    },

    /** 현재 선택된 카테고리 */
    currentCategory() {
      const el = document.querySelector('.btn-category');
      return el ? el.textContent.trim() : null;
    },

    /** 완료 버튼 — 발행 패널을 연다. 이후 8~10초 대기 필요 */
    done() {
      const b = btn('완료');
      if (!b) throw new Error('완료 버튼을 찾을 수 없습니다.');
      b.click();
      return '완료 클릭 — 8~10초 후 savePrivate() 호출';
    },

    /** 발행 패널 상태 확인 (open20=공개, open15=공개보호, open0=비공개) */
    panelState() {
      return {
        radios: [...document.querySelectorAll('input[type=radio]')]
          .filter((r) => /^open/.test(r.id))
          .map((r) => ({ id: r.id, checked: r.checked })),
        buttons: [...document.querySelectorAll('button')]
          .filter((b) => b.offsetParent && /발행|저장|취소/.test(b.textContent))
          .map((b) => b.textContent.trim()),
      };
    },

    /** 비공개로 저장 */
    savePrivate() {
      const radio = document.getElementById('open0');
      if (radio && !radio.checked) radio.click();
      const b = btn('비공개 저장');
      if (!b)
        throw new Error(
          '비공개 저장 버튼이 없습니다. 발행 패널이 열렸는지, 비공개가 선택됐는지 확인하십시오.'
        );
      b.click();
      return '비공개 저장 클릭 — 8~15초 후 리다이렉트';
    },

    /** ⚠️ 공개 발행. 검토를 마친 뒤에만 사용하십시오 */
    savePublic() {
      const radio = document.getElementById('open20');
      if (radio && !radio.checked) radio.click();
      const b = btn('공개 발행');
      if (!b) throw new Error('공개 발행 버튼이 없습니다.');
      b.click();
      return '공개 발행 클릭';
    },

    /** 발행된 글 페이지에서 실행 — 본문이 실제로 저장됐는지 검증 */
    verify() {
      const a =
        document.querySelector('.tt_article_useless_p_margin') ||
        document.querySelector('.entry-content') ||
        document.querySelector('article');
      const text = a ? a.innerText : '';
      return {
        title: document.title,
        textLength: text.length,
        h2: document.querySelectorAll('article h2').length,
        tables: document.querySelectorAll('article table').length,
        codeBlocks: document.querySelectorAll('article pre').length,
        verdict: text.length > 500 ? 'OK' : '⚠️ 본문이 비어 있거나 너무 짧습니다',
      };
    },
  };
})();

console.log('T 로드 완료. 먼저 `await T.setup()` 을 실행하십시오.');
