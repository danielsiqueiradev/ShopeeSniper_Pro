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


def _is_item(node: Any) -> bool:
    """Um dict vira item se tem itemid/item_id. Campos ricos (price, name…)
    são bônus — stubs de PDP às vezes vêm minimalistas."""
    return isinstance(node, dict) and bool(
        node.get("itemid") or node.get("item_id")
    )


def extract_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Deep-scan: qualquer objeto com itemid + campos de produto vira item.

    Cobre os shapes conhecidos (search_items → items[].item_basic,
    item/get → data, pdp/get_pc → data.item) e variações aninhadas
    (recommend → sections[].data.item, etc.).
    """
    if not isinstance(payload, dict):
        return []
    out: list[dict] = []
    seen: set = set()
    budget = [4000]

    def push(it: dict) -> None:
        iid = it.get("itemid") or it.get("item_id")
        if iid is None:
            return
        if iid in seen:
            # rating/ref pobre em campos pode vir antes do item completo:
            # mantém a versão mais rica
            idx = next(i for i, x in enumerate(out)
                       if (x.get("itemid") or x.get("item_id")) == iid)
            if len(it) > len(out[idx]):
                out[idx] = it
            return
        seen.add(iid)
        out.append(it)

    def walk(node: Any, depth: int) -> None:
        if depth > 9 or budget[0] <= 0 or not isinstance(node, (dict, list)):
            return
        budget[0] -= 1
        if isinstance(node, list):
            for el in node:
                walk(el, depth + 1)
            return
        basic = node.get("item_basic")
        if isinstance(basic, dict):
            push(basic)
            return
        if _is_item(node):
            push(node)
            return
        for v in node.values():
            walk(v, depth + 1)

    walk(payload, 0)
    return out


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
