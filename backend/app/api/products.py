"""Endpoints de produtos — radar, série temporal de vendas, pain points."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db

router = APIRouter()


@router.get("/radar")
def opportunity_radar(
    niche_id: uuid.UUID | None = None,
    min_score: float = Query(0, ge=0, le=100),
    trend: str | None = Query(None, pattern="^(rising|stable|falling)$"),
    limit: int = Query(50, le=200),
    db: Session = Depends(get_db),
):
    """
    Radar de Oportunidades — produtos ordenados por opportunity_score.
    Alimenta a tela principal: decisão em < 30s.
    """
    rows = db.execute(text("""
        SELECT * FROM v_product_radar
        WHERE (CAST(:nid AS uuid) IS NULL OR niche_id = CAST(:nid AS uuid))
          AND COALESCE(opportunity_score, 0) >= :min_score
          AND (CAST(:trend AS text) IS NULL OR trend_label = CAST(:trend AS text))
        ORDER BY opportunity_score DESC NULLS LAST
        LIMIT :lim
    """), {"nid": str(niche_id) if niche_id else None,
           "min_score": min_score, "trend": trend, "lim": limit}).mappings()
    return [dict(r) for r in rows]


@router.get("/{product_id}/sales-history")
def sales_history(product_id: uuid.UUID, days: int = Query(30, le=365),
                  db: Session = Depends(get_db)):
    """
    Série temporal diária para o gráfico de velocidade:
    vendas acumuladas + delta do dia + preço (detecta guerra de preço).
    """
    rows = db.execute(text("""
        SELECT snapshot_date, historical_sold, sold_delta_1d, price, stock,
               rating_star, rating_count
        FROM product_daily_snapshots
        WHERE product_id = :pid
        ORDER BY snapshot_date DESC
        LIMIT :days
    """), {"pid": str(product_id), "days": days}).mappings().all()
    if not rows:
        raise HTTPException(404, "produto sem snapshots")
    return [dict(r) for r in reversed(rows)]


@router.get("/{product_id}/pain-points")
def pain_points(product_id: uuid.UUID, db: Session = Depends(get_db)):
    """Top motivos de insatisfação do concorrente — insumo de copywriting."""
    row = db.execute(text("""
        SELECT total_reviews, negative_reviews, negative_ratio,
               top_pain_points, improvement_insight
        FROM product_reviews_summary WHERE product_id = :pid
    """), {"pid": str(product_id)}).mappings().first()
    if not row:
        raise HTTPException(404, "reviews ainda não coletadas para este produto")
    return dict(row)
