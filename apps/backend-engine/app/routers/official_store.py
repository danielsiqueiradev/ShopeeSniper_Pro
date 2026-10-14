"""Router /official — gestão da loja própria via Shopee Open Platform v2."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..config import settings
from ..schemas import TokenExchangeRequest
from ..services.shopee_official_v2 import ShopeeOfficialClient

router = APIRouter(prefix="/official", tags=["official-store"])


def _client() -> ShopeeOfficialClient:
    if not settings.official_configured:
        raise HTTPException(
            503,
            "Shopee Open Platform não configurada — defina SHOPEE_PARTNER_ID "
            "e SHOPEE_PARTNER_KEY no .env",
        )
    return ShopeeOfficialClient(
        partner_id=settings.shopee_partner_id,
        partner_key=settings.shopee_partner_key,
        access_token=settings.shopee_access_token,
        shop_id=settings.shopee_shop_id or None,
    )


@router.get("/auth-url")
def auth_url(redirect_url: str = Query(...)) -> dict:
    """URL pra autorização OAuth2 da loja."""
    return {"auth_url": _client().auth_url(redirect_url)}


@router.post("/token")
def token(body: TokenExchangeRequest) -> dict:
    """Troca o code do callback por access_token."""
    return _client().exchange_token(body.code, body.shop_id)


@router.get("/orders")
def orders(time_from: int, time_to: int, cursor: str = "") -> dict:
    return _client().get_order_list(time_from, time_to, cursor=cursor)


@router.get("/orders/{order_sn}/escrow")
def escrow(order_sn: str) -> dict:
    """Auditoria de taxas reais descontadas no pedido."""
    return _client().get_escrow_detail(order_sn)
