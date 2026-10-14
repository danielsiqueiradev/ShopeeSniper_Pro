"""Unit Economics reverso pra Shopee BR: lucro líquido, margem e CMV Teto.

Regras de taxa (defaults editáveis — a Shopee muda a política com frequência):
- Comissão padrão: 14% sobre o preço, com teto de R$ 100 por item.
- Programa Frete Grátis: +6% sobre o preço.
- Taxa fixa: R$ 4,00 por item — ou metade do preço se o item custa < R$ 8,00.
- Imposto (Simples Nacional): 6% sobre o faturamento (configurável).
- Ads (ACOS estimado): 8% sobre o faturamento (configurável).
"""

from __future__ import annotations

from dataclasses import dataclass
from math import inf


@dataclass(frozen=True)
class ShopeeFeeConfig:
    commission_pct: float = 14.0
    free_shipping_pct: float = 6.0
    commission_cap: float = 100.0          # teto da comissão por item (R$)
    fixed_fee: float = 4.00                # por item
    fixed_fee_threshold: float = 8.00      # abaixo disso, taxa fixa = preço/2
    simples_nacional_pct: float = 6.0
    ads_pct: float = 8.0


@dataclass(frozen=True)
class UnitEconomics:
    sale_price: float
    supplier_cost: float
    quantity: int
    revenue: float
    commission: float
    free_shipping_fee: float
    fixed_fee: float
    tax: float
    ads_cost: float
    total_fees: float                      # todas as taxas (sem custo do produto)
    net_profit: float                      # lucro líquido
    net_margin_pct: float                  # margem sobre o faturamento
    breakeven_roas: float                  # receita / teto de gasto com ads

    @property
    def gross_after_shopee(self) -> float:
        """Margem bruta pós-Shopee (antes do custo do produto)."""
        return self.revenue - self.total_fees


DEFAULT_FEES = ShopeeFeeConfig()


def _fixed_fee(price: float, cfg: ShopeeFeeConfig) -> float:
    """R$ 4,00/item; se preço < R$ 8,00, a taxa vira metade do preço."""
    if price < cfg.fixed_fee_threshold:
        return price / 2
    return cfg.fixed_fee


def compute_fees(price: float, qty: int, cfg: ShopeeFeeConfig) -> dict[str, float]:
    """Decompõe todas as taxas para `qty` itens a `price` cada."""
    commission = min(price * cfg.commission_pct / 100, cfg.commission_cap) * qty
    free_shipping = price * cfg.free_shipping_pct / 100 * qty
    fixed = _fixed_fee(price, cfg) * qty
    tax = price * cfg.simples_nacional_pct / 100 * qty
    ads = price * cfg.ads_pct / 100 * qty
    return {
        "commission": commission,
        "free_shipping_fee": free_shipping,
        "fixed_fee": fixed,
        "tax": tax,
        "ads_cost": ads,
        "total": commission + free_shipping + fixed + tax + ads,
    }


def compute_unit_economics(
    sale_price: float,
    supplier_cost: float,
    quantity: int = 1,
    cfg: ShopeeFeeConfig = DEFAULT_FEES,
) -> UnitEconomics:
    """Lucro líquido e margem pra uma venda (ou `quantity` itens no pedido)."""
    qty = max(1, quantity)
    revenue = sale_price * qty
    f = compute_fees(sale_price, qty, cfg)
    cost = supplier_cost * qty
    profit = revenue - f["total"] - cost

    # breakeven ROAS: receita / máximo que dá pra queimar em ads sem ir pro negativo
    headroom = revenue - (f["total"] - f["ads_cost"]) - cost
    roas = revenue / headroom if headroom > 0 else inf

    return UnitEconomics(
        sale_price=sale_price,
        supplier_cost=supplier_cost,
        quantity=qty,
        revenue=round(revenue, 2),
        commission=round(f["commission"], 2),
        free_shipping_fee=round(f["free_shipping_fee"], 2),
        fixed_fee=round(f["fixed_fee"], 2),
        tax=round(f["tax"], 2),
        ads_cost=round(f["ads_cost"], 2),
        total_fees=round(f["total"], 2),
        net_profit=round(profit, 2),
        net_margin_pct=round(profit / revenue * 100, 2) if revenue else 0.0,
        breakeven_roas=round(roas, 2) if roas != inf else inf,
    )


def max_supplier_cost_for_target_margin(
    sale_price: float,
    target_margin_pct: float = 20.0,
    quantity: int = 1,
    cfg: ShopeeFeeConfig = DEFAULT_FEES,
) -> float:
    """CMV Teto: o máximo que você pode pagar no fornecedor pra bater a margem.

    Todas as taxas dependem só do preço (o custo não entra nelas), então:
        custo_max = receita - taxas - margem_alvo * receita
    """
    if not (0 <= target_margin_pct < 100):
        raise ValueError("target_margin_pct deve estar entre 0 e 100")
    qty = max(1, quantity)
    revenue = sale_price * qty
    fees = compute_fees(sale_price, qty, cfg)["total"]
    cost_max = revenue - fees - (target_margin_pct / 100) * revenue
    return round(cost_max, 2)
