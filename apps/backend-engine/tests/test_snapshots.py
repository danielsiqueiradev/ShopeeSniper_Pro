"""Deltas de vendas por data (espelha vw_sales_by_date_velocity)."""

from app.services.snapshots import compute_sales_deltas


def snap(date, sold, price=50.0):
    return {"snapshot_date": date, "historical_sold": sold, "price": price}


class TestSalesDeltas:
    def test_first_day_null(self):
        out = compute_sales_deltas([snap("2026-10-01", 100)])
        assert out[0]["sales_on_date"] is None

    def test_daily_delta(self):
        out = compute_sales_deltas([
            snap("2026-10-01", 100),
            snap("2026-10-02", 110),
            snap("2026-10-03", 130),
        ])
        assert [o["sales_on_date"] for o in out] == [None, 10, 20]
        assert out[2]["revenue_on_date"] == 20 * 50.0

    def test_counter_reset_clamped_zero(self):
        """Shopee reseta o contador → delta negativo vira 0, não -80."""
        out = compute_sales_deltas([
            snap("2026-10-01", 130),
            snap("2026-10-02", 50),
        ])
        assert out[1]["sales_on_date"] == 0
        assert out[1]["revenue_on_date"] == 0

    def test_collection_gap_normalized(self):
        """Gap de 3 dias: delta 30 → avg normalizado 10/dia."""
        out = compute_sales_deltas([
            snap("2026-10-01", 100),
            snap("2026-10-04", 130),
        ])
        assert out[1]["days_since_prev"] == 3
        assert out[1]["sales_on_date"] == 30
        assert out[1]["avg_daily_normalized"] == 10.0

    def test_unsorted_input_sorted(self):
        out = compute_sales_deltas([
            snap("2026-10-03", 130),
            snap("2026-10-01", 100),
            snap("2026-10-02", 110),
        ])
        assert out[0]["snapshot_date"] == "2026-10-01"
        assert [o["sales_on_date"] for o in out] == [None, 10, 20]

    def test_price_used_from_snapshot_day(self):
        out = compute_sales_deltas([
            snap("2026-10-01", 100, price=50.0),
            snap("2026-10-02", 110, price=60.0),
        ])
        assert out[1]["revenue_on_date"] == 10 * 60.0
