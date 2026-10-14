"""Testes de integração da API FastAPI (TestClient, sem rede externa)."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

client = TestClient(create_app())


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_unit_economics_endpoint():
    r = client.post("/analytics/unit-economics", json={
        "sale_price": 50.0, "supplier_cost": 15.0, "target_margin_pct": 20.0,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["net_profit"] == pytest.approx(14.0)
    assert body["cmv_teto"] == pytest.approx(19.0)
    assert body["commission"] == pytest.approx(7.0)


def test_opportunity_score_endpoint():
    r = client.post("/analytics/opportunity-score", json={
        "sold_30_days": 300, "age_days": 45, "sales_last_24h": 15,
        "rating_star": 4.2, "response_rate": 60,
    })
    assert r.status_code == 200
    assert r.json()["score"] > 50


def test_sales_by_date_endpoint():
    r = client.post("/analytics/sales-by-date", json={
        "snapshots": [
            {"snapshot_date": "2026-10-01", "historical_sold": 100, "price": 50},
            {"snapshot_date": "2026-10-02", "historical_sold": 112, "price": 50},
        ]
    })
    assert r.status_code == 200
    out = r.json()
    assert out[1]["sales_on_date"] == 12
    assert out[1]["revenue_on_date"] == 600.0


def test_pain_miner_endpoint():
    r = client.post("/analytics/pain-miner", json={
        "reviews": [
            {"rating_star": 1, "comment": "rasgou na primeira semana"},
            {"rating_star": 5, "comment": "ótimo"},
        ]
    })
    assert r.status_code == 200
    body = r.json()
    assert body["negative_reviews"] == 1
    assert "Qualidade/Material" in body["category_counts"]


def test_ingest_normalizes_prices():
    """Payload no formato search_items → itens com preço ÷100000."""
    r = client.post("/ingest/payload", json={
        "route": "/api/v4/search/search_items",
        "payload": {"items": [
            {"item_basic": {
                "itemid": 123, "shopid": 456, "name": "Produto X",
                "price": 4990000, "price_min": 4990000, "price_max": 5990000,
                "historical_sold": 500, "ctime": 1700000000,
                "item_rating": {"rating_star": 4.6, "rating_count": 200},
            }},
        ]},
    })
    assert r.status_code == 200
    body = r.json()
    assert body["items_normalized"] == 1
    snap = body["snapshots"][0]
    assert snap["itemid"] == 123
    assert snap["price"] == 49.90
    assert snap["historical_sold"] == 500
    assert snap["rating_star"] == 4.6
    # sem Supabase configurado → campo supabase vem None
    assert body["supabase"] is None


def test_ingest_empty_payload():
    r = client.post("/ingest/payload", json={
        "route": "/api/v4/search/search_items", "payload": {}})
    assert r.status_code == 200
    assert r.json()["items_normalized"] == 0


def test_official_orders_503_without_credentials():
    r = client.get("/official/orders?time_from=1&time_to=2")
    assert r.status_code == 503
