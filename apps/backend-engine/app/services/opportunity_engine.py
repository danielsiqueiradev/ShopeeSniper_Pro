"""Opportunity Score (0–100): vale a pena atacar esse produto/nicho?

  Score = Velocity (0–40) + Listing Freshness (0–20) + Seller Vulnerability (0–40)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OpportunityInput:
    sold_30_days: int
    age_days: int | None = None              # idade do anúncio (None = desconhecida)
    sales_last_24h: float | None = None      # delta do último snapshot (vw_sales_by_date)
    rating_star: float | None = None         # nota da loja/produto (0–5)
    response_rate: float | None = None       # % resposta chat
    is_official_shop: bool = False
    top_sku_out_of_stock: bool = False       # variação campeã sem estoque


@dataclass(frozen=True)
class OpportunityScore:
    score: float                             # 0–100
    velocity_pts: float
    freshness_pts: float
    vulnerability_pts: float
    avg_daily_sales: float
    accelerating: bool
    label: str                               # "fraco" | "morno" | "quente" | "ouro"


MAX_DAILY_FOR_FULL_VELOCITY = 10.0           # 10 vendas/dia → velocidade máxima


def _velocity_pts(inp: OpportunityInput) -> tuple[float, float, bool]:
    """0–30 pela média diária (cap em 10/dia) + bônus de aceleração (0–10)."""
    avg_daily = inp.sold_30_days / 30.0
    base = min(avg_daily / MAX_DAILY_FOR_FULL_VELOCITY, 1.0) * 30.0

    accelerating = (
        inp.sales_last_24h is not None
        and avg_daily > 0
        and inp.sales_last_24h > avg_daily * 1.15
    )
    bonus = 10.0 if accelerating else 0.0
    return base + bonus, avg_daily, accelerating


def _freshness_pts(inp: OpportunityInput, avg_daily: float) -> float:
    """Anúncio novo já vendendo = o nicho tem demanda e o algo favorece."""
    if inp.age_days is None:
        return 0.0
    if inp.age_days < 90 and avg_daily > 5:
        return 20.0
    if inp.age_days < 90 and avg_daily > 3:
        return 15.0
    if inp.age_days < 180 and avg_daily > 3:
        return 10.0
    if inp.age_days < 90:
        return 6.0
    return 0.0


def _vulnerability_pts(inp: OpportunityInput) -> float:
    """Seller fraco = fácil de superar com anúncio melhor."""
    pts = 0.0
    if inp.rating_star is not None:
        if inp.rating_star < 4.0:
            pts += 15.0
        elif inp.rating_star < 4.7:
            # escala linear: 4.7 → 0 pts, 4.0 → 15 pts
            pts += (4.7 - inp.rating_star) / 0.7 * 15.0
    if inp.response_rate is not None and inp.response_rate < 85:
        pts += 10.0
    if not inp.is_official_shop:
        pts += 5.0
    if inp.top_sku_out_of_stock:
        pts += 10.0
    return min(pts, 40.0)


def compute_opportunity_score(inp: OpportunityInput) -> OpportunityScore:
    vel, avg_daily, accel = _velocity_pts(inp)
    fresh = _freshness_pts(inp, avg_daily)
    vuln = _vulnerability_pts(inp)
    total = round(min(vel + fresh + vuln, 100.0), 1)

    if total >= 75:
        label = "ouro"
    elif total >= 55:
        label = "quente"
    elif total >= 35:
        label = "morno"
    else:
        label = "fraco"

    return OpportunityScore(
        score=total,
        velocity_pts=round(vel, 1),
        freshness_pts=round(fresh, 1),
        vulnerability_pts=round(vuln, 1),
        avg_daily_sales=round(avg_daily, 2),
        accelerating=accel,
        label=label,
    )
