from app.services.opportunity_score import (
    DemandSignals, SellerSignals, compute_opportunity_score,
)


def test_hot_opportunity():
    """Alta demanda + seller fraco + nicho pulverizado + dor alta = HOT."""
    r = compute_opportunity_score(
        DemandSignals(avg_daily_30d=50.0, trend_label="rising"),
        SellerSignals(rating_star=4.5, response_rate=70,
                      ship_prep_days=3.0, follower_count=300,
                      is_official=False),
        top3_share=0.20,
        negative_ratio=0.15,
    )
    assert r.score >= 70
    assert r.label == "hot"
    assert r.factors["seller_vuln"]["detail"]["rating"]["points"] == 30


def test_avoid_strong_seller():
    """Demanda baixa + seller forte (Mall, rating alto) = avoid."""
    r = compute_opportunity_score(
        DemandSignals(avg_daily_30d=1.0, trend_label="falling"),
        SellerSignals(rating_star=4.9, response_rate=98,
                      ship_prep_days=0.5, follower_count=50000,
                      is_official=True),
        top3_share=0.80,
        negative_ratio=0.02,
    )
    assert r.score < 25
    assert r.label == "avoid"


def test_missing_data_degrades_gracefully():
    r = compute_opportunity_score(
        DemandSignals(avg_daily_30d=None, trend_label="insufficient_data"),
        SellerSignals(None, None, None, None),
    )
    assert 0 <= r.score <= 100
    assert r.factors["demand"]["reason"] == "sem dados de velocidade"


def test_falling_trend_penalized_vs_rising():
    seller = SellerSignals(4.8, 85, 1.5, 5000, False)
    rising = compute_opportunity_score(DemandSignals(20, "rising"), seller)
    falling = compute_opportunity_score(DemandSignals(20, "falling"), seller)
    assert rising.score > falling.score


def test_weights_sum_to_one():
    r = compute_opportunity_score(
        DemandSignals(30, "stable"),
        SellerSignals(4.6, 75, 2.5, 800, False),
        top3_share=0.4, negative_ratio=0.08,
    )
    expected = (r.factors["demand"]["score"] * 0.40
                + r.factors["seller_vuln"]["score"] * 0.30
                + r.factors["concentration"]["score"] * 0.15
                + r.factors["review_pain"]["score"] * 0.15)
    assert r.score == round(min(100, expected), 1)
