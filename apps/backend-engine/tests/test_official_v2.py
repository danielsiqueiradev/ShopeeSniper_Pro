"""Shopee Open Platform v2: assinatura HMAC-SHA256 e URLs assinadas."""

import hashlib
import hmac
from urllib.parse import parse_qs, urlparse

import pytest

from app.services.shopee_official_v2 import ShopeeOfficialClient

PARTNER_ID = 123456
PARTNER_KEY = "0123456789abcdef0123456789abcdef"


def make_client(token="tok123", shop=999888):
    return ShopeeOfficialClient(
        partner_id=PARTNER_ID, partner_key=PARTNER_KEY,
        access_token=token, shop_id=shop,
    )


class TestSignature:
    def test_sign_full_base_string(self):
        """sign = HMAC(key, partner_id + path + ts + access_token + shop_id)."""
        c = make_client()
        path = "/api/v2/order/get_order_list"
        ts = 1_700_000_000
        expected_base = f"{PARTNER_ID}{path}{ts}tok123999888"
        expected = hmac.new(
            PARTNER_KEY.encode(), expected_base.encode(), hashlib.sha256
        ).hexdigest()
        assert c.sign(path, ts, "tok123", 999888) == expected

    def test_sign_without_token_shop(self):
        """Rotas públicas (auth/token): base sem token e shop_id."""
        c = make_client()
        path = "/api/v2/auth/token/get"
        ts = 1_700_000_000
        expected_base = f"{PARTNER_ID}{path}{ts}"
        expected = hmac.new(
            PARTNER_KEY.encode(), expected_base.encode(), hashlib.sha256
        ).hexdigest()
        assert c.sign(path, ts) == expected

    def test_signed_url_params(self):
        c = make_client()
        url = c._signed_url("/api/v2/order/get_order_list",
                            {"page_size": 20}, timestamp=1_700_000_000)
        qs = parse_qs(urlparse(url).query)
        assert qs["partner_id"] == [str(PARTNER_ID)]
        assert qs["access_token"] == ["tok123"]
        assert qs["shop_id"] == ["999888"]
        assert qs["page_size"] == ["20"]
        assert len(qs["sign"][0]) == 64  # sha256 hex

    def test_missing_token_raises(self):
        c = make_client(token="", shop=None)
        with pytest.raises(RuntimeError):
            c._signed_url("/api/v2/order/get_order_list")

    def test_public_route_no_token_needed(self):
        c = make_client(token="", shop=None)
        url = c._signed_url("/api/v2/auth/token/get",
                            needs_token=False, timestamp=1_700_000_000)
        qs = parse_qs(urlparse(url).query)
        assert "access_token" not in qs
        assert "sign" in qs


class TestApiMethods:
    def test_get_order_list_builds_signed_call(self):
        """Mock do http interno pra validar a chamada sem rede."""
        c = make_client()

        class FakeResp:
            def raise_for_status(self): pass
            def json(self): return {"response": {"order_list": []}}

        class FakeHttp:
            last_url = None
            def get(self, url):
                FakeHttp.last_url = url
                return FakeResp()

        c._http = FakeHttp()
        out = c.get_order_list(time_from=1, time_to=2)
        assert out["response"]["order_list"] == []
        assert "/api/v2/order/get_order_list" in FakeHttp.last_url
        assert "time_from=1" in FakeHttp.last_url
        assert "access_token=tok123" in FakeHttp.last_url

    def test_escrow_detail_path(self):
        c = make_client()

        class FakeResp:
            def raise_for_status(self): pass
            def json(self): return {"response": {}}

        class FakeHttp:
            last_url = None
            def get(self, url):
                FakeHttp.last_url = url
                return FakeResp()

        c._http = FakeHttp()
        c.get_escrow_detail("SN001")
        assert "/api/v2/payment/get_escrow_detail" in FakeHttp.last_url
        assert "order_sn=SN001" in FakeHttp.last_url
