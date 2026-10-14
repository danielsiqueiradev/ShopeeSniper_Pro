"""
Workers — pipeline diário de coleta e agregação.

Fluxo do Sales Velocity Engine (por produto, por dia):

    collector.fetch_public_item(item_id)          # dados públicos do anúncio
        └─> INSERT product_daily_snapshots (D0)
        └─> SELECT snapshots D0..D-30
        └─> compute_velocity()                    # deltas 24h/7d/15d/30d
        └─> UPSERT product_velocity_metrics
        └─> compute_opportunity_score()           # radar de vulnerabilidade

Observação sobre coleta pública: os endpoints internos de busca da Shopee web
(open.api.shopee...) não são parte da Open Platform oficial e têm rate limit
agressivo. `fetch_public_item` é o ponto de integração — plugue aqui seu
collector (scrapy/playwright/API parceira) respeitando ToS e LGPD.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from celery import shared_task
from sqlalchemy import func, select, text

from app.database import SessionLocal
from app.models import models as m
from app.services import collector
from app.services import collector_web
from app.services.opportunity_score import (
    DemandSignals, SellerSignals, compute_opportunity_score,
)
from app.services.sentiment_miner import classify_review, summarize_pains
from app.services.velocity_engine import (
    Snapshot, compute_velocity, market_concentration, weighted_avg_ticket,
)

logger = logging.getLogger(__name__)

# Injeta o provider concreto de coleta (endpoints públicos v4).
# Para usar outro provider, troque aqui — tasks.py não muda.
_collector = collector_web.bind()


# ==========================================================================
# FAN-OUT — distribuição das tarefas diárias
# ==========================================================================

@shared_task(bind=True, max_retries=3)
def daily_snapshot_fanout(self):
    """Enfileira um snapshot por produto monitorado. Roda 1x/dia via beat."""
    db = SessionLocal()
    try:
        ids = db.scalars(
            select(m.MonitoredProduct.id).where(m.MonitoredProduct.monitoring.is_(True))
        ).all()
        for pid in ids:
            snapshot_product.apply_async(args=[str(pid)], queue="snapshots")
        logger.info("Fan-out: %s snapshots enfileirados", len(ids))
        return {"queued": len(ids)}
    finally:
        db.close()


# ==========================================================================
# SNAPSHOT + VELOCITY — o coração do sistema
# ==========================================================================

@shared_task(bind=True, max_retries=5, retry_backoff=True, rate_limit="15/s")
def snapshot_product(self, product_id: str):
    """
    Coleta o estado atual do anúncio (D0), grava o snapshot e já calcula
    o delta vs D-1/D-7/D-30 inline — leitura quente sem job separado.
    """
    db = SessionLocal()
    try:
        product = db.get(m.MonitoredProduct, product_id)
        if not product or not product.monitoring:
            return {"skipped": product_id}

        item = collector.fetch_public_item(product.item_id, product.shop_id)
        # item = {price, price_before_discount, stock, historical_sold,
        #         liked_count, comment_count, rating_star, rating_count}

        today = date.today()

        # Baseline D-1 para calcular sold_delta_1d no próprio insert
        yesterday_snap = db.scalars(
            select(m.ProductDailySnapshot)
            .where(m.ProductDailySnapshot.product_id == product.id,
                   m.ProductDailySnapshot.snapshot_date < today)
            .order_by(m.ProductDailySnapshot.snapshot_date.desc())
            .limit(1)
        ).first()

        sold_delta = (item["historical_sold"] - yesterday_snap.historical_sold
                      if yesterday_snap else None)
        price_changed = (yesterday_snap is not None
                         and abs(float(yesterday_snap.price) - item["price"]) > 0.005)

        snap = m.ProductDailySnapshot(
            product_id=product.id,
            snapshot_date=today,
            price=item["price"],
            price_before_discount=item.get("price_before_discount"),
            stock=item.get("stock"),
            historical_sold=item["historical_sold"],
            liked_count=item.get("liked_count"),
            comment_count=item.get("comment_count"),
            rating_star=item.get("rating_star"),
            rating_count=item.get("rating_count"),
            sold_delta_1d=max(sold_delta, 0) if sold_delta is not None else None,
            price_changed=price_changed,
        )
        db.merge(snap)          # idempotente — re-run no mesmo dia faz upsert

        # Janela de 30 dias para o Velocity Engine
        snaps = db.scalars(
            select(m.ProductDailySnapshot)
            .where(m.ProductDailySnapshot.product_id == product.id)
            .order_by(m.ProductDailySnapshot.snapshot_date.desc())
            .limit(31)
        ).all()

        vm = compute_velocity([
            Snapshot(s.snapshot_date, s.historical_sold, float(s.price), s.stock)
            for s in snaps
        ])

        # Seller signals mais recentes
        shop_snap = db.scalars(
            select(m.ShopDailySnapshot)
            .where(m.ShopDailySnapshot.shop_id == product.shop_id)
            .order_by(m.ShopDailySnapshot.snapshot_date.desc())
            .limit(1)
        ).first()

        niche_stats = db.scalars(
            select(m.NicheDailyStats)
            .where(m.NicheDailyStats.niche_id == product.niche_id)
            .order_by(m.NicheDailyStats.stat_date.desc())
            .limit(1)
        ).first()

        review_summary = db.get(m.ProductReviewsSummary, product.id)

        score = compute_opportunity_score(
            demand=DemandSignals(vm.avg_daily_30d, vm.trend_label),
            seller=SellerSignals(
                rating_star=float(shop_snap.rating_star) if shop_snap else None,
                response_rate=float(shop_snap.response_rate) if shop_snap else None,
                ship_prep_days=float(shop_snap.ship_prep_days) if shop_snap else None,
                follower_count=shop_snap.follower_count if shop_snap else None,
                is_official=product.shop.is_official,
            ),
            top3_share=float(niche_stats.top3_share) if niche_stats else None,
            negative_ratio=(float(review_summary.negative_ratio)
                            if review_summary else None),
        )

        metrics = db.get(m.ProductVelocityMetrics, product.id) \
            or m.ProductVelocityMetrics(product_id=product.id)
        metrics.computed_at = datetime.utcnow()
        metrics.sold_last_24h = vm.sold_last_24h or 0
        metrics.sold_last_7d = vm.sold_last_7d or 0
        metrics.sold_last_15d = vm.sold_last_15d or 0
        metrics.sold_last_30d = vm.sold_last_30d or 0
        metrics.avg_daily_7d = vm.avg_daily_7d or 0
        metrics.avg_daily_30d = vm.avg_daily_30d or 0
        metrics.trend_ratio_7v30 = vm.trend_ratio_7v30
        metrics.revenue_est_30d = (vm.sold_last_30d or 0) * item["price"]
        metrics.opportunity_score = score.score
        metrics.opportunity_factors = score.factors
        db.merge(metrics)
        db.commit()

        if vm.anomalies:
            logger.warning("Produto %s anomalias: %s", product_id, vm.anomalies)
        return {"product": product_id, "trend": vm.trend_label,
                "score": score.score}

    except collector.CollectorRateLimited as exc:
        # Redis-backed backoff: espera o reset da janela da fonte de dados
        raise self.retry(exc=exc, countdown=exc.retry_after or 120)
    finally:
        db.close()


# ==========================================================================
# AGREGAÇÃO DE NICHO — ticket médio ponderado + concentração
# ==========================================================================

@shared_task
def recompute_all_metrics():
    """Recalcula niche_daily_stats (top 50 por volume) e shop snapshots."""
    db = SessionLocal()
    try:
        niches = db.scalars(select(m.Niche).where(m.Niche.is_active.is_(True))).all()
        for niche in niches:
            _recompute_niche_stats(db, niche)
        db.commit()
    finally:
        db.close()


def _recompute_niche_stats(db, niche) -> None:
    top50 = db.execute(text("""
        SELECT p.shop_id, s.price, vm.sold_last_30d, vm.revenue_est_30d
        FROM monitored_products p
        JOIN product_velocity_metrics vm ON vm.product_id = p.id
        JOIN LATERAL (
            SELECT price FROM product_daily_snapshots s
            WHERE s.product_id = p.id
            ORDER BY s.snapshot_date DESC LIMIT 1
        ) s ON TRUE
        WHERE p.niche_id = :nid AND p.monitoring
        ORDER BY vm.sold_last_30d DESC NULLS LAST
        LIMIT 50
    """), {"nid": str(niche.id)}).mappings().all()

    if not top50:
        return

    by_seller: dict[int, int] = {}
    for row in top50:
        by_seller[row["shop_id"]] = by_seller.get(row["shop_id"], 0) + (row["sold_last_30d"] or 0)

    ticket = weighted_avg_ticket([(float(r["price"]), r["sold_last_30d"]) for r in top50])
    top3, hhi = market_concentration(list(by_seller.values()))

    db.merge(m.NicheDailyStats(
        niche_id=niche.id,
        stat_date=date.today(),
        top_products_count=len(top50),
        weighted_avg_ticket=ticket,
        total_sold_30d=sum(r["sold_last_30d"] or 0 for r in top50),
        total_revenue_est=sum(float(r["revenue_est_30d"] or 0) for r in top50),
        top3_share=top3,
        hhi_index=hhi,
    ))


# ==========================================================================
# REVIEW MINING
# ==========================================================================

@shared_task
def review_mining_fanout():
    db = SessionLocal()
    try:
        top_ids = db.scalars(
            select(m.ProductVelocityMetrics.product_id)
            .order_by(m.ProductVelocityMetrics.sold_last_30d.desc())
            .limit(200)
        ).all()
        for pid in top_ids:
            collect_reviews.apply_async(args=[str(pid)], queue="reviews")
    finally:
        db.close()


@shared_task(bind=True, max_retries=3, rate_limit="5/s")
def collect_reviews(self, product_id: str):
    """Coleta e classifica avaliações 1-3★ (as que ensinam o que melhorar)."""
    db = SessionLocal()
    try:
        product = db.get(m.MonitoredProduct, product_id)
        raw = collector.fetch_item_ratings(product.item_id, product.shop_id,
                                         filter_stars=(1, 2, 3), limit=200)

        classified = []
        for r in raw:
            c = classify_review(r["rating"], r.get("comment"))
            db.merge(m.ProductReview(
                product_id=product.id,
                review_id=str(r["review_id"]),
                rating=r["rating"],
                comment=r.get("comment"),
                review_date=datetime.fromtimestamp(r["ctime"]) if r.get("ctime") else None,
                pain_categories=c.pain_categories,
                sentiment=c.sentiment,
            ))
            classified.append((r["rating"], r.get("comment"), c.pain_categories))

        total = db.scalar(select(func.count()).select_from(m.ProductReview)
                          .where(m.ProductReview.product_id == product.id)) or 0
        negative = db.scalar(select(func.count()).select_from(m.ProductReview)
                             .where(m.ProductReview.product_id == product.id,
                                    m.ProductReview.rating <= 3)) or 0

        summary = db.get(m.ProductReviewsSummary, product.id) \
            or m.ProductReviewsSummary(product_id=product.id)
        summary.total_reviews = total
        summary.negative_reviews = negative
        summary.negative_ratio = negative / total if total else 0
        summary.top_pain_points = summarize_pains(classified)
        summary.updated_at = datetime.utcnow()
        db.merge(summary)
        db.commit()
    finally:
        db.close()


# ==========================================================================
# MÓDULO INTERNO — sync OAuth2 da loja do usuário
# ==========================================================================

@shared_task
def sync_all_internal_shops():
    db = SessionLocal()
    try:
        conns = db.scalars(select(m.ShopeeConnection)
                           .where(m.ShopeeConnection.status == "active")).all()
        for c in conns:
            sync_internal_shop.apply_async(args=[str(c.id)], queue="internal")
    finally:
        db.close()


@shared_task(bind=True, max_retries=3)
def sync_internal_shop(self, connection_id: str):
    """
    Sincroniza pedidos + escrow + ads da loja conectada via Open Platform v2.
    (ver services/shopee_client.py para assinatura e refresh automático)
    """
    import asyncio
    from app.services.internal_sync import sync_orders_window

    asyncio.run(sync_orders_window(connection_id, days=7))
