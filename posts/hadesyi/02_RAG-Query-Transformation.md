# RAG Query Transformation 실전 가이드 — Multi-Query·HyDE·Step-back으로 검색 실패 줄이기

문서는 분명히 인덱스에 들어가 있는데 검색이 안 되는 경우가 있습니다. 로그를 열어보면 사용자는 `연차 며칠 남았어요?`라고 물었는데 문서에는 `연차유급휴가 잔여일수 산정 기준`이라고 적혀 있습니다. 청킹과 리랭커를 손봐도 이 간극은 줄지 않습니다. 문제가 문서 쪽이 아니라 **질문 쪽**에 있기 때문입니다.

## 핵심 요약

- 검색 실패의 상당수는 인덱스 문제가 아니라 **사용자 질문과 문서 어휘의 불일치**에서 발생합니다.
- Query Transformation은 **검색 직전에 질문을 다시 쓰는 단계**이며, 인덱스를 건드리지 않고 적용할 수 있는 유일한 개선 축입니다.
- 기법마다 **겨냥하는 실패 유형이 다릅니다**. 전부 켜는 것이 아니라 로그로 실패 유형을 먼저 분류해야 합니다.
- 모든 기법은 **LLM 호출 1회 이상과 지연시간을 추가**합니다. TTFT 예산을 먼저 정하고 그 안에서 선택하십시오.
- 여러 질의를 병렬 검색했다면 결과 병합은 **RRF**로 처리하는 것이 점수 스케일 문제를 피하는 가장 안전한 방법입니다.

## 1. 검색이 실패하는 지점은 질문이다 — 다섯 가지 불일치

Query Transformation을 붙이기 전에, **어떤 불일치인지 분류**하는 것이 먼저입니다. 유형이 다르면 처방도 다릅니다.

- **어휘 불일치** — 구어체 질문 vs 문어체·전문용어 문서. `연차` vs `연차유급휴가`
- **문맥 결핍** — 멀티턴 대화에서 대명사만 남은 질문. `그건 얼마인데요?`
- **추상도 불일치** — 질문은 구체적인데 답은 일반 원칙에 있음. `A제품 반품되나요?` vs `반품 규정 총칙`
- **복합 질문** — 한 문장에 두 개 이상의 검색이 필요함. `A와 B의 차이와 각각의 비용은?`
- **범위 미지정** — 필터로 좁혀야 할 조건이 자연어에 섞여 있음. `작년 3분기 보고서에서…`

| 실패 유형 | 처방 | 추가 LLM 호출 |
| --- | --- | --- |
| 어휘 불일치 | Multi-Query, HyDE | 1회 |
| 문맥 결핍 | Query Rewriting | 1회 |
| 추상도 불일치 | Step-back Prompting | 1회 |
| 복합 질문 | Query Decomposition | 1회 + 서브질의 수만큼 검색 |
| 범위 미지정 | Metadata Filter 추출 | 1회(구조화 출력) |

> 로그에 **질문 원문·생성된 질의·Top-k 문서 ID·최종 인용 여부**를 남기지 않으면 이 분류 자체가 불가능합니다. 기법을 붙이기 전에 로깅부터 확인하십시오.

## 2. 진단 — 무엇을 고쳐야 하는지 판정하는 절차

기법을 고르기 전에 세 가지를 측정합니다.

1. **Top-50 안에 정답이 이미 들어오는가** — 들어오는데 Top-5가 나쁘면 이것은 검색 문제가 아니라 **리랭킹 문제**입니다. Query Transformation으로 해결되지 않습니다.
2. **BM25 단독 결과와 Dense 단독 결과가 얼마나 겹치는가** — 겹침이 매우 낮으면 어휘 불일치가 큽니다. Hybrid Search가 먼저입니다.
3. **질문을 사람이 문서 용어로 바꿔 쓰면 검색되는가** — 된다면 어휘 불일치가 확정됩니다. 여기서 Query Transformation의 기대 효과가 가장 큽니다.

```python
def diagnose(golden_set, retriever):
    stats = {"hit@5": 0.0, "hit@50": 0.0, "recall@50": 0.0, "manual_rewrite_hit@5": 0.0}
    for q, gold_ids, manual_q in golden_set:
        top50 = [d.id for d in retriever.search(q, k=50)]
        stats["hit@5"]  += float(any(g in top50[:5] for g in gold_ids))
        stats["hit@50"] += float(any(g in top50     for g in gold_ids))
        stats["recall@50"] += len(set(gold_ids) & set(top50)) / len(gold_ids)
        top5_manual = [d.id for d in retriever.search(manual_q, k=5)]
        stats["manual_rewrite_hit@5"] += float(any(g in top5_manual for g in gold_ids))
    n = len(golden_set)
    return {k: v / n for k, v in stats.items()}
```

`any()`로 재는 값은 Recall이 아니라 **Hit Rate@k(정답이 하나라도 들어왔는가)** 입니다. 정답 문서가 여러 개인 골든 셋에서는 Recall보다 값이 크게 나오므로 이름을 분리해 두어야 합니다.

`hit@50`은 높은데 `hit@5`가 낮다면 리랭커로, `manual_rewrite_hit@5`만 크게 높다면 Query Transformation으로 갑니다.

## 3. 기법 1 — Query Rewriting: 대화 문맥을 담아 독립 질문으로

멀티턴 챗봇에서 **가장 먼저 붙여야 하는 기법**입니다. 이전 대화를 참조해 현재 질문을 스스로 완결된 문장으로 다시 씁니다.

```python
REWRITE_PROMPT = """이전 대화를 참고하여, 마지막 사용자 질문을 
검색에 쓸 수 있는 독립적인 질문 한 문장으로 다시 쓰십시오.
대화에 없는 정보를 추가하지 마십시오. 질문만 출력하십시오.

<대화>
{history}
</대화>

마지막 질문: {question}"""

def rewrite(history: str, question: str, llm) -> str:
    return llm.complete(
        REWRITE_PROMPT.format(history=history, question=question)
    ).strip()
```

- 대화 이력은 **최근 3~5턴으로 제한**합니다. 전체를 넣으면 오래된 주제로 질문이 오염됩니다.
- 첫 턴이거나 대명사가 없으면 **리라이팅을 건너뛰는 분기**를 두십시오. 불필요한 LLM 호출과 의미 변형을 막습니다.

> 리라이팅 결과는 반드시 로그에 남기십시오. 사용자가 "엉뚱한 답을 준다"고 신고할 때, 원인의 상당수가 **리라이팅 단계에서 질문이 바뀐 것**입니다.

## 4. 기법 2 — Multi-Query: 한 질문을 여러 각도로 펼친다

하나의 질문을 **표현이 다른 여러 질의로 확장**해 각각 검색하고, 결과를 합칩니다. 어휘 불일치에 대한 가장 직관적인 처방입니다.

```python
MULTI_QUERY_PROMPT = """다음 질문을 검색용으로 서로 다른 표현의 
질문 4개로 바꿔 쓰십시오. 전문용어형·구어체형·상위개념형을 
각각 포함하십시오. 한 줄에 하나씩, 질문만 출력하십시오.

질문: {question}"""

import re

def multi_query(question: str, llm) -> list[str]:
    raw = llm.complete(MULTI_QUERY_PROMPT.format(question=question))
    # "1. " "2) " "- " "• " 등 LLM이 흔히 붙이는 머리표를 제거한다
    variants = [
        re.sub(r"^\s*(?:[-•*]|\d+[.)])\s*", "", l).strip()
        for l in raw.splitlines() if l.strip()
    ]
    return [question] + variants[:4]   # 원본을 반드시 포함
```

핵심은 **원본 질문을 후보에 반드시 포함**하는 것입니다. 생성된 변형이 모두 빗나가도 최소한 원본 성능은 보장됩니다.

병합은 RRF로 처리합니다. 서로 다른 질의의 유사도 점수는 스케일이 달라 그대로 더하면 안 됩니다.

```python
from collections import defaultdict

def rrf_fuse(result_lists: list[list[str]], k: int = 60, top_n: int = 20):
    scores = defaultdict(float)
    for results in result_lists:
        for rank, doc_id in enumerate(results, start=1):
            scores[doc_id] += 1.0 / (k + rank)
    return sorted(scores, key=scores.get, reverse=True)[:top_n]
```

- **비용** — LLM 1회 + 검색 N회. 검색은 병렬로 돌리면 지연시간이 1회 수준으로 수렴합니다.
- **주의** — 실무에서는 4~5개 부근에서 Recall 증가폭이 급격히 둔해지는 경우가 많습니다. 정확한 포화 지점은 도메인마다 다르므로 골든 셋으로 직접 곡선을 그려보십시오.

## 5. 기법 3 — HyDE: 가상의 답변을 만들어 그것으로 검색한다

HyDE(Hypothetical Document Embeddings)는 발상을 뒤집습니다. **질문으로 문서를 찾는 대신, LLM에게 답변을 지어내게 한 뒤 그 가짜 답변으로 검색**합니다.

질문과 문서는 문체와 길이가 다르지만, **답변과 문서는 형태가 비슷하기 때문에** 임베딩 공간에서 더 가깝다는 것이 아이디어입니다.

```python
HYDE_PROMPT = """다음 질문에 대해, 실제 문서에 실려 있을 법한 
설명문을 한 문단으로 작성하십시오. 사실 여부는 중요하지 않으며 
문서와 유사한 문체와 용어를 사용하는 것이 중요합니다.

질문: {question}"""

def hyde_search(question: str, llm, retriever, k: int = 10):
    pseudo_doc = llm.complete(HYDE_PROMPT.format(question=question)).strip()
    # 가짜 답변 + 원본 질문을 각각 검색해 RRF로 병합
    r1 = [d.id for d in retriever.search(pseudo_doc, k=k)]
    r2 = [d.id for d in retriever.search(question,  k=k)]
    return rrf_fuse([r1, r2], top_n=k)
```

- **잘 맞는 경우** — 전문 도메인 문서, 질문이 짧고 문서가 서술형인 경우
- **잘 안 맞는 경우** — 고유명사·숫자·최신 정보가 핵심인 질문. LLM이 그럴듯한 **거짓 고유명사를 만들어 넣으면 검색이 오히려 빗나갑니다**
- **완화책** — 가짜 답변 단독으로 쓰지 말고 위 코드처럼 **원본 질문 결과와 RRF로 병합**하십시오

> HyDE 결과를 BM25에 넣을 때는 **가중치 설계가 필요합니다.** 생성된 거짓 고유명사가 키워드 매칭에 그대로 반영되기 때문입니다. 다만 '넣으면 안 된다'는 아닙니다. Query2doc(arXiv:2303.07678)은 LLM이 만든 가상 문서를 질의에 이어 붙였을 때 **BM25 성능이 MS MARCO·TREC DL에서 3~15% 향상**됐다고 보고했습니다. 핵심은 **원본 질의를 n회 반복해 붙여** 가상 문서의 어휘에 원본이 묻히지 않게 하는 것입니다. 안전한 기본값은 '가상 문서 단독으로 BM25를 치지 않는 것'이며, 결합할 때는 반복 가중치를 두고 골든 셋으로 A/B 확인하십시오.

## 6. 기법 4 — Step-back Prompting: 한 단계 추상화한다

구체적인 질문에 답하려면 배경 원칙이 필요한 경우가 있습니다. Step-back은 **원래 질문보다 한 단계 상위의 질문을 함께 만들어** 두 질의로 검색합니다.

```python
STEPBACK_PROMPT = """다음 질문의 배경이 되는, 한 단계 더 일반적인 
질문 하나를 작성하십시오. 질문만 출력하십시오.

예)
질문: A제품을 개봉했는데 반품이 되나요?
상위 질문: 이 회사의 반품 정책은 어떻게 되나요?

질문: {question}"""

def stepback_search(question: str, llm, retriever, k: int = 10):
    broad = llm.complete(STEPBACK_PROMPT.format(question=question)).strip()
    r1 = [d.id for d in retriever.search(question, k=k)]
    r2 = [d.id for d in retriever.search(broad,    k=k)]
    return rrf_fuse([r1, r2], top_n=k)
```

- 규정·정책·매뉴얼처럼 **총칙과 개별 조항이 분리된 문서 집합**에서 효과가 큽니다.
- 반대로 사실 조회형 질의(`3분기 매출이 얼마인가`)에서는 상위 질문이 노이즈만 추가합니다.

## 7. 기법 5 — Query Decomposition: 복합 질문을 쪼갠다

`A와 B의 차이는 무엇이고 각각 비용은 얼마인가` 같은 질문은 **하나의 벡터로 표현할 수 없습니다.** 두 주제의 평균 벡터는 어느 쪽 문서와도 충분히 가깝지 않습니다.

```python
DECOMPOSE_PROMPT = """다음 질문에 답하려면 몇 개의 독립적인 검색이 
필요한지 판단하고, 필요한 하위 질문들을 한 줄에 하나씩 출력하십시오.
하나의 검색으로 충분하면 원래 질문을 그대로 출력하십시오.

질문: {question}"""

def decompose_and_search(question: str, llm, retriever, k: int = 5):
    subs = [l.strip("-• ").strip()
            for l in llm.complete(
                DECOMPOSE_PROMPT.format(question=question)).splitlines()
            if l.strip()]
    context = {}
    for s in subs:
        context[s] = retriever.search(s, k=k)
    return context   # 서브질문별로 근거를 분리해 보관
```

핵심은 **결과를 하나로 뭉개지 않고 서브질문별로 분리해서 프롬프트에 넣는 것**입니다. 그래야 최종 답변에서 각 항목의 근거를 따로 인용할 수 있습니다.

- **주의** — 분해 개수에 상한을 두십시오. 상한이 없으면 한 질문이 10개 서브질의로 폭발해 지연시간과 비용이 예측 불가능해집니다.

## 8. 기법 6 — Routing과 메타데이터 필터 추출

`작년 3분기 재무보고서에서 영업이익` 같은 질문에는 **검색 범위를 좁히는 조건**이 자연어로 섞여 있습니다. 이것을 구조화 출력으로 뽑아내 필터로 전환합니다.

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional

class SearchPlan(BaseModel):
    query: str = Field(description="필터 조건을 제거한 순수 검색어")
    doc_type: Optional[Literal["재무보고서", "계약서", "매뉴얼", "회의록"]] = None
    year: Optional[int] = None
    quarter: Optional[Literal[1, 2, 3, 4]] = None

def plan_search(question: str, llm) -> SearchPlan:
    return llm.structured_output(SearchPlan, question)
```

이 방식의 이점은 두 가지입니다.

- **후보 축소** — 벡터 검색 전에 필터로 범위를 줄이면 정확도와 속도가 동시에 개선됩니다.
- **질의 정제** — 필터로 뺀 조건이 검색어에서 제거되어 벡터가 본질에 집중합니다.

> 구조화 출력은 vLLM의 JSON Schema 강제나 함수 호출로 구현하십시오. 자유 텍스트를 정규식으로 파싱하는 방식은 운영에서 반드시 깨집니다.

## 9. 지연시간과 비용 — 무엇을 언제 켤 것인가

모든 기법은 **검색 전에 LLM을 한 번 더 부릅니다.** 이 비용을 감당할 수 있는 구간인지 먼저 판단해야 합니다.

| 기법 | 추가 LLM 호출 | 추가 검색 | 체감 지연 | 적용 시점 |
| --- | --- | --- | --- | --- |
| Query Rewriting | 1 | 0 | 낮음 | 멀티턴이면 항상 |
| Metadata 필터 추출 | 1 | 0 | 낮음 | 문서 유형이 다양하면 항상 |
| Multi-Query | 1 | N(병렬) | 중간 | 어휘 불일치가 클 때 |
| Step-back | 1 | 2(병렬) | 중간 | 정책·규정 도메인 |
| HyDE | 1 | 2(병렬) | 중간~높음 | 서술형 전문 문서 |
| Decomposition | 1 | M(순차 가능) | 높음 | 복합 질문 비중이 높을 때 |

실무 구성 순서는 다음을 권합니다.

```
[항상 켜기]   Query Rewriting(멀티턴) + 메타데이터 필터 추출
      ↓
[기본 검색]   Hybrid Search(Dense + BM25) → RRF
      ↓
[조건부]      질문 유형 분류 → 필요할 때만 Multi-Query / Step-back / HyDE
      ↓
[마무리]      Cross-Encoder 리랭커로 Top-k 정제
```

- **작은 모델로 충분합니다.** 질의 변환은 추론 난이도가 낮아 소형 모델이나 낮은 온도 설정으로 처리해도 품질 차이가 작습니다.
- **캐싱이 잘 듣습니다.** 같은 질문이 반복되는 서비스라면 변환 결과를 캐시해 호출 자체를 없앨 수 있습니다.
- **분류기를 앞에 두십시오.** 모든 질문에 전 기법을 적용하는 구성은 지연시간을 두 배로 만들면서 평균 정확도는 거의 올리지 못합니다.

## 10. 흔한 실수

- **전부 켜고 시작한다** — 어떤 기법이 효과를 냈는지 알 수 없게 되고, 지연시간만 확실히 늘어납니다.
- **원본 질문을 후보에서 뺀다** — 변환이 실패했을 때 복구할 방법이 사라집니다. 원본은 항상 포함하십시오.
- **점수를 그대로 더해서 병합한다** — 질의별 유사도 스케일이 달라 한 질의가 결과를 지배합니다. RRF를 쓰십시오.
- **HyDE 가상 문서를 원본 질의 없이 BM25에 단독으로 태운다** — 생성된 거짓 고유명사가 키워드 매칭을 지배합니다. 결합하려면 원본 질의를 반복해 가중치를 주고 A/B로 확인하십시오.
- **리랭킹 문제를 질의 변환으로 풀려 한다** — Top-50 안에 정답이 이미 들어와 있다면 질의를 아무리 바꿔도 개선되지 않습니다.
- **변환된 질의를 로그에 남기지 않는다** — 장애 분석이 불가능해집니다. 실제 원인의 상당수가 이 단계에 있습니다.
- **분해 개수에 상한이 없다** — 한 질문이 서브질의 10개로 번지면 비용과 지연시간이 통제 불능이 됩니다.

## 실전 체크리스트

- 질문 원문·변환된 질의·Top-k 문서 ID·최종 인용 여부를 로그에 남겼다.
- 골든 셋으로 Hit@5와 Hit@50을 각각 측정해 리랭킹 문제와 구분했다(Hit Rate와 Recall을 구분해 이름 붙였다).
- 사람이 수동으로 질문을 바꿔 썼을 때 검색되는지 확인했다.
- 멀티턴 서비스라면 Query Rewriting을 먼저 적용했다.
- 대화 이력 참조 범위를 최근 3~5턴으로 제한했다.
- 생성된 질의 후보에 원본 질문을 항상 포함시켰다.
- 여러 질의 결과를 RRF로 병합했다.
- HyDE 가상 문서를 BM25에 단독으로 넣지 않았고, 결합했다면 원본 질의 반복 가중치를 적용해 A/B로 검증했다.
- 질의 분해 개수에 상한을 설정했다.
- 메타데이터 필터 추출을 구조화 출력(JSON Schema)으로 강제했다.
- 변환 단계의 추가 지연시간을 TTFT 예산에 반영해 측정했다.

## 마치며

Query Transformation은 **인덱스를 다시 만들지 않고 검색 품질을 올릴 수 있는 거의 유일한 지점**입니다. 청킹과 임베딩은 바꾸면 전체 재색인이 필요하지만, 질의 변환은 오늘 배포해서 오늘 롤백할 수 있습니다.

그래서 더 위험하기도 합니다. 붙이기 쉬우니 전부 붙이게 되고, 그러면 지연시간이 두 배가 된 채로 어떤 기법이 기여했는지 아무도 모르는 상태가 됩니다. **실패 유형을 로그로 분류하고, 한 번에 하나씩 켜고, 골든 셋으로 확인하는 순서**만 지켜도 대부분의 개선은 여기서 나옵니다.

## FAQ

**Q1. Multi-Query와 HyDE 중 하나만 고른다면?**
Multi-Query입니다. HyDE는 LLM이 생성한 내용이 틀렸을 때 검색이 그 방향으로 끌려가는 위험이 있는 반면, Multi-Query는 원본 질문을 포함하므로 하한이 보장됩니다. HyDE는 도메인이 좁고 문서가 서술형일 때 추가로 검토하십시오.

**Q2. 질의 변환에 어떤 모델을 써야 하나요?**
답변 생성 모델과 같은 것을 쓸 필요가 없습니다. 질의 변환은 형식 변환에 가까워 소형 모델로도 충분한 경우가 많습니다. 온도를 낮게 두어 출력 안정성을 확보하는 편이 모델 크기보다 중요합니다.

**Q3. 변환 때문에 오히려 결과가 나빠지는 경우는 어떻게 잡나요?**
질의별로 원본 결과와 변환 결과를 모두 확보한 뒤 RRF로 병합하면 하한이 원본 수준으로 유지됩니다. 그래도 나빠진다면 변환 프롬프트가 질문의 제약 조건(연도·제품명·부정문)을 지우고 있는지 확인하십시오. 부정문 소실이 특히 잦습니다.

**Q4. 지연시간 예산이 빠듯하면 무엇부터 포기해야 하나요?**
HyDE와 Decomposition을 먼저 끄십시오. 둘 다 비용 대비 지연이 큽니다. Query Rewriting과 메타데이터 필터 추출은 마지막까지 유지할 가치가 있습니다. 전자는 멀티턴 정확도의 전제 조건이고, 후자는 오히려 검색 범위를 줄여 속도를 개선합니다.

## 참고 자료

- Gao et al. — Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE, arXiv:2212.10496)
- Wang et al. — Query2doc: Query Expansion with Large Language Models (EMNLP 2023, arXiv:2303.07678)
- Zheng et al. — Take a Step Back: Evoking Reasoning via Abstraction in Large Language Models (arXiv:2310.06117)
- Cormack et al. — Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods

## 함께 읽으면 좋은 글

- RAG Hybrid Search 실전 가이드 — Dense·BM25·RRF로 검색 정확도 높이기
- RAG Reranker 완전정리 — Bi-Encoder·Cross-Encoder 2단계 검색 설계
- RAG 청킹 전략 완전정리 — Fixed·Recursive·Semantic·Late Chunking 선택 기준
- vLLM Structured Outputs 완전정리 — JSON Schema·Regex·Grammar로 출력 고정하기

---

**태그(9개):** HyDE, LLM엔지니어링, MultiQuery, RAG, RRF, StepBack, 검색품질, 쿼리변환, 하이브리드검색
