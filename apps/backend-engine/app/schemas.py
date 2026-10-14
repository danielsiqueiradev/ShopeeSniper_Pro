"""Contratos de dados (Pydantic v2) da API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------- ingest ----------

class InterceptedPayload(BaseModel):
    """Payload emitido pelo interceptor da extensão."""
    route: str                                # ex: /api/v4/search/search_items
    payload: dict[str, Any] = Field(default_factory=dict)
    captured_at: float | None = None          # epoch seconds


class IngestResult(BaseModel):
    route: str
    items_received: int
    items_normalized: int
    snapshots: list[dict[str, Any]] = Field(default_factory=list)
    supabase: dict[str, Any] | None = None    # resposta do RPC, se configurado


# ---------- unit economics ----------

class UnitEconomicsRequest(BaseModel):
    sale_price: float
    supplier_cost: float = 0.0
    quantity: int = 1
    target_margin_pct: float = 20.0


class UnitEconomicsResponse(BaseModel):
    sale_price: float
    supplier_cost: float
    revenue: float
    commission: float
    free_shipping_fee: float
    fixed_fee: float
    tax: float
    ads_cost: float
    total_fees: float
    gross_after_shopee: float
    net_profit: float
    net_margin_pct: float
    breakeven_roas: float
    cmv_teto: float


# ---------- opportunity ----------

class OpportunityRequest(BaseModel):
    sold_30_days: int = 0
    age_days: int | None = None
    sales_last_24h: float | None = None
    rating_star: float | None = None
    response_rate: float | None = None
    is_official_shop: bool = False
    top_sku_out_of_stock: bool = False


class OpportunityResponse(BaseModel):
    score: float
    velocity_pts: float
    freshness_pts: float
    vulnerability_pts: float
    avg_daily_sales: float
    accelerating: bool
    label: str


# ---------- reviews ----------

class ReviewIn(BaseModel):
    rating_star: int
    comment: str = ""


class PainMinerRequest(BaseModel):
    reviews: list[ReviewIn]


class PainMinerResponse(BaseModel):
    total_reviews: int
    negative_reviews: int
    category_counts: dict[str, int]
    top_keywords: list[list[Any]]
    top_category: str | None
    checklist: list[str]


# ---------- snapshots / analytics ----------

class SnapshotPoint(BaseModel):
    snapshot_date: str
    price: float | None = None
    historical_sold: int | None = None
    sold_30_days: int | None = None
    stock: int | None = None


class SalesDeltaPoint(BaseModel):
    snapshot_date: str
    sales_on_date: int | None
    revenue_on_date: float | None
    days_since_prev: int | None
    avg_daily_normalized: float | None       # delta normalizado por dias decorridos


class SalesDeltaRequest(BaseModel):
    snapshots: list[SnapshotPoint]


# ---------- official store ----------

class TokenExchangeRequest(BaseModel):
    code: str
    shop_id: int
