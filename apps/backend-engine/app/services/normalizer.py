"""Normalizador de payloads internos da Shopee (v4 web API).

- Preços vêm ×100000 (R$ 49,90 → 4990000). Toda chave de preço é dividida.
- `ctime` (unix seconds) vira data de criação + idade do anúncio em dias.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

PRICE_KEYS = {
    "price", "price_min", "price_max", "price_min_before_discount",
    "price_max_before_discount", "price_before_discount", "raw_price",
}

PRICE_DIVISOR = 100_000


def normalize_price(value: Any) -> float:
    """Shopee guarda preços × 100000. Já normalizado (float pequeno) passa direto."""
    if value is None:
        return 0.0
    v = float(value)
    if v > 100_000:      # qualquer valor "grande" é raw ×100000
        return round(v / PRICE_DIVISOR, 2)
    return round(v, 2)


def deep_normalize_prices(obj: Any) -> Any:
    """Percorre dict/list e divide por 100000 todas as chaves de preço."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in PRICE_KEYS and isinstance(v, (int, float)):
                out[k] = round(v / PRICE_DIVISOR, 2)
            else:
                out[k] = deep_normalize_prices(v)
        return out
    if isinstance(obj, list):
        return [deep_normalize_prices(i) for i in obj]
    return obj


def ctime_to_fields(ctime: Any) -> dict[str, Any]:
    """ctime unix → {'created_date': 'DD/MM/YYYY', 'age_days': int}"""
    try:
        ts = int(ctime)
    except (TypeError, ValueError):
        return {"created_date": None, "age_days": None}
    dt = datetime.fromtimestamp(ts)
    return {
        "created_date": dt.strftime("%d/%m/%Y"),
        "age_days": max(0, int((time.time() - ts) // 86400)),
    }


def extract_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extrai a lista de itens dos formatos de resposta conhecidos:
    - search_items / recommend: {'items': [{'item_basic': {...}}]}
    - item/get: {'data': {...}}  → 1 item
    - pdp/get_pc: {'data': {'item': {...}}}
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)

    if isinstance(data, dict) and isinstance(data.get("items"), list):
        out = []
        for it in data["items"]:
            out.append(it.get("item_basic", it) if isinstance(it, dict) else it)
        return [i for i in out if isinstance(i, dict)]

    if isinstance(data, dict) and isinstance(data.get("item"), dict):
        return [data["item"]]

    if isinstance(data, dict) and ("itemid" in data or "item_id" in data):
        return [data]

    return []


def extract_ratings(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """item/get_ratings → {'data': {'ratings': [...]}}"""
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)
    ratings = data.get("ratings") if isinstance(data, dict) else None
    return [r for r in ratings if isinstance(r, dict)] if ratings else []


def sanitize_item(raw: dict[str, Any]) -> dict[str, Any]:
    """Item normalizado pronto pra ingest/analytics."""
    item = deep_normalize_prices(raw)
    item.update(ctime_to_fields(item.get("ctime")))
    # aliases comuns entre rotas
    if "item_id" in item and "itemid" not in item:
        item["itemid"] = item["item_id"]
    if "shop_id" in item and "shopid" not in item:
        item["shopid"] = item["shop_id"]
    sold = item.get("historical_sold") or item.get("sold") or 0
    item["historical_sold"] = int(sold) if sold else 0
    return item
