"""SQLAlchemy models — espelham database/schema.sql."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (BigInteger, Boolean, Date, DateTime, ForeignKey, Integer,
                        Numeric, SmallInteger, Text, UniqueConstraint, func)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    email: Mapped[str] = mapped_column(Text, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    full_name: Mapped[str | None] = mapped_column(Text)
    plan: Mapped[str] = mapped_column(Text, default="trial")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())


class ShopeeConnection(Base):
    __tablename__ = "shopee_connections"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    shop_id: Mapped[int] = mapped_column(BigInteger)
    shop_name: Mapped[str | None] = mapped_column(Text)
    region: Mapped[str] = mapped_column(Text, default="BR")
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    token_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    refresh_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, default="active")
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class InternalOrder(Base):
    __tablename__ = "internal_orders"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    connection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("shopee_connections.id", ondelete="CASCADE"))
    order_sn: Mapped[str] = mapped_column(Text)
    order_status: Mapped[str] = mapped_column(Text)
    order_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    total_amount: Mapped[float] = mapped_column(Numeric(12, 2))
    escrow_amount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    commission_fee: Mapped[float | None] = mapped_column(Numeric(12, 2))
    service_fee: Mapped[float | None] = mapped_column(Numeric(12, 2))
    transaction_fee: Mapped[float | None] = mapped_column(Numeric(12, 2))
    shipping_fee: Mapped[float | None] = mapped_column(Numeric(12, 2))
    items: Mapped[list] = mapped_column(JSONB, default=list)
    raw_payload: Mapped[dict | None] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("connection_id", "order_sn"),)


class Niche(Base):
    __tablename__ = "niches"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(Text)
    shopee_category_id: Mapped[int | None] = mapped_column(BigInteger)
    keywords: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class CompetitorShop(Base):
    __tablename__ = "competitor_shops"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    shop_id: Mapped[int] = mapped_column(BigInteger, unique=True)
    name: Mapped[str] = mapped_column(Text)
    username: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(Text)
    is_official: Mapped[bool] = mapped_column(Boolean, default=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ShopDailySnapshot(Base):
    __tablename__ = "shop_daily_snapshots"
    shop_id: Mapped[int] = mapped_column(ForeignKey("competitor_shops.shop_id"),
                                         primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    rating_star: Mapped[float | None] = mapped_column(Numeric(3, 2))
    response_rate: Mapped[float | None] = mapped_column(Numeric(5, 2))
    response_time_s: Mapped[int | None] = mapped_column(Integer)
    ship_prep_days: Mapped[float | None] = mapped_column(Numeric(4, 1))
    follower_count: Mapped[int | None] = mapped_column(Integer)
    product_count: Mapped[int | None] = mapped_column(Integer)
    rating_count: Mapped[int | None] = mapped_column(Integer)


class MonitoredProduct(Base):
    __tablename__ = "monitored_products"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    item_id: Mapped[int] = mapped_column(BigInteger)
    shop_id: Mapped[int] = mapped_column(ForeignKey("competitor_shops.shop_id"))
    niche_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("niches.id"))
    name: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(Text)
    product_url: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(Text)
    category_path: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    monitoring: Mapped[bool] = mapped_column(Boolean, default=True)
    shop: Mapped[CompetitorShop] = relationship()
    __table_args__ = (UniqueConstraint("item_id", "shop_id"),)


class ProductDailySnapshot(Base):
    __tablename__ = "product_daily_snapshots"
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("monitored_products.id", ondelete="CASCADE"), primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    price: Mapped[float] = mapped_column(Numeric(12, 2))
    price_before_discount: Mapped[float | None] = mapped_column(Numeric(12, 2))
    stock: Mapped[int | None] = mapped_column(Integer)
    historical_sold: Mapped[int] = mapped_column(Integer)
    liked_count: Mapped[int | None] = mapped_column(Integer)
    comment_count: Mapped[int | None] = mapped_column(Integer)
    rating_star: Mapped[float | None] = mapped_column(Numeric(3, 2))
    rating_count: Mapped[int | None] = mapped_column(Integer)
    sold_delta_1d: Mapped[int | None] = mapped_column(Integer)
    price_changed: Mapped[bool] = mapped_column(Boolean, default=False)


class ProductVelocityMetrics(Base):
    __tablename__ = "product_velocity_metrics"
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("monitored_products.id", ondelete="CASCADE"), primary_key=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sold_last_24h: Mapped[int] = mapped_column(Integer, default=0)
    sold_last_7d: Mapped[int] = mapped_column(Integer, default=0)
    sold_last_15d: Mapped[int] = mapped_column(Integer, default=0)
    sold_last_30d: Mapped[int] = mapped_column(Integer, default=0)
    avg_daily_7d: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    avg_daily_30d: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    trend_ratio_7v30: Mapped[float | None] = mapped_column(Numeric(8, 4))
    revenue_est_30d: Mapped[float | None] = mapped_column(Numeric(14, 2))
    opportunity_score: Mapped[float | None] = mapped_column(Numeric(5, 2))
    opportunity_factors: Mapped[dict | None] = mapped_column(JSONB)


class ProductReview(Base):
    __tablename__ = "product_reviews"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("monitored_products.id", ondelete="CASCADE"))
    review_id: Mapped[str] = mapped_column(Text, unique=True)
    rating: Mapped[int] = mapped_column(SmallInteger)
    comment: Mapped[str | None] = mapped_column(Text)
    review_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pain_categories: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    sentiment: Mapped[str | None] = mapped_column(Text)


class ProductReviewsSummary(Base):
    __tablename__ = "product_reviews_summary"
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("monitored_products.id", ondelete="CASCADE"), primary_key=True)
    total_reviews: Mapped[int] = mapped_column(Integer, default=0)
    negative_reviews: Mapped[int] = mapped_column(Integer, default=0)
    negative_ratio: Mapped[float | None] = mapped_column(Numeric(5, 4))
    top_pain_points: Mapped[list] = mapped_column(JSONB, default=list)
    improvement_insight: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class NicheDailyStats(Base):
    __tablename__ = "niche_daily_stats"
    niche_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("niches.id"), primary_key=True)
    stat_date: Mapped[date] = mapped_column(Date, primary_key=True)
    top_products_count: Mapped[int] = mapped_column(Integer, default=0)
    weighted_avg_ticket: Mapped[float | None] = mapped_column(Numeric(12, 2))
    total_sold_30d: Mapped[int | None] = mapped_column(Integer)
    total_revenue_est: Mapped[float | None] = mapped_column(Numeric(14, 2))
    top3_share: Mapped[float | None] = mapped_column(Numeric(5, 4))
    hhi_index: Mapped[float | None] = mapped_column(Numeric(8, 6))


class ProfitSimulation(Base):
    __tablename__ = "profit_simulations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("monitored_products.id"))
    niche_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("niches.id"))
    name: Mapped[str | None] = mapped_column(Text)
    sale_price: Mapped[float] = mapped_column(Numeric(12, 2))
    target_margin_pct: Mapped[float] = mapped_column(Numeric(5, 2))
    commission_pct: Mapped[float] = mapped_column(Numeric(5, 2))
    freeship_pct: Mapped[float] = mapped_column(Numeric(5, 2))
    fixed_fee_per_item: Mapped[float] = mapped_column(Numeric(10, 2))
    tax_pct: Mapped[float] = mapped_column(Numeric(5, 2))
    acos_pct: Mapped[float] = mapped_column(Numeric(5, 2), default=0)
    extra_cost_per_unit: Mapped[float | None] = mapped_column(Numeric(10, 2), default=0)
    cmv_ceiling: Mapped[float | None] = mapped_column(Numeric(12, 2))
    net_profit_per_unit: Mapped[float | None] = mapped_column(Numeric(12, 2))
    breakeven_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    viability_label: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())
