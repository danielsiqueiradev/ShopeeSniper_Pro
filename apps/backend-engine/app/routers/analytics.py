"""Router /analytics — métricas de nicho, séries de vendas e unit economics."""

from __future__ import annotations

from fastapi import APIRouter

from ..config import settings
from ..schemas import (
    OpportunityRequest,
    OpportunityResponse,
    PainMinerRequest,
    PainMinerResponse,
    SalesDeltaPoint,
    SalesDeltaRequest,
    UnitEconomicsRequest,
    UnitEconomicsResponse,
)
from ..services.opportunity_engine import (
    OpportunityInput,
    compute_opportunity_score,
)
from ..services.review_pain_miner import mine_pain_points
from ..services.snapshots import compute_sales_deltas
from ..services.unit_economics import (
    compute_unit_economics,
    max_supplier_cost_for_target_margin,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.post("/unit-economics", response_model=UnitEconomicsResponse)
def unit_economics(body: UnitEconomicsRequest) -> UnitEconomicsResponse:
    """Lucro líquido + CMV Teto (maior custo de fornecedor p/ margem alvo)."""
    ue = compute_unit_economics(
        body.sale_price, body.supplier_cost, body.quantity, settings.fees
    )
    cmv = max_supplier_cost_for_target_margin(
        body.sale_price, body.target_margin_pct, body.quantity, settings.fees
    )
    return UnitEconomicsResponse(
        sale_price=ue.sale_price,
        supplier_cost=ue.supplier_cost,
        revenue=ue.revenue,
        commission=ue.commission,
        free_shipping_fee=ue.free_shipping_fee,
        fixed_fee=ue.fixed_fee,
        tax=ue.tax,
        ads_cost=ue.ads_cost,
        total_fees=ue.total_fees,
        gross_after_shopee=ue.gross_after_shopee,
        net_profit=ue.net_profit,
        net_margin_pct=ue.net_margin_pct,
        breakeven_roas=ue.breakeven_roas,
        cmv_teto=cmv,
    )


@router.post("/opportunity-score", response_model=OpportunityResponse)
def opportunity_score(body: OpportunityRequest) -> OpportunityResponse:
    s = compute_opportunity_score(OpportunityInput(**body.model_dump()))
    return OpportunityResponse(**s.__dict__)


@router.post("/sales-by-date", response_model=list[SalesDeltaPoint])
def sales_by_date(body: SalesDeltaRequest) -> list[SalesDeltaPoint]:
    """Deltas diários de uma série de snapshots (mesma lógica da view SQL)."""
    return [
        SalesDeltaPoint(**p)
        for p in compute_sales_deltas([s.model_dump() for s in body.snapshots])
    ]


@router.post("/pain-miner", response_model=PainMinerResponse)
def pain_miner(body: PainMinerRequest) -> PainMinerResponse:
    report = mine_pain_points([r.model_dump() for r in body.reviews])
    return PainMinerResponse(
        total_reviews=report.total_reviews,
        negative_reviews=report.negative_reviews,
        category_counts=report.category_counts,
        top_keywords=[list(kw) for kw in report.top_keywords],
        top_category=report.top_category,
        checklist=report.checklist,
    )
