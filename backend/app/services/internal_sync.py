"""
Internal Sync — sincronização da loja do usuário via Open Platform v2.

Persiste pedidos + escrows (conciliação de taxas) e atualiza os tokens
sempre que o client fizer refresh automático.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta

from app.config import settings
from app.database import SessionLocal
from app.models import models as m
from app.services.shopee_auth import ShopeeCredentials, ShopeeEnv
from app.services.shopee_client import ShopeeClient, ShopTokens, fetch_orders

logger = logging.getLogger(__name__)


def _creds() -> ShopeeCredentials:
    return ShopeeCredentials(
        partner_id=settings.shopee_partner_id,
        partner_key=settings.shopee_partner_key,
        env=ShopeeEnv.TEST if settings.shopee_env == "test" else ShopeeEnv.PROD,
    )


def _build_client(conn: m.ShopeeConnection, db) -> ShopeeClient:
    tokens = ShopTokens(
        access_token=conn.access_token,
        refresh_token=conn.refresh_token,
        expires_at=conn.token_expires_at.timestamp(),
        refresh_expires_at=conn.refresh_expires_at.timestamp(),
    )

    async def persist(tokens: ShopTokens) -> None:
        conn.access_token = tokens.access_token
        conn.refresh_token = tokens.refresh_token
        conn.token_expires_at = datetime.fromtimestamp(tokens.expires_at)
        db.commit()

    return ShopeeClient(_creds(), conn.shop_id, tokens, on_token_refresh=persist)


async def sync_orders_window(connection_id: str, days: int = 7) -> dict:
    """
    Puxa pedidos da janela (Shopee limita a 15 dias por chamada — fatiamos)
    e o detalhe/escrow de cada um para conciliação de taxas.
    """
    db = SessionLocal()
    try:
        conn = db.get(m.ShopeeConnection, uuid.UUID(connection_id))
        if not conn:
            return {"error": "connection_not_found"}

        client = _build_client(conn, db)
        now, synced = int(time.time()), 0

        try:
            for start in range(days, 0, -15):
                span = min(15, start)
                t_from = now - start * 86400
                t_to = now - (start - span) * 86400

                orders = await fetch_orders(client, t_from, t_to)
                for o in orders:
                    detail = await client.shop_get(
                        "/api/v2/order/get_order_detail",
                        {"order_sn_list": o["order_sn"],
                         "response_optional_fields":
                             "buyer_total_amount,item_list,order_status"},
                    )
                    escrow = await client.shop_get(
                        "/api/v2/payment/get_escrow_detail",
                        {"order_sn": o["order_sn"]},
                    )
                    income = escrow.get("order_income", {})

                    db.merge(m.InternalOrder(
                        connection_id=conn.id,
                        order_sn=o["order_sn"],
                        order_status=o.get("order_status", ""),
                        order_time=datetime.fromtimestamp(o["create_time"]),
                        total_amount=float(
                            income.get("buyer_total_amount", 0)) / 1e5,
                        escrow_amount=float(income.get("escrow_amount", 0)) / 1e5,
                        commission_fee=float(income.get("commission_fee", 0)) / 1e5,
                        service_fee=float(income.get("service_fee", 0)) / 1e5,
                        transaction_fee=float(
                            income.get("credit_card_transaction_fee", 0)) / 1e5,
                        shipping_fee=float(income.get("actual_shipping_fee", 0)) / 1e5,
                        items=(detail.get("order_list") or [{}])[0].get("item_list", []),
                        raw_payload={"order": o, "escrow": escrow},
                    ))
                    synced += 1

            conn.last_sync_at = datetime.utcnow()
            db.commit()
            return {"connection": connection_id, "orders_synced": synced}
        finally:
            await client.close()
    finally:
        db.close()
