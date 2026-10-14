"""Opportunity Score: ranking e componentes."""

from app.services.opportunity_engine import (
    OpportunityInput,
    compute_opportunity_score,
)


def test_golden_opportunity_beats_stale_strong_seller():
    golden = compute_opportunity_score(OpportunityInput(
        sold_30_days=300,      # 10/dia
        age_days=45,           # anúncio novo
        sales_last_24h=15,     # acelerando
        rating_star=4.2,
        response_rate=60,
        is_official_shop=False,
        top_sku_out_of_stock=True,
    ))
    stale = compute_opportunity_score(OpportunityInput(
        sold_30_days=30,       # 1/dia
        age_days=800,
        sales_last_24h=1,
        rating_star=4.95,
        response_rate=99,
        is_official_shop=True,
    ))
    assert golden.score > stale.score
    assert golden.label in ("quente", "ouro")
    assert stale.label == "fraco"


def test_velocity_cap_at_10_per_day():
    s1 = compute_opportunity_score(OpportunityInput(sold_30_days=300))
    s2 = compute_opportunity_score(OpportunityInput(sold_30_days=900))
    # os dois saturam a base de velocidade (10/dia = 30 pts)
    assert s1.velocity_pts == s2.velocity_pts == 30.0


def test_acceleration_bonus(self_=None):
    base = OpportunityInput(sold_30_days=150, sales_last_24h=2)      # 5/dia, lento
    accel = OpportunityInput(sold_30_days=150, sales_last_24h=10)    # acelerando
    s_base = compute_opportunity_score(base)
    s_acc = compute_opportunity_score(accel)
    assert s_acc.accelerating is True
    assert s_acc.velocity_pts == s_base.velocity_pts + 10.0


def test_vulnerability_components():
    weak = compute_opportunity_score(OpportunityInput(
        sold_30_days=0, rating_star=3.9, response_rate=50,
        is_official_shop=False, top_sku_out_of_stock=True,
    ))
    # 15 (rating<4.0) + 10 (resp<85) + 5 (não oficial) + 10 (sem estoque) = 40
    assert weak.vulnerability_pts == 40.0

    strong = compute_opportunity_score(OpportunityInput(
        sold_30_days=0, rating_star=4.95, response_rate=99,
        is_official_shop=True,
    ))
    assert strong.vulnerability_pts == 0.0


def test_freshness_tiers():
    fresh_hot = compute_opportunity_score(OpportunityInput(
        sold_30_days=180, age_days=60))    # 6/dia, <90d → 20 pts
    assert fresh_hot.freshness_pts == 20.0

    old = compute_opportunity_score(OpportunityInput(
        sold_30_days=180, age_days=400))
    assert old.freshness_pts == 0.0


def test_score_clamped_0_100():
    s = compute_opportunity_score(OpportunityInput(
        sold_30_days=9999, age_days=10, sales_last_24h=999,
        rating_star=1.0, response_rate=10, top_sku_out_of_stock=True,
    ))
    assert 0 <= s.score <= 100
