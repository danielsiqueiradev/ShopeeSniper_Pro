"""
Cliente HTTP para a Shopee Open Platform v2.

Responsabilidades:
  - Montar querystring assinada (via shopee_auth)
  - Refresh automático do access_token quando expirado (TTL ~4h)
  - Respeitar rate limit (1000 req/min por app) com token bucket simples
  - Retry exponencial em 429/5xx
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Coroutine

import httpx

from .shopee_auth import (
    PATH_TOKEN_GET,
    PATH_TOKEN_REFRESH,
    ShopeeCredentials,
    sign_public,
    sign_shop,
    token_get_payload,
    token_refresh_payload,
)

logger = logging.getLogger(__name__)

RATE_LIMIT_RPM = 900  # margem de segurança sobre o limite oficial de 1000/min


class RateLimiter:
    """Token bucket simples (asyncio-safe)."""

    def __init__(self, rpm: int = RATE_LIMIT_RPM):
        self._interval = 60.0 / rpm
        self._lock = asyncio.Lock()
        self._next_at = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self._next_at:
                await asyncio.sleep(self._next_at - now)
            self._next_at = max(now, self._next_at) + self._interval


@dataclass
class ShopTokens:
    access_token: str
    refresh_token: str
    expires_at: float          # epoch seconds
    refresh_expires_at: float


class ShopeeAPIError(Exception):
    def __init__(self, error: str, message: str, request_id: str | None = None):
        super().__init__(f"{error}: {message}")
        self.error = error
        self.message = message
        self.request_id = request_id


class ShopeeClient:
    """
    Uso:
        client = ShopeeClient(creds, tokens, on_token_refresh=repo.save_tokens)
        orders = await client.shop_get("/api/v2/order/get_order_list", params={...})
    """

    def __init__(
        self,
        creds: ShopeeCredentials,
        shop_id: int,
        tokens: ShopTokens,
        on_token_refresh: Callable[[ShopTokens], Coroutine[Any, Any, None]] | None = None,
        rate_limiter: RateLimiter | None = None,
    ):
        self.creds = creds
        self.shop_id = shop_id
        self.tokens = tokens
        self._on_refresh = on_token_refresh
        self._rl = rate_limiter or RateLimiter()
        self._http = httpx.AsyncClient(base_url=creds.env.value, timeout=30.0)

    # ------------------------------------------------------------------
    # Token lifecycle
    # ------------------------------------------------------------------

    async def _ensure_token(self) -> None:
        # Renova 5 min antes de expirar
        if time.time() < self.tokens.expires_at - 300:
            return
        logger.info("Access token expirando — renovando para shop %s", self.shop_id)

        qs = sign_public(self.creds, PATH_TOKEN_REFRESH)
        body = token_refresh_payload(
            self.creds.partner_id, self.tokens.refresh_token, self.shop_id
        )
        data = await self._post(PATH_TOKEN_REFRESH, qs, body)

        self.tokens = ShopTokens(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=time.time() + data["expire_in"],
            refresh_expires_at=self.tokens.refresh_expires_at,
        )
        if self._on_refresh:
            await self._on_refresh(self.tokens)

    @staticmethod
    def exchange_code_payload(partner_id: int, code: str, shop_id: int) -> dict:
        return token_get_payload(partner_id, code, shop_id)

    # ------------------------------------------------------------------
    # HTTP core
    # ------------------------------------------------------------------

    async def _post(self, path: str, query: dict, body: dict) -> dict:
        resp = await self._http.post(path, params=query, json=body)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("error"):
            raise ShopeeAPIError(
                payload["error"], payload.get("message", ""), payload.get("request_id")
            )
        return payload.get("response", payload)

    async def shop_get(
        self, path: str, params: dict | None = None, max_retries: int = 3
    ) -> dict:
        """GET autenticado em endpoint shop-level, com retry em 429/5xx."""
        await self._ensure_token()

        for attempt in range(max_retries + 1):
            qs = sign_shop(
                self.creds, path, self.tokens.access_token, self.shop_id
            )
            qs.update(params or {})

            await self._rl.acquire()
            resp = await self._http.get(path, params=qs)

            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == max_retries:
                    resp.raise_for_status()
                backoff = 2 ** attempt
                logger.warning("HTTP %s em %s — retry em %ss", resp.status_code, path, backoff)
                await asyncio.sleep(backoff)
                continue

            resp.raise_for_status()
            payload = resp.json()
            if payload.get("error"):
                # token expirado mid-flight -> força refresh e tenta de novo
                if payload["error"] in ("invalid_acceess_token", "error_auth") and attempt < max_retries:
                    self.tokens.expires_at = 0
                    await self._ensure_token()
                    continue
                raise ShopeeAPIError(
                    payload["error"], payload.get("message", ""), payload.get("request_id")
                )
            return payload.get("response", payload)

        raise ShopeeAPIError("max_retries", f"{path} excedeu tentativas")

    async def close(self) -> None:
        await self._http.aclose()


# --------------------------------------------------------------------------
# Wrappers dos endpoints usados pelo Módulo Interno
# --------------------------------------------------------------------------

async def fetch_orders(
    client: ShopeeClient, time_from: int, time_to: int, page_size: int = 100
) -> list[dict]:
    """Pagina /api/v2/order/get_order_list em uma janela de até 15 dias."""
    path = "/api/v2/order/get_order_list"
    orders: list[dict] = []
    cursor = ""
    while True:
        resp = await client.shop_get(path, {
            "time_range_field": "create_time",
            "time_from": time_from,
            "time_to": time_to,
            "page_size": page_size,
            "cursor": cursor,
            "response_optional_fields": "order_status",
        })
        orders.extend(resp.get("order_list", []))
        if not resp.get("more"):
            break
        cursor = resp.get("next_cursor", "")
    return orders


async def fetch_ads_daily(
    client: ShopeeClient, start_date: str, end_date: str
) -> dict:
    """Relatório diário de Shopee Ads (GMS). Endpoint: /api/v2/ads/get_total_cpc_data_daily."""
    return await client.shop_get(
        "/api/v2/ads/get_total_cpc_data_daily",
        {"start_date": start_date, "end_date": end_date},
    )
