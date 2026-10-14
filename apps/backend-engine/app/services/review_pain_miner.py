"""Pain Miner: extrai padrões de defeito de reviews 1–3★ e gera checklist
de melhoria pra cobrar do fornecedor (ou explorar no anúncio)."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

# categoria -> keywords (normalizadas, sem acento)
PAIN_CATEGORIES: dict[str, list[str]] = {
    "Qualidade/Material": [
        "rasgou", "rasgada", "quebrou", "quebrado", "fragil", "defeito",
        "descosturou", "desbotou", "parou de funcionar", "material ruim",
        "qualidade ruim", "pessima qualidade", "descascando", "soltou",
    ],
    "Tamanho/Medidas": [
        "pequeno", "pequena", "muito grande", "tamanho", "medida",
        "apertado", "nao serviu", "menor que", "maior que", "forminha",
    ],
    "Embalagem/Transporte": [
        "atraso", "atrasou", "demorou", "embalagem", "amassado", "amassada",
        "caixa", "entrega", "correio", "chegou quebrado", "transporte",
        "rasgada a embalagem", "mal embalado",
    ],
    "Diferente da Foto": [
        "diferente da foto", "diferente do anuncio", "cor diferente",
        "propaganda enganosa", "nao e igual",
        "enganoso", "decepcionante", "nada a ver",
    ],
    "Atendimento/Vendedor": [
        "vendedor nao respondeu", "atendimento ruim", "nao responde",
        "reembolso", "devolucao", "nao ajudou",
    ],
}

CHECKLISTS: dict[str, str] = {
    "Qualidade/Material":
        "Exigir QC com foto/vídeo pré-envio e testar amostra de cada lote.",
    "Tamanho/Medidas":
        "Publicar tabela de medidas real (cm) e vídeo com referência de escala.",
    "Embalagem/Transporte":
        "Reforçar embalagem (plástico-bolha/caixa rígida) e declarar no anúncio.",
    "Diferente da Foto":
        "Usar fotos reais do produto, não renderizações; mostrar cor fiel.",
    "Atendimento/Vendedor":
        "Responder chat em < 1h e oferecer troca rápida nos reviews ruins.",
}

_WORD_RE = re.compile(r"[a-zà-ú]{4,}")


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in t if not unicodedata.combining(c))


@dataclass
class PainReport:
    total_reviews: int
    negative_reviews: int
    category_counts: dict[str, int] = field(default_factory=dict)
    top_keywords: list[tuple[str, int]] = field(default_factory=list)
    top_category: str | None = None
    checklist: list[str] = field(default_factory=list)


def mine_pain_points(reviews: list[dict]) -> PainReport:
    """reviews: [{'rating_star': int, 'comment': str}, ...]"""
    neg = [r for r in reviews if int(r.get("rating_star") or 5) <= 3]
    counts: Counter[str] = Counter()
    kw_counts: Counter[str] = Counter()
    cats_hit: set[str] = set()

    for r in neg:
        text = _norm(str(r.get("comment") or ""))
        for cat, keywords in PAIN_CATEGORIES.items():
            hits = [k for k in keywords if _norm(k) in text]
            if hits:
                counts[cat] += 1
                cats_hit.add(cat)
                for k in hits:
                    kw_counts[k] += 1

    checklist = [CHECKLISTS[c] for c, _ in counts.most_common()]
    top_category = counts.most_common(1)[0][0] if counts else None

    return PainReport(
        total_reviews=len(reviews),
        negative_reviews=len(neg),
        category_counts=dict(counts),
        top_keywords=kw_counts.most_common(10),
        top_category=top_category,
        checklist=checklist,
    )
