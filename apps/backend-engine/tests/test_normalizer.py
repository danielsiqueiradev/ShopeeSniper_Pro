"""Normalização de payloads internos da Shopee (÷100000, ctime)."""

import time
from datetime import datetime

from app.services.normalizer import (
    ctime_to_fields,
    deep_normalize_prices,
    extract_items,
    extract_ratings,
    normalize_price,
    sanitize_item,
)


class TestPriceNormalization:
    def test_raw_shopee_price(self):
        """R$ 49,90 chega como 4990000."""
        assert normalize_price(4_990_000) == 49.90

    def test_price_min_max(self):
        data = {"price": 5990000, "price_min": 4990000, "price_max": 7990000}
        out = deep_normalize_prices(data)
        assert out == {"price": 59.90, "price_min": 49.90, "price_max": 79.90}

    def test_nested_structures(self):
        data = {"items": [{"item_basic": {"price": 1000000}}]}
        out = deep_normalize_prices(data)
        assert out["items"][0]["item_basic"]["price"] == 10.0

    def test_already_normalized_untouched(self):
        assert normalize_price(49.90) == 49.90

    def test_none(self):
        assert normalize_price(None) == 0.0


class TestCtime:
    def test_date_and_age(self):
        ts = int(time.time()) - 90 * 86400
        out = ctime_to_fields(ts)
        assert out["age_days"] == 90
        assert out["created_date"] == datetime.fromtimestamp(ts).strftime("%d/%m/%Y")

    def test_bad_ctime(self):
        assert ctime_to_fields(None) == {"created_date": None, "age_days": None}


class TestExtraction:
    def test_search_items_format(self):
        payload = {"data": {"items": [
            {"item_basic": {"itemid": 1, "name": "A"}},
            {"item_basic": {"itemid": 2, "name": "B"}},
        ]}}
        items = extract_items(payload)
        assert [i["itemid"] for i in items] == [1, 2]

    def test_items_without_data_wrapper(self):
        payload = {"items": [{"item_basic": {"itemid": 9}}]}
        assert extract_items(payload)[0]["itemid"] == 9

    def test_pdp_single_item(self):
        payload = {"data": {"item": {"itemid": 42}}}
        assert extract_items(payload)[0]["itemid"] == 42

    def test_ratings(self):
        payload = {"data": {"ratings": [{"rating_star": 1}, {"rating_star": 5}]}}
        assert len(extract_ratings(payload)) == 2

    def test_sanitize_item_aliases(self):
        raw = {"item_id": 7, "shop_id": 8, "price": 2500000, "ctime": 1700000000}
        it = sanitize_item(raw)
        assert it["itemid"] == 7
        assert it["shopid"] == 8
        assert it["price"] == 25.0
        assert it["age_days"] is not None
