"""
Unit Economics — Calculadora Reversa de Lucro e Viabilidade.

Modelo (por unidade vendida):

    Receita líquida = P - P·(c + f + t + a) - F - E - CMV

    onde:
      P  = preço de venda na Shopee
      c  = comissão Shopee (fração, ex.: 0.14)
      f  = taxa Programa Frete Grátis Extra (fração, ex.: 0.06)
      t  = imposto — Simples Nacional / MEI (fração)
      a  = custo de Ads (ACOS sobre receita, fração)
      F  = taxa fixa por item vendido (R$)
      E  = custo extra por unidade (embalagem, brinde...) (R$)
      CMV = custo da mercadoria no fornecedor (R$)

    Margem líquida alvo = m (fração sobre P)

    ★ CMV TETO — resolvendo para lucro = m·P:
        CMV_teto = P·(1 - c - f - t - a - m) - F - E

    ★ Preço de breakeven (lucro = 0) para um CMV conhecido:
        P_be = (F + E + CMV) / (1 - c - f - t - a)

Guard-rail: se (1 - c - f - t - a) <= 0, nenhum preço viabiliza a operação.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FeeStructure:
    commission_pct: float        # ex.: 14.0 (percentual, não fração)
    freeship_pct: float          # ex.: 6.0
    fixed_fee_per_item: float    # ex.: 4.00 (R$)
    tax_pct: float               # ex.: 6.0 (Simples) / 0-3 (MEI)
    acos_pct: float = 0.0        # custo de Ads sobre receita
    extra_cost_per_unit: float = 0.0

    @property
    def total_variable_pct(self) -> float:
        """Soma de todos os custos percentuais sobre o preço (fração)."""
        return (self.commission_pct + self.freeship_pct
                + self.tax_pct + self.acos_pct) / 100.0


@dataclass
class ViabilityResult:
    sale_price: float
    target_margin_pct: float
    cmv_ceiling: float | None         # máximo que pode pagar no fornecedor (R$)
    net_profit_at_ceiling: float | None  # lucro se CMV = teto (sanidade = m·P)
    breakeven_price: float | None     # menor preço com lucro >= 0 (dado CMV real)
    total_fees_per_unit: float        # tudo que a Shopee+imposto+ads come (R$)
    viability_label: str              # viable | tight | unviable | impossible
    notes: list[str]


def _round(v: float | None) -> float | None:
    return round(v, 2) if v is not None else None


def simulate(
    sale_price: float,
    target_margin_pct: float,
    fees: FeeStructure,
    actual_cmv: float | None = None,
) -> ViabilityResult:
    """
    Retorna a viabilidade financeira completa.
    Se actual_cmv for informado, calcula também o breakeven e compara com o teto.
    """
    notes: list[str] = []
    p = sale_price
    k = 1.0 - fees.total_variable_pct  # multiplicador residual após % de custos

    if k <= 0:
        return ViabilityResult(
            sale_price=p,
            target_margin_pct=target_margin_pct,
            cmv_ceiling=None,
            net_profit_at_ceiling=None,
            breakeven_price=None,
            total_fees_per_unit=round(p * fees.total_variable_pct
                                      + fees.fixed_fee_per_item
                                      + fees.extra_cost_per_unit, 2),
            viability_label="impossible",
            notes=["Custos percentuais >= 100% do preço — operação inviável "
                   "em qualquer CMV. Reveja comissão/imposto/ACOS."],
        )

    m = target_margin_pct / 100.0
    if m >= k:
        notes.append(
            f"Margem alvo ({target_margin_pct}%) >= residual percentual "
            f"({k * 100:.1f}%). Só viável com taxa fixa zero e CMV <= 0."
        )

    # ★ CMV TETO
    cmv_ceiling = p * (k - m) - fees.fixed_fee_per_item - fees.extra_cost_per_unit

    if cmv_ceiling <= 0:
        label = "unviable"
        notes.append("CMV teto <= 0: o preço não comporta a margem desejada "
                     "nem com produto grátis.")
    else:
        label = "viable"
        notes.append(f"Pague no máximo R$ {cmv_ceiling:.2f} por unidade no "
                     f"fornecedor (incluindo frete de importação rateado).")

    # Breakeven e comparação com CMV real
    breakeven = None
    if actual_cmv is not None:
        breakeven = (fees.fixed_fee_per_item + fees.extra_cost_per_unit
                     + actual_cmv) / k
        if actual_cmv > cmv_ceiling > 0:
            label = "tight"
            notes.append(
                f"CMV real (R$ {actual_cmv:.2f}) excede o teto em "
                f"R$ {actual_cmv - cmv_ceiling:.2f}. Para manter a margem, "
                f"suba o preço para >= R$ "
                f"{(fees.fixed_fee_per_item + fees.extra_cost_per_unit + actual_cmv) / (k - m):.2f}."
            )
        elif cmv_ceiling > 0:
            label = "viable"
            headroom = cmv_ceiling - actual_cmv
            notes.append(f"Folga de R$ {headroom:.2f}/unid sobre o teto — "
                         f"cobre renegotiations ou ads piores que o ACOS alvo.")

    total_fees = (p * fees.total_variable_pct
                  + fees.fixed_fee_per_item + fees.extra_cost_per_unit)

    return ViabilityResult(
        sale_price=p,
        target_margin_pct=target_margin_pct,
        cmv_ceiling=_round(cmv_ceiling),
        net_profit_at_ceiling=_round(p * m),
        breakeven_price=_round(breakeven),
        total_fees_per_unit=_round(total_fees),
        viability_label=label if cmv_ceiling > 0 else "unviable",
        notes=notes,
    )
