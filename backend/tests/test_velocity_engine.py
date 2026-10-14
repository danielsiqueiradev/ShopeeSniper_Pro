from datetime import date, timedelta

from app.services.velocity_engine import (
    Snapshot, compute_velocity, market_concentration, weighted_avg_ticket,
)


def _series(days=31, daily=10):
    """Snapshots DESC (D0 primeiro), acumulado crescente de `daily`/dia."""
    return [
        Snapshot(date.today() - timedelta(days=i), 1000 + (days - i) * daily, 50.0)
        for i in range(days + 1)
    ]


def test_velocity_flat_series():
    vm = compute_velocity(_series(daily=10))
    assert vm.sold_last_24h == 10
    assert vm.sold_last_7d == 70
    assert vm.sold_last_30d == 300
    assert vm.avg_daily_30d == 10.0
    assert vm.trend_label == "stable"


def test_velocity_detects_acceleration():
    snaps = [
        Snapshot(
            date.today() - timedelta(days=i),
            1000 + (30 - i) * 8 + max(0, 6 - i) * 15,  # últimos 7d a ~23/dia
            50.0,
        )
        for i in range(31)
    ]
    vm = compute_velocity(snaps)
    assert vm.trend_label == "rising"
    assert vm.trend_ratio_7v30 > 1.15


def test_velocity_no_baseline():
    vm = compute_velocity([Snapshot(date.today(), 500, 50.0)])
    assert vm.sold_last_24h is None
    assert vm.trend_label == "insufficient_data"


def test_velocity_empty():
    vm = compute_velocity([])
    assert vm.trend_label == "insufficient_data"
    assert "no_data" in vm.anomalies


def test_velocity_counter_reset_clamped():
    snaps = [
        Snapshot(date.today(), 50, 50.0),                       # reset p/ 50
        Snapshot(date.today() - timedelta(days=1), 900, 50.0),  # tinha 900
    ]
    vm = compute_velocity(snaps)
    assert vm.sold_last_24h == 0
    assert "counter_reset@1d" in vm.anomalies


def test_velocity_gap_normalized():
    # Sem snapshots entre D-5 e D-20: janela de 7d usa baseline de D-20
    snaps = [
        Snapshot(date.today() - timedelta(days=i), 1000 + (30 - i) * 10, 50.0)
        for i in list(range(0, 5)) + list(range(21, 31))
    ]
    vm = compute_velocity(snaps)
    # 7d: baseline mais próximo de D-7 é D-21 → gap de 21d > max_gap → stale
    assert vm.sold_last_7d is None
    assert any("stale_baseline" in a for a in vm.anomalies)
    # 30d ainda computável (baseline D-30)
    assert vm.sold_last_30d == 300


def test_weighted_avg_ticket():
    # 100 unid a 79.90 + 400 unid a 49.90 -> ponderado = 55.90
    assert weighted_avg_ticket([(79.9, 100), (49.9, 400)]) == 55.9
    assert weighted_avg_ticket([(50.0, 0)]) == 0.0


def test_market_concentration():
    top3, hhi = market_concentration([700, 200, 100])
    assert top3 == 1.0                        # 3 sellers = 100% do nicho
    top3_frag, _ = market_concentration([10] * 20)
    assert top3_frag == 0.15                  # pulverizado
    assert market_concentration([]) == (0.0, 0.0)
