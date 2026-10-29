-- ============================================================================
-- Migration 008 — limpa sold_30_days poluído por acumulado histórico
--
-- Bug corrigido na extensão (soldFields / fixSoldSemantics): payloads de
-- PDP trazem `sold` = total da vida do anúncio, mas era gravado como
-- vendas de 30d → snapshots com "30d" = 10.000/100.000 e receita_30d
-- inflada na vw_breach_opportunities.
--
-- Cleanup seguro: anula sold_30_days quando ele é ≈ o histórico (≥90%)
-- E o anúncio tem mais de 35 dias — nesse caso a igualdade só pode ser
-- acumulado duplicado. Anúncio novo (<30d) mantém: pra ele 30d == total
-- de forma legítima.
-- ============================================================================

UPDATE product_daily_snapshots s
SET    sold_30_days = NULL
FROM   monitored_products p
WHERE  p.item_id = s.item_id
  AND  s.sold_30_days IS NOT NULL
  AND  s.historical_sold IS NOT NULL
  AND  s.sold_30_days >= s.historical_sold * 0.9
  AND  p.ctime IS NOT NULL
  AND  to_timestamp(p.ctime)::date < CURRENT_DATE - 35;

-- conferência rápida pós-cleanup:
--   SELECT count(*) FROM product_daily_snapshots
--   WHERE sold_30_days >= historical_sold * 0.9 AND historical_sold IS NOT NULL;
