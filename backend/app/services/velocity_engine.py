"""
Sales Velocity Engine — coração da inteligência de mercado.

Problema: a Shopee só expõe vendas ACUMULADAS (historical_sold / item.sold).
Solução: snapshot diário por produto → velocidade = delta entre snapshots.

    sold_24h   = historical_sold(D0) - historical_sold(D-1)
    sold_Nd    = historical_sold(D0) - historical_sold(D-N)
    trend      = avg_daily(7d) / avg_daily(30d)

Edge cases tratados:
  - Produto novo sem D-1            -> delta = None (insufficient_data)
  - historical_sold diminuiu        -> reset/contagem da Shopee; clamp em 0 e flag
  - Gap de dias sem snapshot        -> normaliza pelo nº real de dias decorridos
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Sequence


@dataclass(frozen=True)
class Snapshot:
    snapshot_date: date
    historical_sold: int
    price: float
    stock: int | None = None


@dataclass
class VelocityMetrics:
    sold_last_24h: int | None
    sold_last_7d: int | None
    sold_last_15d: int | None
    sold_last_30d: int | None
    avg_daily_7d: float | None
    avg_daily_30d: float | None
    trend_ratio_7v30: float | None   # >1.15 rising | <0.85 falling
    trend_label: str                 # rising | stable | falling | insufficient_data
    anomalies: list[str]


RISING_THRESHOLD = 1.15
FALLING_THRESHOLD = 0.85


def _find_snapshot_on_or_before(
    snaps: Sequence[Snapshot], target: date
) -> Snapshot | None:
    """Busca o snapshot mais recente com data <= target (lista ordenada desc)."""
    for s in snaps:
        if s.snapshot_date <= target:
            return s
    return None


def _delta(current: Snapshot, past: Snapshot | None, max_gap_days: int) -> tuple[int | None, float | None, str | None]:
    """
    Retorna (delta_vendas, dias_efetivos, anomalia).
    delta=None quando não há baseline confiável.
    """
    if past is None:
        return None, None, "no_baseline"

    gap = (current.snapshot_date - past.snapshot_date).days
    if gap <= 0:
        return None, None, "same_day"
    if gap > max_gap_days:
        return None, None, "stale_baseline"  # janela de coleta quebrada

    delta = current.historical_sold - past.historical_sold
    if delta < 0:
        # Shopee resetou o contador ou houve purge de pedidos cancelados.
        # Trata como zero para não gerar velocidade negativa no dashboard.
        return 0, float(gap), "counter_reset"
    return delta, float(gap), None


def compute_velocity(
    snapshots: Sequence[Snapshot],
    windows: tuple[int, ...] = (1, 7, 15, 30),
    max_gap_days: int = 3,
) -> VelocityMetrics:
    """
    snapshots: lista ordenada por snapshot_date DESC (D0 primeiro).

    A janela de N dias compara D0 com o snapshot mais próximo de D-N.
    Se houver gap de coleta (ex.: worker caiu 2 dias), normaliza pelo
    número real de dias — evitando superestimar a velocidade.
    """
    if not snapshots:
        return VelocityMetrics(None, None, None, None, None, None, None,
                               "insufficient_data", ["no_data"])

    d0 = snapshots[0]
    anomalies: list[str] = []
    deltas: dict[int, tuple[int | None, float | None]] = {}

    for w in windows:
        target = date.fromordinal(d0.snapshot_date.toordinal() - w)
        past = _find_snapshot_on_or_before(snapshots, target)
        delta, eff_days, anomaly = _delta(d0, past, max_gap_days=w + max_gap_days)
        deltas[w] = (delta, eff_days)
        if anomaly:
            anomalies.append(f"{anomaly}@{w}d")

    def avg(w: int) -> float | None:
        delta, eff_days = deltas.get(w, (None, None))
        if delta is None or not eff_days:
            return None
        return delta / eff_days

    avg7, avg30 = avg(7), avg(30)

    if avg7 is None or avg30 is None or avg30 == 0:
        trend_ratio, trend_label = None, "insufficient_data"
    else:
        trend_ratio = avg7 / avg30
        if trend_ratio >= RISING_THRESHOLD:
            trend_label = "rising"
        elif trend_ratio <= FALLING_THRESHOLD:
            trend_label = "falling"
        else:
            trend_label = "stable"

    return VelocityMetrics(
        sold_last_24h=deltas.get(1, (None,))[0],
        sold_last_7d=deltas.get(7, (None,))[0],
        sold_last_15d=deltas.get(15, (None,))[0],
        sold_last_30d=deltas.get(30, (None,))[0],
        avg_daily_7d=avg7,
        avg_daily_30d=avg30,
        trend_ratio_7v30=trend_ratio,
        trend_label=trend_label,
        anomalies=anomalies,
    )


def weighted_avg_ticket(products: Sequence[tuple[float, int]]) -> float:
    """
    Ticket médio ponderado por volume de vendas dos Top 50 anúncios do nicho.
    products: lista de (price, sold_30d)
    """
    total_vol = sum(v for _, v in products if v and v > 0)
    if total_vol == 0:
        return 0.0
    return sum(p * v for p, v in products if v and v > 0) / total_vol


def market_concentration(sellers_volume: Sequence[int]) -> tuple[float, float]:
    """
    Índice de concentração do nicho.
    Retorna (top3_share, hhi):
      - top3_share: fração (0-1) das vendas dos 3 maiores vendedores
      - hhi: Herfindahl-Hirschman Index (0-1; >0.25 = mercado concentrado)
    """
    total = sum(sellers_volume)
    if total <= 0:
        return 0.0, 0.0
    shares = sorted((v / total for v in sellers_volume), reverse=True)
    top3 = sum(shares[:3])
    hhi = sum(s * s for s in shares)
    return round(top3, 4), round(hhi, 6)
