# RAG 청킹 전략 완전정리 — Fixed·Recursive·Semantic·Late Chunking 선택 기준

검색이 이상하다고 리트리버를 바꾸고, 임베딩 모델을 올리고, 리랭커까지 붙였는데도 원하는 문단이 안 올라오는 상황. 로그를 열어보면 정답이 담긴 청크가 **문장 중간에서 잘려 있거나, 표 헤더와 데이터가 서로 다른 청크에 들어가 있는** 경우가 대부분입니다. 앞선 글에서 문서 구조 분석이 전처리의 시작점이라고 정리했는데, 그 구조를 실제로 청크 경계에 반영하는 단계가 오늘의 주제입니다.

## 핵심 요약

- 임베딩 모델은 **청크 단위로만 의미를 봅니다**. 청크 경계가 잘못되면 그 뒤의 어떤 검색 기법으로도 복구되지 않습니다.
- 청크 크기보다 **경계의 위치**가 중요합니다. 512토큰이 정답이 아니라, 512토큰을 **어디서 끊느냐**가 정답입니다.
- 실무 기본값은 **Recursive + 문서 구조 기반 하이브리드**입니다. Semantic Chunking은 비용 대비 효과가 문서 유형을 크게 탑니다.
- **Late Chunking**은 임베딩 순서를 뒤집어 청크에 문서 문맥을 주입하며, **추가 LLM 비용이 0**입니다.
- **Contextual Retrieval**은 LLM으로 문맥을 붙여 검색 실패율을 크게 낮추지만, **색인 시점의 비용과 재색인 부담**이 따라옵니다.

## 1. 청킹이 검색 품질을 결정하는 이유 — 임베딩의 시야는 청크가 전부다

RAG에서 임베딩 모델이 보는 것은 원본 문서가 아니라 **잘린 조각 하나**입니다. 그 조각 안에 판단 근거가 없으면 벡터는 엉뚱한 방향을 가리킵니다.

전형적인 실패는 세 가지 형태로 나타납니다.

- **문맥 소실** — `해당 요건을 충족하지 못하면 계약은 해지된다`라는 문장만 잘려 나오면, '해당 요건'이 무엇인지 벡터에 담기지 않습니다.
- **주제 혼입** — 하나의 청크에 서로 다른 두 절의 내용이 섞이면 벡터가 두 주제의 평균이 되어 어느 쪽 질문에도 잘 맞지 않습니다.
- **구조 파괴** — 표 헤더가 앞 청크에, 데이터 행이 뒤 청크에 들어가면 두 청크 모두 검색이 되지 않습니다.

> 첫 번째와 두 번째는 오버랩과 크기 조정으로 완화됩니다. 세 번째는 **파라미터로 해결되지 않고 전략 자체를 바꿔야** 합니다.

## 2. 첫 번째 결정 — 청크 크기와 오버랩은 무엇으로 정하는가

숫자를 먼저 고르지 말고 **제약 조건부터 역산**하는 것이 순서입니다.

- **임베딩 모델의 최대 입력 길이** — 이걸 넘기면 조용히 잘립니다. 잘린 뒷부분은 벡터에 반영되지 않습니다.
- **LLM 컨텍스트 예산** — Top-k 개의 청크를 넣어야 하므로 `청크 크기 × k`가 프롬프트 예산 안에 들어와야 합니다.
- **문서의 의미 단위 길이** — 법령은 조·항 단위가 짧고, 기술 문서는 섹션 단위가 깁니다.

실무에서 자주 쓰는 출발점은 다음과 같습니다.

| 문서 유형 | 청크 크기(토큰) | 오버랩 | 근거 |
| --- | --- | --- | --- |
| FAQ·QA 쌍 | 128~256 | 0 | 항목 자체가 완결된 단위 |
| 기술 문서·매뉴얼 | 512~1024 | 10~15% | 섹션 단위 설명이 길다 |
| 계약서·법령 | 256~512 | 10% | 조항 경계가 명확하다 |
| 논문·보고서 | 512~1024 | 15~20% | 단락 간 참조가 잦다 |
| 회의록·대화 로그 | 256~512 | 화자 단위 | 턴 경계를 넘지 않게 |

> 오버랩은 **문맥 소실에 대한 보험**이지 성능 개선 수단이 아닙니다. 20%를 넘기면 인덱스 크기와 중복 검색 결과만 늘고 Recall은 거의 오르지 않습니다.

## 3. 전략 1 — Fixed-size Chunking: 가장 단순하고 가장 자주 실패하는 방식

정해진 문자 수나 토큰 수로 기계적으로 자릅니다.

```python
def fixed_chunk(text: str, size: int = 1000, overlap: int = 100):
    chunks, start = [], 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        start = end - overlap
    return chunks
```

- **장점** — 구현이 즉시 되고, 청크 길이가 균일해 배치 처리와 비용 예측이 쉽습니다.
- **단점** — 문장·표·코드블록을 가리지 않고 자릅니다. 한국어는 조사가 붙어 있어 중간에 잘리면 의미 손상이 더 큽니다.

**프로토타입 단계에서만 쓰고, 운영 전에 반드시 교체해야 하는 방식**으로 취급하는 편이 안전합니다.

## 4. 전략 2 — Recursive Character Splitting: 구분자 계층으로 자르기

구분자를 **우선순위 목록**으로 두고, 큰 단위부터 시도하다가 크기를 못 맞추면 다음 구분자로 내려갑니다. 실무의 기본값입니다.

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=100,
    separators=["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
    length_function=len,
    keep_separator=True,
)
chunks = splitter.split_text(markdown_text)
```

핵심은 `separators` 목록을 **문서 유형에 맞게 다시 쓰는 것**입니다. 기본값을 그대로 쓰면 마크다운 헤딩이 일반 개행과 같은 취급을 받습니다.

- **한국어 문서** — `". "` 대신 `["다.\n", "다. ", "습니다. "]` 같은 종결어미 기반 구분자를 앞에 넣으면 문장 경계 정확도가 올라갑니다.
- **소스 코드** — 언어별 문법 구분자를 씁니다. `\nclass `, `\ndef `, `\nfunc ` 순서로 두면 함수 단위가 유지됩니다.
- **로그** — 타임스탬프 패턴을 첫 구분자로 두면 이벤트 단위가 보존됩니다. 단 이 클래스는 `is_separator_regex=False`(기본값)일 때 모든 구분자를 `re.escape`로 감싸므로, **정규식을 넣어도 문자 그대로 취급되어 절대 매칭되지 않습니다.** 정규식을 쓰려면 플래그를 함께 지정해야 합니다.

```python
log_splitter = RecursiveCharacterTextSplitter(
    chunk_size=800, chunk_overlap=0,
    separators=[r"\n\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", "\n\n", "\n", " ", ""],
    is_separator_regex=True,   # 없으면 위 패턴이 리터럴로 escape 되어 무력화된다
)
```

> 위 코드의 `chunk_size=800`은 `length_function=len` 때문에 **문자 수**입니다. 2장의 표와 체크리스트는 토큰 기준이므로 숫자를 그대로 옮기면 안 됩니다. 토큰 기준으로 자르려면 길이 함수를 토크나이저로 바꾸십시오.

```python
splitter = RecursiveCharacterTextSplitter.from_huggingface_tokenizer(
    tokenizer, chunk_size=512, chunk_overlap=64,
    separators=["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
)
# 또는: length_function=lambda t: len(tokenizer.encode(t))
```

> 구분자 목록의 마지막 `""`는 **어떤 구분자로도 크기를 못 맞췄을 때 강제로 자르는 안전장치**입니다. 이 항목이 실제로 자주 발동한다면 `chunk_size`가 문서의 의미 단위보다 작다는 신호입니다. 정규식 구분자는 조용히 실패하므로 이 발동 비율로 반드시 검증하십시오.

## 5. 전략 3 — Document-based Chunking: 구조를 그대로 경계로 쓰기

앞선 글에서 다룬 문서 구조 분석 결과가 있다면, **헤딩·표·목록 경계를 그대로 청크 경계로 쓰는 것**이 가장 비용 대비 효과가 큽니다.

```python
from langchain_text_splitters import MarkdownHeaderTextSplitter
from langchain_core.documents import Document   # Document는 core 패키지에 있다

header_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3")],
    strip_headers=False,
)
sections = header_splitter.split_text(markdown_text)

# 2단계: 섹션이 너무 길면 Recursive로 다시 쪼갠다
final_chunks = []
for sec in sections:
    if len(sec.page_content) <= 1200:
        final_chunks.append(sec)
    else:
        for sub in splitter.split_text(sec.page_content):
            final_chunks.append(
                Document(page_content=sub, metadata=sec.metadata)
            )
```

이 **2단계 구성(구조 우선 → 크기 보정)** 이 실무 기본형입니다. 여기에 메타데이터를 반드시 함께 저장합니다.

- `h1`/`h2`/`h3` 경로 — 검색 결과에 제목 맥락을 되돌려줍니다
- `page` / `source` — 인용 표기와 근거 추적에 필요합니다
- `element_type` — `table`, `code`, `list` 구분은 리랭킹과 필터링에 쓰입니다

**표는 절대 잘라서는 안 됩니다.** 표가 크기 한도를 넘으면 자르지 말고, 헤더를 각 조각에 복제해 넣거나 표 전체를 별도 청크로 승격시키는 편이 낫습니다.

```python
def split_table_with_header(rows: list[str], header: str, max_rows: int = 20):
    out = []
    for i in range(0, len(rows), max_rows):
        out.append(header + "\n" + "\n".join(rows[i:i + max_rows]))
    return out
```

## 6. 전략 4 — Semantic Chunking: 문장 임베딩 거리로 경계 찾기

문장을 하나씩 임베딩한 뒤, **인접 문장 간 코사인 거리가 급격히 벌어지는 지점**을 주제 전환으로 보고 자릅니다.

```python
import numpy as np

def semantic_chunk(sentences, embed_fn, percentile: int = 95, max_sents: int = 20):
    if len(sentences) < 2:                       # 빈 배열 percentile 예외 방지
        return [" ".join(sentences)] if sentences else []
    vecs = np.asarray(embed_fn(sentences), dtype=float)
    vecs = vecs / np.linalg.norm(vecs, axis=1, keepdims=True)
    dists = 1 - np.sum(vecs[:-1] * vecs[1:], axis=1)   # 인접 문장 코사인 거리
    threshold = np.percentile(dists, percentile)
    boundaries = {i for i, d in enumerate(dists) if d > threshold}

    chunks, cur = [], []
    for i, s in enumerate(sentences):
        cur.append(s)
        if i in boundaries or len(cur) >= max_sents or i == len(sentences) - 1:
            chunks.append(" ".join(cur))
            cur = []
    return chunks
```

> `percentile`은 **주제 전환을 탐지하는 임계값이 아니라, 경계 개수를 `(100−percentile)%`로 고정하는 손잡이**입니다. 실제 주제 전환이 10번인 문서든 1번인 문서든 경계 수는 거의 같게 나옵니다(문장 50개·`percentile=95`면 경계 2~3개). "문서마다 튜닝이 필요하다"는 말의 실체가 이것입니다. 또 거리 기준만으로는 청크 크기 상한이 없으므로 `max_sents`(또는 토큰 수) 상한을 반드시 함께 두어 임베딩 모델 입력 한도를 넘기지 않게 하십시오.

- **장점** — 헤딩이 없는 자유 서술형 문서(인터뷰 기록, 서술형 보고서)에서 의미 경계를 잘 잡습니다.
- **단점** — 색인 시점에 **문장 수만큼 임베딩 호출**이 발생합니다. 임계값(`percentile`)이 문서마다 최적값이 달라 튜닝 비용도 큽니다.
- **함정** — 이미 헤딩 구조가 잘 잡힌 문서에서는 구조 기반 분할 대비 개선이 거의 없습니다. 구조가 있는데 Semantic을 쓰는 건 **같은 정보를 비싸게 다시 추정하는 일**입니다.

> Semantic Chunking은 **구조가 없는 문서에 한정해서** 검토하십시오. 판단 기준은 단순합니다. 헤딩·번호·목록 마크업이 문서의 30% 이상을 덮고 있으면 구조 기반이 이깁니다.

## 7. 전략 5 — Late Chunking: 자르고 임베딩하는 순서를 뒤집는다

기존 파이프라인은 **자른 다음 임베딩**합니다. Late Chunking은 순서를 뒤집습니다.

1. 롱컨텍스트 임베딩 모델에 **문서 전체를 한 번에** 넣습니다
2. 풀링 전의 **토큰 단위 임베딩**을 받습니다
3. 그 상태에서 청크 경계를 적용해 **구간별로 평균 풀링**합니다

결과적으로 각 청크 벡터가 **문서 전체를 본 상태의 문맥**을 담게 됩니다. `해당 요건은…`으로 시작하는 청크도 앞 문단의 정보가 어텐션을 통해 이미 반영되어 있습니다.

```python
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

tok = AutoTokenizer.from_pretrained("jinaai/jina-embeddings-v3", trust_remote_code=True)
model = AutoModel.from_pretrained("jinaai/jina-embeddings-v3", trust_remote_code=True)

def late_chunk(text: str, spans: list[tuple[int, int]], max_len: int = 8192):
    """spans: 문자 오프셋 기준 청크 경계 목록"""
    enc = tok(text, return_tensors="pt", return_offsets_mapping=True,
              truncation=True, max_length=max_len)
    if enc["input_ids"].shape[1] >= max_len:
        raise ValueError("문서가 컨텍스트 한도를 넘었습니다. 먼저 문서를 나누십시오.")
    offsets = enc.pop("offset_mapping")[0]
    with torch.no_grad():
        token_emb = model(**enc).last_hidden_state[0]  # (seq_len, dim)

    out = []
    for s, e in spans:
        # 경계에 걸친 토큰도 포함되도록 '겹침' 조건을 쓴다
        idx = [i for i, (a, b) in enumerate(offsets) if b > a and a < e and b > s]
        if idx:
            out.append(token_emb[idx].mean(dim=0))
    if not out:
        raise ValueError("spans와 토큰 오프셋이 하나도 겹치지 않습니다.")
    return F.normalize(torch.stack(out), p=2, dim=-1)   # 코사인 인덱스에 넣으려면 필수
```

- **비용** — 추가 LLM 호출이 없습니다. 임베딩을 문서 단위로 한 번 돌리므로 오히려 호출 수가 줄어듭니다.
- **전제 조건** — **롱컨텍스트 임베딩 모델이 필수**입니다. 8K 토큰 이상을 처리하고 토큰 단위 임베딩을 꺼낼 수 있어야 합니다.
- **어댑터 주의** — `jina-embeddings-v3`는 태스크별 LoRA 어댑터 모델입니다. 위처럼 `AutoModel`을 직접 forward하면 **어댑터가 적용되지 않은 베이스 임베딩**이 나옵니다. 질의는 `encode(task="retrieval.query")`로 만들고 문서만 이 경로로 만드는 식의 혼용은 하지 마십시오. 양쪽 경로를 통일하거나 라이브러리가 제공하는 `late_chunking` 옵션을 쓰는 편이 안전합니다.
- **정규화 필수** — 평균 풀링 결과는 정규화되어 있지 않습니다. 코사인·내적 인덱스에 넣기 전에 L2 정규화하십시오.
- **한계** — 모델의 컨텍스트 한도를 넘는 문서는 결국 문서를 먼저 나눠야 하고, 그 경계를 넘는 문맥은 여전히 사라집니다. `truncation=True`만 걸면 초과분이 조용히 잘리므로 위처럼 예외로 승격시켜야 이 한계가 실제로 지켜집니다.

## 8. 전략 6 — Contextual Retrieval: LLM으로 청크마다 문맥을 붙인다

색인 시점에 **각 청크에 대해 "이 조각이 문서 안에서 무엇을 말하는지" 짧은 설명을 LLM으로 생성**해 앞에 붙입니다.

```python
CONTEXT_PROMPT = """<document>
{doc}
</document>

다음은 위 문서에서 발췌한 조각입니다.
<chunk>
{chunk}
</chunk>

이 조각이 문서 전체에서 어떤 맥락에 위치하는지 검색에 도움이 되도록
짧고 간결하게 설명하십시오. 설명만 출력하십시오."""

def contextualize(doc: str, chunk: str, llm) -> str:
    ctx = llm.complete(CONTEXT_PROMPT.format(doc=doc, chunk=chunk))
    return f"{ctx.strip()}\n\n{chunk}"
```

Anthropic이 공개한 실측에서는 Top-20 검색 실패율이 다음과 같이 움직였습니다.

| 구성 | 실패율 | 개선 |
| --- | --- | --- |
| 기본(임베딩만) | 5.7% | — |
| + Contextual Embeddings | 3.7% | 35% 감소 |
| + Contextual BM25 | 2.9% | 49% 감소 |
| + 리랭커(Top-150 → 20) | 1.9% | 67% 감소 |

생성되는 문맥은 보통 **50~100 토큰**이며, 프롬프트 캐싱을 적용하면 색인 비용은 **문서 100만 토큰당 약 $1** 수준으로 보고됐습니다.

- **주의 1** — 원문 문서를 매 청크마다 프롬프트에 넣으므로 **프롬프트 캐싱이 없으면 비용이 급증**합니다.
- **주의 2** — 문서가 갱신되면 해당 문서의 모든 청크를 **다시 생성해야** 합니다. 재색인 파이프라인을 먼저 설계하십시오.
- **주의 3** — LLM이 생성한 문맥이 틀리면 **틀린 문맥이 그대로 벡터에 박힙니다.** 샘플 검수 절차가 필요합니다.

## 9. 선택 기준 — 결정 순서

전략을 나열해놓고 고르는 것이 아니라, **순서대로 통과시키는 방식**이 실패가 적습니다.

```
1) 문서에 구조 마크업(헤딩·표·목록)이 있는가?
   YES → Document-based(구조 우선) + Recursive(크기 보정)   ← 기본값
   NO  → 2)로

2) 롱컨텍스트 임베딩 모델을 쓸 수 있는가?
   YES → Late Chunking                                     ← 비용 0의 개선
   NO  → 3)로

3) 검색 실패가 "문맥 소실"에서 오는가? (로그로 확인)
   YES → Contextual Retrieval (+ Hybrid + 리랭커)
   NO  → Recursive 파라미터 튜닝으로 충분

4) 여전히 부족한가?
   → Semantic Chunking 검토 (구조 없는 서술형 문서 한정)
```

전략별 성격을 한 표로 정리하면 다음과 같습니다.

| 전략 | 색인 비용 | 구현 난이도 | 문맥 보존 | 적합한 문서 |
| --- | --- | --- | --- | --- |
| Fixed | 최저 | 최저 | 낮음 | 프로토타입 |
| Recursive | 최저 | 낮음 | 중간 | 범용 기본값 |
| Document-based | 낮음 | 중간 | 높음 | 마크다운·HTML·PDF 변환본 |
| Semantic | 중간 | 중간 | 중간~높음 | 구조 없는 서술형 |
| Late Chunking | 낮음 | 높음 | 높음 | 긴 문서, 대명사·참조 많은 문서 |
| Contextual Retrieval | 높음 | 중간 | 최고 | 갱신이 드물고 정확도가 중요한 문서 |

> 세 가지 이상을 동시에 적용하지 마십시오. **한 번에 하나만 바꾸고 Recall@k와 nDCG를 측정**해야 무엇이 효과를 냈는지 알 수 있습니다.

## 10. 흔한 실수

- **청크 크기를 먼저 정하고 시작한다** — 크기는 결과이지 입력이 아닙니다. 임베딩 모델 한도와 문서 의미 단위에서 역산해야 합니다.
- **오버랩을 늘려 문제를 덮는다** — 오버랩 30%는 인덱스를 1.3배로 키우고 중복 결과를 늘릴 뿐, 경계가 틀린 문제를 고치지 못합니다.
- **표와 코드블록에 같은 규칙을 적용한다** — 이 둘은 크기 기준 분할 대상에서 제외하고 별도 경로로 처리해야 합니다.
- **메타데이터를 저장하지 않는다** — 헤딩 경로가 없으면 검색 결과를 사람이 검수할 수도, 인용을 붙일 수도 없습니다.
- **평가 없이 전략을 바꾼다** — 골든 QA 셋 없이 바꾸면 개선인지 퇴행인지 알 수 없습니다.
- **한국어 문장 경계를 영어 규칙으로 자른다** — `. ` 기준 분할은 `3.5%`, `1. 개요` 같은 패턴에서 오작동합니다.
- **임베딩 모델을 바꾸고 청킹은 그대로 둔다** — 최대 입력 길이가 달라지면 청크 크기도 다시 계산해야 합니다.
- **문자 수 기준 설정을 토큰 수로 착각한다** — `length_function=len`이면 `chunk_size`는 문자 수입니다. 한국어는 문자와 토큰의 비가 문서마다 크게 흔들립니다.
- **정규식 구분자를 플래그 없이 넣는다** — `is_separator_regex=True`가 없으면 패턴이 리터럴로 escape 되어 **에러 없이 무시**됩니다.

## 실전 체크리스트

- 임베딩 모델의 최대 입력 토큰 수를 확인하고 청크 크기를 그 아래로 잡았다.
- `청크 크기 × Top-k`가 LLM 컨텍스트 예산 안에 들어오는지 계산했다.
- 문서에 구조 마크업이 있는지 확인하고 구조 기반 분할을 먼저 적용했다.
- 표·코드블록을 크기 기준 분할 대상에서 제외했다.
- 헤딩 경로·출처·페이지를 메타데이터로 저장했다.
- 한국어 종결어미 기반 구분자를 `separators` 앞쪽에 배치했다.
- 길이 함수가 문자 기준인지 토큰 기준인지 확인하고 `chunk_size` 단위를 일치시켰다.
- 정규식 구분자를 썼다면 `is_separator_regex=True`를 함께 지정했다.
- 오버랩을 20% 이하로 유지했다.
- 골든 QA 셋을 만들고 전략 변경 전후로 Recall@k·nDCG를 측정했다.
- 강제 분할(마지막 빈 구분자)이 발동한 비율을 로그로 확인했다.
- Contextual Retrieval을 쓴다면 프롬프트 캐싱과 재색인 경로를 먼저 설계했다.

## 마치며

청킹은 **검색 파이프라인에서 가장 먼저 실행되고 가장 나중에 의심받는 단계**입니다. 리트리버와 리랭커는 이미 만들어진 청크 안에서만 최선을 다할 수 있고, 청크에 정답이 온전히 담겨 있지 않으면 어떤 기법도 그것을 복원하지 못합니다.

전략을 늘리기 전에 **자신의 문서가 구조를 가지고 있는지부터 확인**하십시오. 대부분의 개선은 화려한 기법이 아니라, 이미 문서 안에 있던 헤딩과 표 경계를 청크 경계로 옮기는 데서 나왔습니다.

## FAQ

**Q1. 청크 크기 512와 1024 중 뭐가 낫나요?**
문서와 질문 유형에 따라 갈립니다. 사실 조회형 질문(누가·언제·얼마)이 많으면 작은 청크가, 설명·비교형 질문이 많으면 큰 청크가 유리합니다. 두 설정으로 같은 골든 셋을 돌려 Recall@10을 비교하는 것이 가장 빠릅니다.

**Q2. 오버랩을 0으로 두면 안 되나요?**
FAQ나 QA 쌍처럼 **항목 자체가 완결된 문서**라면 0이 맞습니다. 서술형 문서에서 0으로 두면 경계에 걸친 문장이 어느 청크에서도 온전히 검색되지 않습니다.

**Q3. Late Chunking과 Contextual Retrieval을 같이 써도 되나요?**
기술적으로는 가능합니다. 다만 둘 다 같은 문제(청크의 문맥 결핍)를 겨냥하므로 효과가 중첩되어 개선 폭이 작습니다. 비용이 0에 가까운 Late Chunking을 먼저 적용하고, 그래도 부족할 때 Contextual Retrieval을 얹는 순서를 권합니다.

**Q4. 문서가 계속 갱신되는데 청킹 전략을 어떻게 유지하나요?**
문서 단위로 해시를 저장하고, 변경된 문서만 재청킹·재색인하는 파이프라인이 필요합니다. Contextual Retrieval처럼 색인 시점 비용이 큰 전략은 갱신 빈도가 높은 문서에는 적합하지 않습니다.

## 참고 자료

- Jina AI — Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models (arXiv:2409.04701)
- Anthropic — Introducing Contextual Retrieval
- LangChain — Text Splitters 공식 문서

## 함께 읽으면 좋은 글

- RAG 전처리의 진짜 시작점, 문서 구조 분석 - 한컴 데이터 로더로 보고서 PDF를 직접 돌려봤습니다
- RAG Hybrid Search 실전 가이드 — Dense·BM25·RRF로 검색 정확도 높이기
- RAG Reranker 완전정리 — Bi-Encoder·Cross-Encoder 2단계 검색 설계
- 임베딩 모델 선택과 평가 — Cosine·Recall@k·MRR·nDCG 실전 기준

---

**태그(9개):** LateChunking, LLM엔지니어링, RAG, RAG전처리, SemanticChunking, 검색품질, 문서분할, 임베딩, 청킹전략
