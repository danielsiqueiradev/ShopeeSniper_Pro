"""Endpoints de nichos — criação, stats agregadas e radar de oportunidade."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import models as m

router = APIRouter()


class NicheIn(BaseModel):
    name: str
    shopee_category_id: int | None = None
    keywords: list[str] = []


@router.post("")
def create_niche(body: NicheIn, db: Session = Depends(get_db)):
    niche = m.Niche(**body.model_dump())
    db.add(niche)
    db.commit()
    return {"id": str(niche.id)}


@router.get("")
def list_niches(db: Session = Depends(get_db)):
    """Nichos com a estatística mais recente (ticket médio, concentração)."""
    rows = db.execute(text("""
        SELECT n.id AS niche_id, n.name,
               s.weighted_avg_ticket, s.top3_share,
               s.total_revenue_est, s.total_sold_30d
        FROM niches n
        LEFT JOIN LATERAL (
            SELECT * FROM niche_daily_stats s
            WHERE s.niche_id = n.id
            ORDER BY s.stat_date DESC LIMIT 1
        ) s ON TRUE
        WHERE n.is_active
        ORDER BY n.name
    """)).mappings()
    return [dict(r) for r in rows]


@router.get("/{niche_id}/stats-history")
def niche_stats_history(niche_id: uuid.UUID, days: int = 30,
                        db: Session = Depends(get_db)):
    """Série temporal do nicho — evolução de ticket médio e concentração."""
    rows = db.scalars(select(m.NicheDailyStats)
                      .where(m.NicheDailyStats.niche_id == niche_id)
                      .order_by(m.NicheDailyStats.stat_date.desc())
                      .limit(days)).all()
    if not rows:
        raise HTTPException(404, "nicho sem estatísticas ainda")
    return [{"date": str(r.stat_date),
             "weighted_avg_ticket": float(r.weighted_avg_ticket or 0),
             "top3_share": float(r.top3_share or 0),
             "hhi": float(r.hhi_index or 0),
             "total_sold_30d": r.total_sold_30d}
            for r in reversed(rows)]
