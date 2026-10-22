-- ============================================================================
-- Migration 002 — delta com fallback pra sold_30_days
--
-- A view original só derivava vendas/dia via LAG(historical_sold), mas
-- historical_sold só vem do /item/get — que a extensão não chama mais
-- (modo 100% passivo, anti-bot). Resultado: coluna NULL → delta NULL.
--
-- Fix: quando historical_sold falta, deriva do delta de sold_30_days
-- (vendas_ontem − vendas_que_sairam_da_janela_30d — aproximação, mas
-- consistente). Quando historical_sold existe (PDPs capturam via
-- pdp/get_pc), continua usando o exato.
-- ============================================================================

CREATE OR REPLACE VIEW vw_sales_by_date_velocity AS
WITH ordered AS (
    SELECT
        s.item_id,
        s.snapshot_date,
        s.price,
        s.historical_sold,
        s.sold_30_days,
        s.stock,
        LAG(s.historical_sold) OVER w AS prev_historical_sold,
        LAG(s.sold_30_days)    OVER w AS prev_sold_30_days,
        LAG(s.snapshot_date)   OVER w AS prev_snapshot_date
    FROM product_daily_snapshots s
    WINDOW w AS (PARTITION BY s.item_id ORDER BY s.snapshot_date)
)
SELECT
    item_id,
    snapshot_date,
    price,
    historical_sold,
    sold_30_days,
    stock,
    -- vendas do dia: exato via acumulado; fallback via janela de 30d;
    -- reset de contador (delta<0) → 0; sem baseline → NULL
    CASE
        WHEN prev_historical_sold IS NOT NULL
             AND historical_sold IS NOT NULL
            THEN GREATEST(historical_sold - prev_historical_sold, 0)
        WHEN prev_sold_30_days IS NOT NULL
             AND sold_30_days IS NOT NULL
            THEN GREATEST(sold_30_days - prev_sold_30_days, 0)
        ELSE NULL
    END AS sales_on_date,
    -- receita estimada do dia (delta × preço do snapshot)
    CASE
        WHEN prev_historical_sold IS NOT NULL
             AND historical_sold IS NOT NULL
            THEN GREATEST(historical_sold - prev_historical_sold, 0) * price
        WHEN prev_sold_30_days IS NOT NULL
             AND sold_30_days IS NOT NULL
            THEN GREATEST(sold_30_days - prev_sold_30_days, 0) * price
        ELSE NULL
    END AS revenue_on_date,
    -- dias efetivamente decorridos (normaliza gaps de coleta)
    snapshot_date - prev_snapshot_date AS days_since_prev
FROM ordered;
