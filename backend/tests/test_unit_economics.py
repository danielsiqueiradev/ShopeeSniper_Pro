import pytest

from app.services.unit_economics import FeeStructure, simulate

FEES = FeeStructure(commission_pct=14, freeship_pct=6, fixed_fee_per_item=4.0,
                    tax_pct=6, acos_pct=10)


def test_cmv_ceiling_hits_exact_target_margin():
    # P=79.90, margem alvo 20% -> lucro com CMV=teto deve ser ~20% de P
    r = simulate(79.90, 20.0, FEES)
    residual = 1 - (14 + 6 + 6 + 10) / 100                      # 0.64
    esperado = 79.90 * (residual - 0.20) - 4.0
    assert r.cmv_ceiling == pytest.approx(esperado, abs=0.01)
    assert r.net_profit_at_ceiling == pytest.approx(79.90 * 0.20, abs=0.01)


def test_breakeven_price():
    # CMV=18 -> P_be = (4 + 18) / 0.64
    r = simulate(79.90, 20.0, FEES, actual_cmv=18.0)
    assert r.breakeven_price == pytest.approx(22 / 0.64, abs=0.01)


def test_viability_labels():
    assert simulate(79.90, 20.0, FEES, actual_cmv=10.0).viability_label == "viable"
    assert simulate(79.90, 20.0, FEES, actual_cmv=50.0).viability_label == "tight"


def test_unviable_when_ceiling_negative():
    # margem 60% + 36% de custos % -> teto negativo
    r = simulate(10.0, 60.0, FEES)
    assert r.viability_label == "unviable"


def test_impossible_when_fees_ge_100pct():
    fees = FeeStructure(commission_pct=50, freeship_pct=30,
                        fixed_fee_per_item=0, tax_pct=25)
    r = simulate(100.0, 20.0, fees)
    assert r.viability_label == "impossible"
    assert r.cmv_ceiling is None


def test_total_fees_per_unit():
    r = simulate(100.0, 20.0, FEES)
    # 36% de 100 + R$4 fixo
    assert r.total_fees_per_unit == pytest.approx(40.0, abs=0.01)
