"""Coleta imediata — roda o pipeline de snapshot sem Celery/Redis.

Uso:  python scripts/snapshot_now.py            # todos os monitorados
      python scripts/snapshot_now.py <item_id>  # um item específico
"""

import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.database import SessionLocal
from app.models import models as m
from app.services.collector_web import WebCollector, WebCollectorConfig
from app.services.opportunity_score import (
    DemandSignals, SellerSignals, compute_opportunity_score,
)
from app.services.velocity_engine import Snapshot, compute_velocity

collector = WebCollector(WebCollectorConfig(timeout=10, max_retries=1, rpm=30))
db = SessionLocal()


def run(item_id_filter: int | None = None):
    q = select(m.MonitoredProduct).where(m.MonitoredProduct.monitoring.is_(True))
    if item_id_filter:
        q = q.where(m.MonitoredProduct.item_id == item_id_filter)
    products = db.scalars(q).all()

    for p in products:
        try:
            item = collector.fetch_public_item(p.item_id, p.shop_id)
        except Exception as e:
            print(f"[{p.item_id}] falhou: {type(e).__name__} {str(e)[:80]}")
            continue

        if item.get("name"):
            p.name = item["name"]
        if item.get("image_url"):
            p.image_url = item["image_url"]

        today = date.today()
        prev = db.scalars(
            select(m.ProductDailySnapshot)
            .where(m.ProductDailySnapshot.product_id == p.id,
                   m.ProductDailySnapshot.snapshot_date < today)
            .order_by(m.ProductDailySnapshot.snapshot_date.desc())
            .limit(1)).first()

        db.merge(m.ProductDailySnapshot(
            product_id=p.id, snapshot_date=today,
            price=item["price"],
            price_before_discount=item.get("price_before_discount"),
            stock=item.get("stock"),
            historical_sold=item["historical_sold"],
            liked_count=item.get("liked_count"),
            comment_count=item.get("comment_count"),
            rating_star=item.get("rating_star"),
            rating_count=item.get("rating_count"),
            sold_delta_1d=(max(item["historical_sold"] - prev.historical_sold, 0)
                           if prev else None),
            price_changed=bool(prev and abs(float(prev.price) - item["price"]) > 0.005)))

        snaps = db.scalars(
            select(m.ProductDailySnapshot)
            .where(m.ProductDailySnapshot.product_id == p.id)
            .order_by(m.ProductDailySnapshot.snapshot_date.desc())
            .limit(31)).all()
        vm = compute_velocity([
            Snapshot(s.snapshot_date, s.historical_sold, float(s.price), s.stock)
            for s in snaps])

        shop_snap = db.scalars(
            select(m.ShopDailySnapshot)
            .where(m.ShopDailySnapshot.shop_id == p.shop_id)
            .order_by(m.ShopDailySnapshot.snapshot_date.desc())
            .limit(1)).first()

        score = compute_opportunity_score(
            demand=DemandSignals(vm.avg_daily_30d, vm.trend_label),
            seller=SellerSignals(
                rating_star=float(shop_snap.rating_star) if shop_snap else None,
                response_rate=float(shop_snap.response_rate) if shop_snap else None,
                ship_prep_days=float(shop_snap.ship_prep_days) if shop_snap else None,
                follower_count=shop_snap.follower_count if shop_snap else None,
                is_official=p.shop.is_official),
            top3_share=None, negative_ratio=None)

        metrics = db.get(m.ProductVelocityMetrics, p.id) \
            or m.ProductVelocityMetrics(product_id=p.id)
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
        print(f"[{p.item_id}] ok: {item.get('name', '')[:40]} "
              f"R${item['price']} vendidos={item['historical_sold']} "
              f"score={score.score}")


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else None)
