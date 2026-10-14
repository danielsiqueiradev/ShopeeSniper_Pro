import hashlib
import hmac

from app.services.sentiment_miner import classify_review, summarize_pains
from app.services.shopee_auth import (
    ShopeeCredentials, ShopeeEnv, build_auth_url, sign_public, sign_shop,
)

CREDS = ShopeeCredentials(partner_id=12345, partner_key="mysecretkey",
                          env=ShopeeEnv.TEST)


def test_sign_shop_matches_manual_hmac():
    path = "/api/v2/order/get_order_list"
    s = sign_shop(CREDS, path, "TOKEN", 999, timestamp=1700000000)
    base = "12345/api/v2/order/get_order_list1700000000TOKEN999"
    expected = hmac.new(b"mysecretkey", base.encode(),
                        hashlib.sha256).hexdigest()
    assert s["sign"] == expected
    assert s["access_token"] == "TOKEN"
    assert s["shop_id"] == 999


def test_sign_public_has_no_shop_fields():
    s = sign_public(CREDS, "/api/v2/auth/token/get", timestamp=1700000000)
    assert "access_token" not in s and "shop_id" not in s
    base = "12345/api/v2/auth/token/get1700000000"
    assert s["sign"] == hmac.new(b"mysecretkey", base.encode(),
                               hashlib.sha256).hexdigest()


def test_auth_url_structure():
    url = build_auth_url(CREDS, "https://app.example.com/cb")
    assert url.startswith(f"{ShopeeEnv.TEST.value}/api/v2/shop/auth_partner")
    assert "partner_id=12345" in url
    assert "redirect=https://app.example.com/cb" in url


def test_pain_miner_categories():
    c = classify_review(1, "Produto veio com defeito e o tamanho errado")
    assert "defeito" in c.pain_categories
    assert "tamanho" in c.pain_categories
    assert c.sentiment == "negative"


def test_pain_miner_fallback_outros():
    c = classify_review(1, "horrível, péssimo")
    assert c.pain_categories == ["outros"]


def test_pain_miner_positive_review():
    c = classify_review(5, "ótimo produto")
    assert c.sentiment == "positive"
    assert c.pain_categories == []


def test_summarize_pains_aggregation():
    reviews = [
        (1, "defeito total", ["defeito"]),
        (2, "tamanho errado e defeito", ["tamanho", "defeito"]),
        (5, "perfeito", []),                    # ignorada (não é dor)
        (3, "demorou muito", ["atraso"]),
    ]
    top = summarize_pains(reviews)
    assert top[0]["category"] == "defeito"
    assert top[0]["count"] == 2
    assert top[0]["pct"] == 0.5                 # 2 de 4 ocorrências
    assert {t["category"] for t in top} == {"defeito", "tamanho", "atraso"}
