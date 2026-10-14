"""Sales-by-date: replica em Python a lógica da view vw_sales_by_date_velocity
(LAG sobre historical_sold) pra uso offline/testes e deltas em tempo real."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any


def _parse_date(v: Any) -> date | None:
    if isinstance(v, date):
        return v
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def compute_sales_deltas(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dada uma série de snapshots de um item, devolve vendas/receita por data.

    Cada snapshot precisa de: snapshot_date, historical_sold, price.
    Ordena por data; delta negativo (reset do contador da Shopee) → 0.
    avg_daily_normalized divide o delta pelos dias decorridos (gaps de coleta).
    """
    rows = []
    for s in snapshots:
        d = _parse_date(s.get("snapshot_date"))
        if d is None:
            continue
        rows.append({
            "snapshot_date": d,
            "price": float(s.get("price") or 0.0),
            "historical_sold": int(s.get("historical_sold") or 0),
        })
    rows.sort(key=lambda r: r["snapshot_date"])

    out: list[dict[str, Any]] = []
    prev: dict | None = None
    for r in rows:
        if prev is None:
            sales = None
            revenue = None
            days = None
            avg_norm = None
        else:
            delta = r["historical_sold"] - prev["historical_sold"]
            days = (r["snapshot_date"] - prev["snapshot_date"]).days
            sales = max(0, delta)
            revenue = round(sales * r["price"], 2)
            avg_norm = round(sales / days, 2) if days and days > 0 else None
        out.append({
            "snapshot_date": r["snapshot_date"].isoformat(),
            "sales_on_date": sales,
            "revenue_on_date": revenue,
            "days_since_prev": days,
            "avg_daily_normalized": avg_norm,
        })
        prev = r
    return out
