"""Pain Miner: categorização de reviews negativas."""

from app.services.review_pain_miner import mine_pain_points


REVIEWS = [
    {"rating_star": 1, "comment": "Rasgou em dois dias, material frágil demais"},
    {"rating_star": 2, "comment": "Veio muito pequeno, tamanho não corresponde"},
    {"rating_star": 1, "comment": "Embalagem amassada e atrasou a entrega"},
    {"rating_star": 3, "comment": "A cor é diferente da foto do anúncio"},
    {"rating_star": 5, "comment": "Produto perfeito, chegou rápido"},
    {"rating_star": 4, "comment": "Bom custo-benefício"},
]


def test_only_negative_reviews_counted():
    rep = mine_pain_points(REVIEWS)
    assert rep.total_reviews == 6
    assert rep.negative_reviews == 4


def test_categorization():
    rep = mine_pain_points(REVIEWS)
    assert rep.category_counts["Qualidade/Material"] == 1
    assert rep.category_counts["Tamanho/Medidas"] == 1
    assert rep.category_counts["Embalagem/Transporte"] == 1
    assert rep.category_counts["Diferente da Foto"] == 1


def test_top_keywords_and_checklist():
    rep = mine_pain_points(REVIEWS)
    keywords = [k for k, _ in rep.top_keywords]
    assert any("rasgou" in k or "fragil" in k for k in keywords)
    assert len(rep.checklist) == len(rep.category_counts)
    assert rep.top_category is not None


def test_multiple_categories_one_review():
    rep = mine_pain_points([
        {"rating_star": 1,
         "comment": "Rasgou, chegou amassado e ainda por cima era pequeno"},
    ])
    assert rep.category_counts["Qualidade/Material"] == 1
    assert rep.category_counts["Embalagem/Transporte"] == 1
    assert rep.category_counts["Tamanho/Medidas"] == 1


def test_no_reviews():
    rep = mine_pain_points([])
    assert rep.negative_reviews == 0
    assert rep.top_category is None
    assert rep.checklist == []


def test_accent_insensitive():
    rep = mine_pain_points([
        {"rating_star": 1, "comment": "produto FRÁGIL, QUEBROU no transporte"},
    ])
    assert rep.category_counts.get("Qualidade/Material") == 1
