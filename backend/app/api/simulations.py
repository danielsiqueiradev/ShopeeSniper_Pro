"""Calculadora Reversa de Lucro — endpoints de simulação de unit economics."""

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import models as m
from app.services.unit_economics import FeeStructure, simulate

router = APIRouter()


class SimulationIn(BaseModel):
    user_id: uuid.UUID
    product_id: uuid.UUID | None = None
    niche_id: uuid.UUID | None = None
    name: str | None = None

    sale_price: float = Field(gt=0)
    target_margin_pct: float = Field(ge=0, lt=90, default=20.0)

    commission_pct: float | None = None      # default: config global
    freeship_pct: float | None = None
    fixed_fee_per_item: float | None = None
    tax_pct: float | None = None
    acos_pct: float = 0.0
    extra_cost_per_unit: float = 0.0
    actual_cmv: float | None = None          # se informado, calcula breakeven


@router.post("")
def run_simulation(body: SimulationIn, db: Session = Depends(get_db)):
    fees = FeeStructure(
        commission_pct=body.commission_pct if body.commission_pct is not None
                       else settings.default_commission_pct,
        freeship_pct=body.freeship_pct if body.freeship_pct is not None
                       else settings.default_freeship_pct,
        fixed_fee_per_item=body.fixed_fee_per_item if body.fixed_fee_per_item is not None
                            else settings.default_fixed_fee,
        tax_pct=body.tax_pct if body.tax_pct is not None
               else settings.default_tax_pct,
        acos_pct=body.acos_pct,
        extra_cost_per_unit=body.extra_cost_per_unit,
    )

    result = simulate(body.sale_price, body.target_margin_pct, fees, body.actual_cmv)

    sim = m.ProfitSimulation(
        user_id=body.user_id,
        product_id=body.product_id,
        niche_id=body.niche_id,
        name=body.name,
        sale_price=body.sale_price,
        target_margin_pct=body.target_margin_pct,
        commission_pct=fees.commission_pct,
        freeship_pct=fees.freeship_pct,
        fixed_fee_per_item=fees.fixed_fee_per_item,
        tax_pct=fees.tax_pct,
        acos_pct=fees.acos_pct,
        extra_cost_per_unit=fees.extra_cost_per_unit,
        cmv_ceiling=result.cmv_ceiling,
        net_profit_per_unit=result.net_profit_at_ceiling,
        breakeven_price=result.breakeven_price,
        viability_label=result.viability_label,
    )
    db.add(sim)
    db.commit()

    return {
        "simulation_id": str(sim.id),
        "cmv_ceiling": result.cmv_ceiling,
        "net_profit_at_ceiling": result.net_profit_at_ceiling,
        "breakeven_price": result.breakeven_price,
        "total_fees_per_unit": result.total_fees_per_unit,
        "viability_label": result.viability_label,
        "notes": result.notes,
    }
