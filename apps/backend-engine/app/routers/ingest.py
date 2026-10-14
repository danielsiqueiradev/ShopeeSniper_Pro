"""Router /ingest — recebe payloads passivos capturados pela extensão.

Normaliza preços (÷100000), extrai itens/ratings das rotas v4 conhecidas e,
se o Supabase estiver configurado, faz upsert atômico via RPC
ingest_shopee_batch.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter

from ..config import settings
from ..schemas import IngestResult, InterceptedPayload
from ..services.normalizer import (
    extract_items,
    extract_ratings,
    sanitize_item,
)

router = APIRouter(prefix="/ingest", tags=["ingest"])

ITEM_ROUTES = ("search_items", "recommend", "item/get", "pdp/get_pc")
RATING_ROUTES = ("item/get_ratings",)


async def _push_to_supabase(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Chama o RPC ingest_shopee_batch no PostgREST do Supabase."""
    if not settings.supabase_configured:
        return None
    url = f"{settings.supabase_url}/rest/v1/rpc/ingest_shopee_batch"
    headers = {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json={"payload": payload}, headers=headers)
        resp.raise_for_status()
        return resp.json()


@router.post("/payload", response_model=IngestResult)
async def ingest_payload(body: InterceptedPayload) -> IngestResult:
    """Recebe um evento interceptado, normaliza e persiste snapshots."""
    raw_items = extract_items(body.payload)
    items = [sanitize_item(i) for i in raw_items]
    ratings = extract_ratings(body.payload)

    snapshots = [
        {
            "itemid": it.get("itemid"),
            "shopid": it.get("shopid"),
            "name": it.get("name"),
            "ctime": it.get("ctime"),
            "catid": it.get("catid"),
            "image": it.get("image"),
            "price": it.get("price"),
            "stock": it.get("stock"),
            "sold_30_days": it.get("sold_30_days") or it.get("sold"),
            "historical_sold": it.get("historical_sold"),
            "rating_star": (it.get("item_rating") or {}).get("rating_star")
                           or it.get("rating_star"),
            "rating_count": (it.get("item_rating") or {}).get("rating_count")
                            or it.get("rating_count"),
            "models": it.get("models") or it.get("tier_variations"),
        }
        for it in items
        if it.get("itemid")
    ]

    supabase_result = None
    if snapshots:
        supabase_result = await _push_to_supabase({"items": snapshots})

    return IngestResult(
        route=body.route,
        items_received=len(raw_items) + len(ratings),
        items_normalized=len(snapshots),
        snapshots=snapshots,
        supabase=supabase_result,
    )


@router.get("/health")
def ingest_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "supabase_configured": settings.supabase_configured,
    }
