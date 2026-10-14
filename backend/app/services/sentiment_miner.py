"""
Pain Miner — classificação de avaliações negativas (1-3 estrelas).

Versão 1: classificador por dicionário de keywords PT-BR (rápido, sem custo,
funciona offline em batch). Ponto de extensão: trocar `classify_review` por
chamada a LLM mantendo a mesma assinatura e persistência em pain_categories.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass


PAIN_LEXICON: dict[str, list[str]] = {
    "defeito":        ["defeito", "quebrado", "quebrou", "não funciona", "parou de",
                       "estragado", "ruim qualidade", "falhando", "vazou", "descascando"],
    "qualidade":      ["material ruim", "frágil", "fininho", "qualidade baixa",
                       "parece falsificado", "diferente da foto", "desbotou"],
    "tamanho":        ["tamanho errado", "menor que", "maior que", "não serviu",
                       "pequeno demais", "grande demais", "medida errada", "tamanho incorreto"],
    "atraso":         ["demorou", "atraso", "não chegou", "demora", "muito tempo",
                       "prazo estourado", "entrega lenta"],
    "embalagem":      ["embalagem ruim", "veio amassado", "mal embalado",
                       "caixa amassada", "sem proteção", "lacrado não"],
    "atendimento":    ["vendedor não responde", "ignorou", "sem retorno",
                       "atendimento ruim", "não resolveu", "bloqueou"],
    "descricao":      ["diferente do anúncio", "propaganda enganosa", "não é como descrito",
                       "foto engana", "cor diferente", "item errado"],
    "pecas_faltando": ["faltou peça", "incompleto", "veio faltando", "sem acessório",
                       "quantidade errada"],
}

_COMPILED = {
    cat: re.compile("|".join(re.escape(k) for k in kws), re.IGNORECASE)
    for cat, kws in PAIN_LEXICON.items()
}


@dataclass
class ReviewClassification:
    pain_categories: list[str]
    sentiment: str  # negative | neutral | positive


def classify_review(rating: int, comment: str | None) -> ReviewClassification:
    text = (comment or "").strip()
    cats = [cat for cat, rx in _COMPILED.items() if rx.search(text)]

    if rating <= 2:
        sentiment = "negative"
    elif rating == 3:
        sentiment = "negative" if cats else "neutral"
    else:
        sentiment = "positive"

    # Review 1-2★ sem keyword mapeada ainda conta como dor genérica
    if rating <= 2 and not cats:
        cats = ["outros"]

    return ReviewClassification(pain_categories=cats, sentiment=sentiment)


def summarize_pains(
    reviews: list[tuple[int, str | None, list[str]]]
) -> list[dict]:
    """
    Agrega o resultado do miner em top_pain_points para product_reviews_summary.
    reviews: [(rating, comment, pain_categories), ...]
    Retorna: [{"category": ..., "count": ..., "pct": ..., "samples": [...]}]
    """
    counter: Counter[str] = Counter()
    samples: dict[str, list[str]] = {}
    negatives = 0

    for rating, comment, cats in reviews:
        if rating > 3:
            continue
        negatives += 1
        for c in cats:
            counter[c] += 1
            if comment and len(samples.setdefault(c, [])) < 3:
                samples[c].append(comment[:200])

    total = sum(counter.values()) or 1
    return [
        {"category": cat, "count": n, "pct": round(n / total, 3),
         "samples": samples.get(cat, [])}
        for cat, n in counter.most_common(8)
    ]
