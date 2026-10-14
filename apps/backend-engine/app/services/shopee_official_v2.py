"""Cliente oficial Shopee Open Platform API v2 (gestão da própria loja).

Autenticação: OAuth2 + assinatura HMAC-SHA256.
  sign = HMAC_SHA256(partner_key, partner_id + path + timestamp
                     + access_token + shop_id)
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

PROD_HOST = "https://partner.shopeemobile.com"
TEST_HOST = "https://partner.test-stable.shopeemobile.com"


@dataclass
class ShopeeOfficialClient:
    partner_id: int
    partner_key: str
    host: str = PROD_HOST
    access_token: str = ""
    shop_id: int | None = None
    _http: Any = field(default=None, repr=False)  # httpx.Client injetável p/ testes

    # ------------------------------------------------------------------
    # assinatura
    # ------------------------------------------------------------------
    def sign(
        self,
        path: str,
        timestamp: int,
        access_token: str | None = None,
        shop_id: int | None = None,
    ) -> str:
        """HMAC-SHA256 hex da base string partner_id+path+ts+token+shop_id."""
        base = (
            f"{self.partner_id}{path}{timestamp}"
            f"{access_token or ''}{shop_id or ''}"
        )
        return hmac.new(
            self.partner_key.encode(), base.encode(), hashlib.sha256
        ).hexdigest()

    def _signed_url(
        self,
        path: str,
        extra_params: dict[str, Any] | None = None,
        *,
        needs_token: bool = True,
        timestamp: int | None = None,
    ) -> str:
        ts = timestamp or int(time.time())
        token = self.access_token if needs_token else ""
        shop = self.shop_id if needs_token else None
        params: dict[str, Any] = {
            "partner_id": self.partner_id,
            "timestamp": ts,
            "sign": self.sign(path, ts, token, shop),
        }
        if needs_token:
            if not token or shop is None:
                raise RuntimeError(
                    "access_token e shop_id são obrigatórios p/ esta rota"
                )
            params["access_token"] = token
            params["shop_id"] = shop
        if extra_params:
            params.update(extra_params)
        return f"{self.host}{path}?{urlencode(params)}"

    @property
    def http(self):
        if self._http is None:
            import httpx

            self._http = httpx.Client(timeout=30)
        return self._http

    # ------------------------------------------------------------------
    # OAuth2
    # ------------------------------------------------------------------
    def auth_url(self, redirect_url: str) -> str:
        """URL pra o seller autorizar a loja (v1 — rota pública de auth)."""
        path = "/api/v2/shop/auth_partner"
        ts = int(time.time())
        params = urlencode({
            "partner_id": self.partner_id,
            "redirect": redirect_url,
            "timestamp": ts,
            "sign": self.sign(path, ts),
        })
        return f"{self.host}{path}?{params}"

    def exchange_token(self, code: str, shop_id: int) -> dict:
        """Troca o `code` do callback por access_token + refresh_token."""
        path = "/api/v2/auth/token/get"
        url = self._signed_url(path, needs_token=False)
        resp = self.http.post(url, json={
            "code": code,
            "partner_id": self.partner_id,
            "shop_id": shop_id,
        })
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data.get("access_token", "")
        self.shop_id = shop_id
        return data

    def refresh_token(self, refresh_token: str, shop_id: int) -> dict:
        path = "/api/v2/auth/access_token/get"
        url = self._signed_url(path, needs_token=False)
        resp = self.http.post(url, json={
            "refresh_token": refresh_token,
            "partner_id": self.partner_id,
            "shop_id": shop_id,
        })
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data.get("access_token", self.access_token)
        return data

    # ------------------------------------------------------------------
    # pedidos & financeiro
    # ------------------------------------------------------------------
    def get_order_list(
        self,
        time_from: int,
        time_to: int,
        page_size: int = 50,
        cursor: str = "",
    ) -> dict:
        path = "/api/v2/order/get_order_list"
        url = self._signed_url(path, {
            "time_range_field": "create_time",
            "time_from": time_from,
            "time_to": time_to,
            "page_size": page_size,
            "cursor": cursor,
        })
        resp = self.http.get(url)
        resp.raise_for_status()
        return resp.json()

    def get_order_detail(self, order_sn_list: list[str]) -> dict:
        path = "/api/v2/order/get_order_detail"
        url = self._signed_url(path, {
            "order_sn_list": ",".join(order_sn_list),
            "response_optional_fields": "item_list,buyer_total_amount",
        })
        resp = self.http.get(url)
        resp.raise_for_status()
        return resp.json()

    def get_escrow_detail(self, order_sn: str) -> dict:
        """Auditoria: quanto a Shopee realmente descontou no pedido."""
        path = "/api/v2/payment/get_escrow_detail"
        url = self._signed_url(path, {"order_sn": order_sn})
        resp = self.http.get(url)
        resp.raise_for_status()
        return resp.json()
