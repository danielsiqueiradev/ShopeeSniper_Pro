"""OAuth2 da Shopee Open Platform — connect + callback."""

import time
import uuid
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import models as m
from app.services.shopee_auth import (
    ACCESS_TOKEN_TTL_S, PATH_TOKEN_GET, REFRESH_TOKEN_TTL_S, ShopeeCredentials,
    ShopeeEnv, build_auth_url, sign_public, token_get_payload,
)

router = APIRouter()


def _creds() -> ShopeeCredentials:
    return ShopeeCredentials(
        partner_id=settings.shopee_partner_id,
        partner_key=settings.shopee_partner_key,
        env=ShopeeEnv.TEST if settings.shopee_env == "test" else ShopeeEnv.PROD,
    )


@router.get("/connect-url")
def connect_url():
    """Retorna a URL para o lojista autorizar o app na Shopee."""
    return {"url": build_auth_url(_creds(), settings.shopee_redirect_url)}


class CallbackBody(BaseModel):
    code: str
    shop_id: int
    user_id: uuid.UUID


@router.post("/callback")
async def oauth_callback(body: CallbackBody, db: Session = Depends(get_db)):
    """
    Troca o `code` (retornado no redirect) pelo par access/refresh token.
    O code só pode ser usado uma vez e expira em minutos.
    """
    creds = _creds()
    qs = sign_public(creds, PATH_TOKEN_GET)
    payload = token_get_payload(creds.partner_id, body.code, body.shop_id)

    async with httpx.AsyncClient(base_url=creds.env.value, timeout=30) as http:
        resp = await http.post(PATH_TOKEN_GET, params=qs, json=payload)
        data = resp.json()

    if data.get("error"):
        raise HTTPException(400, f"Shopee: {data['error']} — {data.get('message')}")

    now = datetime.utcnow()
    conn = m.ShopeeConnection(
        user_id=body.user_id,
        shop_id=body.shop_id,
        access_token=data["access_token"],
        refresh_token=data["refresh_token"],
        token_expires_at=now + timedelta(seconds=data.get("expire_in", ACCESS_TOKEN_TTL_S)),
        refresh_expires_at=now + timedelta(seconds=REFRESH_TOKEN_TTL_S),
        status="active",
    )
    db.merge(conn)
    db.commit()
    return {"status": "connected", "shop_id": body.shop_id}
