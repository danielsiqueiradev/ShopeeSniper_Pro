"""Taxas Shopee BR, lucro líquido, CMV Teto e edge cases."""

import pytest

from app.services.unit_economics import (
    ShopeeFeeConfig,
    compute_fees,
    compute_unit_economics,
    max_supplier_cost_for_target_margin,
)

CFG = ShopeeFeeConfig()  # 14% comm (cap 100) + 6% FS + R$4 fixo + 6% imp + 8% ads


class TestComputeFees:
    def test_standard_item(self):
        f = compute_fees(50.0, 1, CFG)
        assert f["commission"] == pytest.approx(7.0)
        assert f["free_shipping_fee"] == pytest.approx(3.0)
        assert f["fixed_fee"] == pytest.approx(4.0)
        assert f["tax"] == pytest.approx(3.0)
        assert f["ads_cost"] == pytest.approx(4.0)
        assert f["total"] == pytest.approx(21.0)

    def test_commission_cap_100(self):
        """R$ 800 × 14% = R$ 112 → teto de R$ 100."""
        f = compute_fees(800.0, 1, CFG)
        assert f["commission"] == pytest.approx(100.0)
        assert f["commission"] < 800.0 * 0.14

    def test_commission_below_cap(self):
        f = compute_fees(100.0, 1, CFG)
        assert f["commission"] == pytest.approx(14.0)

    def test_fixed_fee_cheap_item(self):
        """Preço < R$ 8 → taxa fixa vira metade do preço."""
        assert compute_fees(7.99, 1, CFG)["fixed_fee"] == pytest.approx(7.99 / 2)
        assert compute_fees(4.00, 1, CFG)["fixed_fee"] == pytest.approx(2.0)

    def test_fixed_fee_threshold_boundary(self):
        """Exatamente R$ 8,00 → taxa cheia de R$ 4,00."""
        assert compute_fees(8.00, 1, CFG)["fixed_fee"] == pytest.approx(4.0)

    def test_quantity_multiplies(self):
        f = compute_fees(50.0, 3, CFG)
        assert f["commission"] == pytest.approx(21.0)
        assert f["fixed_fee"] == pytest.approx(12.0)


class TestUnitEconomics:
    def test_net_profit(self):
        ue = compute_unit_economics(50.0, supplier_cost=15.0)
        # 50 - 21 (taxas) - 15 (custo) = 14
        assert ue.net_profit == pytest.approx(14.0)
        assert ue.net_margin_pct == pytest.approx(28.0)

    def test_gross_after_shopee(self):
        ue = compute_unit_economics(50.0, supplier_cost=15.0)
        assert ue.gross_after_shopee == pytest.approx(29.0)

    def test_breakeven_roas(self):
        ue = compute_unit_economics(50.0, supplier_cost=10.0)
        # headroom sem ads = 50 - (21-4) - 10 = 23 → ROAS = 50/23
        assert ue.breakeven_roas == pytest.approx(50 / 23, abs=0.01)

    def test_negative_profit_inf_roas(self):
        from math import inf
        ue = compute_unit_economics(10.0, supplier_cost=20.0)
        assert ue.net_profit < 0
        assert ue.breakeven_roas == inf


class TestCmvTeto:
    def test_reverse_calculation(self):
        """CMV Teto a 20%: profit no custo-teto deve bater ~20% de margem."""
        cmv = max_supplier_cost_for_target_margin(50.0, 20.0)
        ue = compute_unit_economics(50.0, supplier_cost=cmv)
        assert ue.net_margin_pct == pytest.approx(20.0, abs=0.05)

    def test_cmv_teto_known_value(self):
        # receita 50 - taxas 21 - margem 10 (20% de 50) = 19
        cmv = max_supplier_cost_for_target_margin(50.0, 20.0)
        assert cmv == pytest.approx(19.0)

    def test_cmv_teto_with_cap(self):
        """Item caro (comissão no teto) ainda resolve corretamente."""
        cmv = max_supplier_cost_for_target_margin(800.0, 20.0)
        ue = compute_unit_economics(800.0, supplier_cost=cmv)
        assert ue.net_margin_pct == pytest.approx(20.0, abs=0.05)

    def test_invalid_margin(self):
        with pytest.raises(ValueError):
            max_supplier_cost_for_target_margin(50.0, 150.0)
