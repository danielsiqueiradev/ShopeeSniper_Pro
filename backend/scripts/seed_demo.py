"""Seed demo — popula o banco com dados sintéticos realistas.

Gera 3 nichos, ~8 shops, ~12 produtos e 31 dias de snapshots por produto,
depois roda os engines reais (velocity + score) para preencher
product_velocity_metrics — o dashboard fica idêntico à produção.

Uso:  python scripts/seed_demo.py
"""

import random
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal
from app.models import models as m
from app.services.opportunity_score import (
    DemandSignals, SellerSignals, compute_opportunity_score,
)
from app.services.sentiment_miner import summarize_pains
from app.services.velocity_engine import (
    Snapshot, compute_velocity, market_concentration, weighted_avg_ticket,
)

random.seed(42)
db = SessionLocal()

NICHES = [
    ("Garrafas Térmicas", ["garrafa termica", "squeeze inox"]),
    ("Fone Bluetooth TWS", ["fone bluetooth", "earbuds tws"]),
    ("Organizadores de Cozinha", ["organizador cozinha", "potes hermeticos"]),
]

# (nome_base, preço, vendas/dia médias, seller fraco?)
PRODUCTS = [
    ("Garrafa Térmica Inox 2L Alça",        79.9,  22, True),
    ("Squeeze Inox 1L Com Bico",            49.9,  14, True),
    ("Garrafa Térmica 500ml LED",           39.9,   8, False),
    ("Copo Térmico Cerveja 473ml",          34.9,   5, False),
    ("Fone TWS F9 Tela LED",                29.9,  35, True),
    ("Earbuds Pro6 ANC",                    59.9,  18, False),
    ("Fone TWS M28 Gamer",                  45.9,   9, True),
    ("Kit 6 Potes Herméticos",              69.9,  12, False),
    ("Organizador Geladeira Acrílico",      24.9,  20, True),
    ("Porta Temperos Giratório",            44.9,   7, False),
    ("Lixeira Pia Suspensa 5L",             29.9,   4, False),
    ("Rack Organizador Armário",            54.9,   3, False),
]

SHOPS = [
    ("Utilidades BR",      "SP", False, 4.5, 72, 3.0,   400),
    ("Casa&Pratico",       "MG", False, 4.6, 85, 2.0,  1200),
    ("MegaStore Oficial",  "SP", True,  4.9, 98, 0.8, 85000),
    ("ImportAki",          "PR", False, 4.4, 65, 4.0,   250),
    ("TechDistribuidora",  "RS", False, 4.8, 92, 1.2, 15000),
    ("Loja Do Bem",        "BA", False, 4.7, 80, 1.5,  3000),
    ("Shopee Mall Tech",   "SP", True,  4.9, 99, 0.5, 120000),
    ("TopDeals BR",        "SC", False, 4.3, 60, 3.5,   150),
]


def gen_series(avg_daily: float, days: int = 31, trend: str = "stable"):
    """Gera acumulado de vendas realista com tendência opcional."""
    sold, out = random.randint(200, 800), []
    for i in range(days, -1, -1):
        factor = {"rising": 1 + (days - i) * 0.04,
                  "falling": 1 - (days - i) * 0.03}.get(trend, 1.0)
        sold += max(0, int(avg_daily * max(factor, 0.2) * random.uniform(0.5, 1.5)))
        d = date.today() - timedelta(days=i)
        price_jitter = random.uniform(0.95, 1.05) if random.random() < 0.15 else 1.0
        out.append((d, sold, price_jitter))
    return out


def main():
    niche_objs = {}
    for name, kws in NICHES:
        n = db.scalar(__import__("sqlalchemy").select(m.Niche)
                      .where(m.Niche.name == name)) or m.Niche(name=name, keywords=kws)
        db.add(n); db.flush()
        niche_objs[name] = n

    shop_objs = []
    for i, (name, loc, mall, rating, resp, prep, foll) in enumerate(SHOPS):
        shop_id = 900000 + i
        s = db.scalar(__import__("sqlalchemy").select(m.CompetitorShop)
                      .where(m.CompetitorShop.shop_id == shop_id)) \
            or m.CompetitorShop(shop_id=shop_id, name=name, username=name.lower().replace(" ", ""),
                                location=loc, is_official=mall)
        db.add(s); db.flush()

        snap = m.ShopDailySnapshot(
            shop_id=shop_id, snapshot_date=date.today(),
            rating_star=rating, response_rate=resp, ship_prep_days=prep,
            follower_count=foll, product_count=random.randint(50, 2000),
            rating_count=random.randint(5000, 500000))
        db.merge(snap)
        shop_objs.append((s, rating, resp, prep, foll, mall))

    niche_of = {0: 0, 1: 0, 2: 0, 3: 0,       # garrafas -> nicho 0
                4: 1, 5: 1, 6: 1,             # fones -> nicho 1
                7: 2, 8: 2, 9: 2, 10: 2, 11: 2}

    prod_meta = []
    for i, (pname, price, avg, weak) in enumerate(PRODUCTS):
        niche = list(niche_objs.values())[niche_of[i]]
        shop_idx = i % len(shop_objs) if weak else (i + 2) % len(shop_objs)
        shop = shop_objs[shop_idx][0]
        trend = "rising" if weak and avg > 10 else random.choice(
            ["stable", "stable", "falling"])

        item_id = 10000000 + i * 137
        p = db.scalar(__import__("sqlalchemy").select(m.MonitoredProduct)
                      .where(m.MonitoredProduct.item_id == item_id)) \
            or m.MonitoredProduct(
                item_id=item_id, shop_id=shop.shop_id, niche_id=niche.id,
                name=pname,
                image_url="https://cf.shopee.com.br/file/placeholder",
                product_url=f"https://shopee.com.br/x-i.{shop.shop_id}.{item_id}")
        db.add(p); db.flush()

        series = gen_series(avg, trend=trend)
        prev_sold, prev_price = None, None
        for d, sold, jitter in series:
            snap = m.ProductDailySnapshot(
                product_id=p.id, snapshot_date=d,
                price=round(price * jitter, 2),
                price_before_discount=round(price * 1.3, 2),
                stock=random.randint(50, 5000),
                historical_sold=sold,
                liked_count=sold // 3,
                comment_count=sold // 8,
                rating_star=round(random.uniform(4.2, 4.9), 1),
                rating_count=sold // 5,
                sold_delta_1d=(sold - prev_sold) if prev_sold is not None else None,
                price_changed=abs(jitter - 1.0) > 0.005)
            db.merge(snap)
            prev_sold, prev_price = sold, price * jitter

        # velocity real sobre a série gerada
        vm = compute_velocity([
            Snapshot(d, sold, price) for d, sold, _ in reversed(series)
        ])

        shop_rating, shop_resp, shop_prep, shop_foll, shop_mall = \
            shop_objs[shop_idx][1], shop_objs[shop_idx][2], shop_objs[shop_idx][3], \
            shop_objs[shop_idx][4], shop_objs[shop_idx][5]

        score = compute_opportunity_score(
            demand=DemandSignals(vm.avg_daily_30d, vm.trend_label),
            seller=SellerSignals(shop_rating, shop_resp, shop_prep, shop_foll, shop_mall),
            top3_share=0.35, negative_ratio=random.uniform(0.03, 0.15))

        db.merge(m.ProductVelocityMetrics(
            product_id=p.id, computed_at=datetime.utcnow(),
            sold_last_24h=vm.sold_last_24h or 0, sold_last_7d=vm.sold_last_7d or 0,
            sold_last_15d=vm.sold_last_15d or 0, sold_last_30d=vm.sold_last_30d or 0,
            avg_daily_7d=vm.avg_daily_7d or 0, avg_daily_30d=vm.avg_daily_30d or 0,
            trend_ratio_7v30=vm.trend_ratio_7v30,
            revenue_est_30d=(vm.sold_last_30d or 0) * price,
            opportunity_score=score.score, opportunity_factors=score.factors))

        # reviews sintéticas para produtos fracos
        if weak:
            pains = [("defeito", "Produto chegou com defeito, não funciona"),
                     ("tamanho", "Tamanho errado, menor que o anunciado"),
                     ("atraso", "Demorou 20 dias para chegar"),
                     ("embalagem", "Veio amassado, embalagem péssima")]
            reviews = []
            for j in range(random.randint(20, 60)):
                cat, txt = random.choice(pains)
                rating = random.choice([1, 1, 2, 2, 3])
                db.merge(m.ProductReview(
                    product_id=p.id, review_id=f"demo-{p.id}-{j}",
                    rating=rating, comment=txt,
                    review_date=datetime.utcnow() - timedelta(days=random.randint(1, 60)),
                    pain_categories=[cat], sentiment="negative"))
                reviews.append((rating, txt, [cat]))
            # reviews positivas para ratio realista
            for j in range(random.randint(200, 500)):
                db.merge(m.ProductReview(
                    product_id=p.id, review_id=f"demo-pos-{p.id}-{j}",
                    rating=random.choice([4, 5, 5]), comment="ótimo",
                    review_date=datetime.utcnow() - timedelta(days=random.randint(1, 90)),
                    pain_categories=[], sentiment="positive"))
            db.flush()

            total = db.scalar(__import__("sqlalchemy").select(
                __import__("sqlalchemy").func.count()).select_from(m.ProductReview)
                .where(m.ProductReview.product_id == p.id))
            neg = db.scalar(__import__("sqlalchemy").select(
                __import__("sqlalchemy").func.count()).select_from(m.ProductReview)
                .where(m.ProductReview.product_id == p.id,
                       m.ProductReview.rating <= 3))
            db.merge(m.ProductReviewsSummary(
                product_id=p.id, total_reviews=total, negative_reviews=neg,
                negative_ratio=neg / total if total else 0,
                top_pain_points=summarize_pains(reviews),
                improvement_insight="Reforce a embalagem e adicione tabela de "
                                    "medidas detalhada no anúncio — dor #1 do nicho.",
                updated_at=datetime.utcnow()))

        prod_meta.append((p, price, avg, shop_idx))

    # niche_daily_stats a partir dos produtos gerados
    for niche in niche_objs.values():
        prods = [(pm[0], pm[1], pm[2], pm[3]) for pm in prod_meta
                 if pm[0].niche_id == niche.id]
        by_seller = {}
        for _, price, avg, sidx in prods:
            by_seller[sidx] = by_seller.get(sidx, 0) + int(avg * 30)
        top3, hhi = market_concentration(list(by_seller.values()))
        db.merge(m.NicheDailyStats(
            niche_id=niche.id, stat_date=date.today(),
            top_products_count=len(prods),
            weighted_avg_ticket=weighted_avg_ticket([(pr, int(a * 30))
                                                     for _, pr, a, _ in prods]),
            total_sold_30d=sum(int(a * 30) for _, _, a, _ in prods),
            total_revenue_est=sum(pr * a * 30 for _, pr, a, _ in prods),
            top3_share=top3, hhi_index=hhi))

    db.commit()
    print(f"seed ok: {len(niche_objs)} nichos, {len(shop_objs)} shops, "
          f"{len(prod_meta)} produtos, ~{len(prod_meta) * 32} snapshots")


if __name__ == "__main__":
    main()
