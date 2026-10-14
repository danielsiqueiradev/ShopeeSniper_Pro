"""
Opportunity Score (0-100) — Radar de Vulnerabilidade de Vendedores.

Tese: a melhor oportunidade = produto vendendo MUITO e RÁPIDO, mas entregue
por um vendedor FRACO (nota baixa, chat lento, prep longo, fotos ruins).

Score = w1·Demanda + w2·Vulnerabilidade do Seller
      + w3·(1 - Concentração do Nicho) + w4·Dor nas Reviews

Pesos default: 40 / 30 / 15 / 15.

Sub-scores (cada um normalizado 0-100):

  Demanda (40):
      base = min(100, log1p(avg_daily_30d) / log1p(CAP) * 100)   CAP = 200 vendas/dia
      multiplicador de tendência: rising ×1.15 | stable ×1.0 | falling ×0.6
      (clamp 0-100)

  Vulnerabilidade do Seller (30) — soma de sinais fracos do incumbente:
      +30 se rating_star < 4.70        (+15 se < 4.85, caso contrário 0)
      +25 se response_rate < 80%       (+10 se < 90%)
      +20 se ship_prep_days > 2.0      (+10 se > 1.0)
      +15 se follower_count < 1000     (loja sem tração de marca)
      +10 se NÃO for Shopee Mall       (Mall = barreira competitiva)

  Concentração do Nicho (15):
      fragmented -> 100 | moderate -> 55 | concentrated -> 10
      (linearmente interpolado pelo top3_share quando disponível)

  Dor nas Reviews (15):
      negative_ratio (reviews 1-3★ / total) mapeado para 0-100 com teto em 15%
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


DAILY_SALES_CAP = 200.0          # vendas/dia que saturam o sub-score de demanda
NEGATIVE_RATIO_CAP = 0.15        # 15% de reviews negativas = dor máxima


@dataclass(frozen=True)
class SellerSignals:
    rating_star: float | None        # nota da loja (1-5)
    response_rate: float | None      # % resposta chat (0-100)
    ship_prep_days: float | None     # tempo de preparo (dias)
    follower_count: int | None
    is_official: bool = False        # Shopee Mall


@dataclass(frozen=True)
class DemandSignals:
    avg_daily_30d: float | None
    trend_label: str                 # rising | stable | falling | insufficient_data


@dataclass
class ScoreResult:
    score: float                     # 0-100
    label: str                       # hot | warm | cold | avoid
    factors: dict = field(default_factory=dict)   # explainability p/ o front


def _demand_score(d: DemandSignals) -> tuple[float, dict]:
    if not d.avg_daily_30d or d.avg_daily_30d <= 0:
        return 0.0, {"reason": "sem dados de velocidade"}

    base = min(100.0, math.log1p(d.avg_daily_30d) / math.log1p(DAILY_SALES_CAP) * 100)
    multiplier = {"rising": 1.15, "stable": 1.0, "falling": 0.6}.get(d.trend_label, 0.8)
    final = min(100.0, base * multiplier)
    return final, {
        "avg_daily_30d": round(d.avg_daily_30d, 1),
        "trend": d.trend_label,
        "base": round(base, 1),
        "trend_multiplier": multiplier,
    }


def _seller_vulnerability(s: SellerSignals) -> tuple[float, dict]:
    pts, detail = 0.0, {}

    r = s.rating_star
    if r is not None:
        p = 30 if r < 4.70 else (15 if r < 4.85 else 0)
        pts += p
        detail["rating"] = {"value": r, "points": p}

    rr = s.response_rate
    if rr is not None:
        p = 25 if rr < 80 else (10 if rr < 90 else 0)
        pts += p
        detail["response_rate"] = {"value": rr, "points": p}

    prep = s.ship_prep_days
    if prep is not None:
        p = 20 if prep > 2.0 else (10 if prep > 1.0 else 0)
        pts += p
        detail["ship_prep_days"] = {"value": prep, "points": p}

    f = s.follower_count
    if f is not None and f < 1000:
        pts += 15
        detail["follower_count"] = {"value": f, "points": 15}

    if not s.is_official:
        pts += 10
        detail["not_shopee_mall"] = {"points": 10}

    return min(100.0, pts), detail


def _concentration_score(top3_share: float | None) -> tuple[float, dict]:
    if top3_share is None:
        return 50.0, {"reason": "nicho sem estatística agregada"}
    # top3_share 0.0 -> 100 pts ; 1.0 -> 0 pts (inverso da concentração)
    score = max(0.0, (1.0 - top3_share) * 100)
    label = ("concentrated" if top3_share >= 0.60
             else "moderate" if top3_share >= 0.35 else "fragmented")
    return score, {"top3_share": top3_share, "label": label}


def _pain_score(negative_ratio: float | None) -> tuple[float, dict]:
    if negative_ratio is None:
        return 0.0, {"reason": "sem reviews coletadas"}
    score = min(100.0, negative_ratio / NEGATIVE_RATIO_CAP * 100)
    return score, {"negative_ratio": round(negative_ratio, 4)}


def compute_opportunity_score(
    demand: DemandSignals,
    seller: SellerSignals,
    top3_share: float | None = None,
    negative_ratio: float | None = None,
    weights: tuple[float, float, float, float] = (0.40, 0.30, 0.15, 0.15),
) -> ScoreResult:
    w_dem, w_sel, w_con, w_pain = weights

    dem, dem_d = _demand_score(demand)
    sel, sel_d = _seller_vulnerability(seller)
    con, con_d = _concentration_score(top3_share)
    pain, pain_d = _pain_score(negative_ratio)

    score = dem * w_dem + sel * w_sel + con * w_con + pain * w_pain
    score = round(min(100.0, max(0.0, score)), 1)

    label = ("hot" if score >= 70 else "warm" if score >= 45
             else "cold" if score >= 25 else "avoid")

    return ScoreResult(score=score, label=label, factors={
        "demand":       {"score": round(dem, 1),  "weight": w_dem, **dem_d},
        "seller_vuln":  {"score": round(sel, 1),  "weight": w_sel, "detail": sel_d},
        "concentration": {"score": round(con, 1), "weight": w_con, **con_d},
        "review_pain":  {"score": round(pain, 1), "weight": w_pain, **pain_d},
    })
