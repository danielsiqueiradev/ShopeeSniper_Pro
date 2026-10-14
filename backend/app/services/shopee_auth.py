"""
Shopee Open Platform API v2 — Autenticação e Assinatura HMAC-SHA256.

Regras oficiais de assinatura (docs.open.shopee.com):
  - sign = HMAC_SHA256(base_string, partner_key).hexdigest()
  - Public API  (sem loja):  base = partner_id + path + timestamp
  - Shop API    (com loja):  base = partner_id + path + timestamp + access_token + shop_id
  - Auth URL    (redirect):  base = partner_id + path + timestamp   (path = /api/v2/shop/auth_partner)

Toda request precisa de: partner_id, timestamp (unix, janela de 5 min), sign.
Shop-level APIs adicionam: access_token + shop_id na querystring.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass
from enum import Enum


class ShopeeEnv(str, Enum):
    PROD = "https://partner.shopeemobile.com"
    TEST = "https://partner.test-stable.shopeemobile.com"


@dataclass(frozen=True)
class ShopeeCredentials:
    partner_id: int
    partner_key: str
    env: ShopeeEnv = ShopeeEnv.PROD


def _sign(base_string: str, partner_key: str) -> str:
    """Assinatura HMAC-SHA256 hexadecimal exigida pela Open Platform v2."""
    return hmac.new(
        partner_key.encode("utf-8"),
        base_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def sign_public(creds: ShopeeCredentials, path: str, timestamp: int | None = None) -> dict:
    """
    Assina chamadas de nível público (sem shop):
    base_string = partner_id + path + timestamp
    """
    ts = timestamp or int(time.time())
    base = f"{creds.partner_id}{path}{ts}"
    return {
        "partner_id": creds.partner_id,
        "timestamp": ts,
        "sign": _sign(base, creds.partner_key),
    }


def sign_shop(
    creds: ShopeeCredentials,
    path: str,
    access_token: str,
    shop_id: int,
    timestamp: int | None = None,
) -> dict:
    """
    Assina chamadas de nível loja (shop-level):
    base_string = partner_id + path + timestamp + access_token + shop_id
    """
    ts = timestamp or int(time.time())
    base = f"{creds.partner_id}{path}{ts}{access_token}{shop_id}"
    return {
        "partner_id": creds.partner_id,
        "timestamp": ts,
        "access_token": access_token,
        "shop_id": shop_id,
        "sign": _sign(base, creds.partner_key),
    }


def build_auth_url(creds: ShopeeCredentials, redirect_url: str) -> str:
    """
    Gera a URL de autorização OAuth2 para o lojista conceder acesso.
    Após o consentimento, a Shopee redireciona com ?code=...&shop_id=...
    """
    path = "/api/v2/shop/auth_partner"
    params = sign_public(creds, path)
    return (
        f"{creds.env.value}{path}"
        f"?partner_id={params['partner_id']}"
        f"&timestamp={params['timestamp']}"
        f"&sign={params['sign']}"
        f"&redirect={redirect_url}"
    )


# --------------------------------------------------------------------------
# Endpoints de token (v2)
# --------------------------------------------------------------------------

PATH_TOKEN_GET = "/api/v2/auth/token/get"            # troca code -> tokens (válido 1x)
PATH_TOKEN_REFRESH = "/api/v2/auth/access_token/get"  # refresh_token -> novo par de tokens

# TTLs oficiais
ACCESS_TOKEN_TTL_S = 4 * 3600        # ~4 horas
REFRESH_TOKEN_TTL_S = 30 * 24 * 3600  # ~30 dias


def token_get_payload(partner_id: int, code: str, shop_id: int) -> dict:
    """Body do POST para PATH_TOKEN_GET (a assinatura vai na querystring)."""
    return {"code": code, "shop_id": shop_id, "partner_id": partner_id}


def token_refresh_payload(partner_id: int, refresh_token: str, shop_id: int) -> dict:
    """Body do POST para PATH_TOKEN_REFRESH."""
    return {
        "refresh_token": refresh_token,
        "shop_id": shop_id,
        "partner_id": partner_id,
    }
