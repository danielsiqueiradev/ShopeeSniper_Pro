"""Endpoints de nichos — criação, stats agregadas e radar de oportunidade."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
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
    rows = db.execute(select(m.Niche, m.NicheDailyStats)
                      .outerjoin(m.NicheDailyStats,
                                 (m.NicheDailyStats.niche_id == m.Niche.id)
                                 & (m.NicheDailyStats.stat_date ==
                                    select(m.NicheDailyStats.stat_date)
                                    .where(m.NicheDailyStats.niche_id == m.Niche.id)
                                    .order_by(m.NicheDailyStats.stat_date.desc())
                                    .limit(1).scalar_subquery())))
    return [{"niche_id": str(n.id), "name": n.name,
             "weighted_avg_ticket": float(s.weighted_avg_ticket) if s and s.weighted_avg_ticket else None,
             "top3_share": float(s.top3_share) if s and s.top3_share else None,
             "total_revenue_est": float(s.total_revenue_est) if s and s.total_revenue_est else None,
             "total_sold_30d": s.total_sold_30d if s else None}
            for n, s in rows]


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
