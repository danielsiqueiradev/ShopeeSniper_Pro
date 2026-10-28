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
--
-- Por que DROP em vez de CREATE OR REPLACE: a vw_breach_opportunities
-- (004) depende desta view — CREATE OR REPLACE falha com
-- "cannot change data type of view column" quando há dependentes.
-- Dropamos as duas e recriamos em ordem. Idempotente.
-- ============================================================================

DROP VIEW IF EXISTS vw_breach_opportunities;
DROP VIEW IF EXISTS vw_sales_by_date_velocity;

CREATE VIEW vw_sales_by_date_velocity AS
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
            THEN GREATEST(sold_30_days - prev_sold_30_days, 0)::BIGINT
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

-- recria a dependente (conteúdo idêntico ao 004_breach_opportunities.sql)

CREATE OR REPLACE FUNCTION _ssp_fees(p NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
    SELECT LEAST(p * 0.14, 100)          -- comissão c/ teto
         + p * 0.06                      -- programa frete grátis
         + CASE WHEN p < 8 THEN p / 2 ELSE 4 END   -- taxa fixa
         + p * 0.06 + p * 0.08           -- imposto + ads
$$;

CREATE VIEW vw_breach_opportunities AS
WITH latest AS (
    SELECT DISTINCT ON (item_id)
        item_id, snapshot_date, price, stock, sold_30_days,
        historical_sold, rating_star
    FROM product_daily_snapshots
    ORDER BY item_id, snapshot_date DESC
),
velo AS (
    SELECT
        item_id,
        SUM(sales_on_date) FILTER (WHERE snapshot_date >= CURRENT_DATE - 7)  AS vendas_ultimos_7d,
        SUM(sales_on_date) FILTER (WHERE snapshot_date >= CURRENT_DATE - 30) AS vendas_ultimos_30d,
        COUNT(sales_on_date)                                                   AS dias_com_delta
    FROM vw_sales_by_date_velocity
    GROUP BY item_id
)
SELECT
    p.item_id,
    p.name,
    p.shop_id,
    s.shop_name,
    l.snapshot_date,
    l.price,
    l.sold_30_days,
    l.historical_sold,
    l.stock,
    l.rating_star                       AS product_rating,
    s.rating_star                       AS shop_rating,
    s.response_rate                     AS chat_rate,
    s.follower_count,
    to_timestamp(p.ctime)               AS anuncio_criado_em,
    (CURRENT_DATE - to_timestamp(p.ctime)::date) AS anuncio_idade_dias,
    ROUND(COALESCE(l.sold_30_days, 0) * l.price, 2) AS receita_30d,
    v.vendas_ultimos_7d,
    v.vendas_ultimos_30d,
    v.dias_com_delta,
    ROUND(l.price - _ssp_fees(l.price), 2)          AS lucro_unitario_bruto,
    ROUND(l.price - _ssp_fees(l.price) - 0.2 * l.price, 2) AS cmv_teto_20pct,
    ROUND(
        LEAST(40, COALESCE(l.sold_30_days, 0) * l.price / 4000.0)
        + LEAST(20, COALESCE(v.vendas_ultimos_7d, 0) / 15.0)
        + LEAST(20, GREATEST(0, (4.8 - COALESCE(l.rating_star, 5)) * 40))
        + LEAST(12, GREATEST(0, (4.8 - COALESCE(s.rating_star, 4.8)) * 100))
        + LEAST(8,  (100 - COALESCE(s.response_rate, 100)) / 15.0)
    , 1) AS opportunity_score,
    CASE
        WHEN COALESCE(l.sold_30_days,0) * l.price >= 60000
         AND (l.rating_star IS NULL OR l.rating_star < 4.5)
         AND l.price - _ssp_fees(l.price) - 0.2*l.price > 10
            THEN 'OPORTUNIDADE'
        WHEN COALESCE(l.sold_30_days,0) * l.price >= 30000
         AND (l.rating_star IS NULL OR l.rating_star < 4.6)
         AND l.price - _ssp_fees(l.price) - 0.2*l.price > 5
            THEN 'BOM SINAL'
        ELSE 'MONITOR'
    END AS sinal
FROM latest l
JOIN monitored_products p ON p.item_id = l.item_id
LEFT JOIN competitor_shops s ON s.shop_id = p.shop_id
LEFT JOIN velo v ON v.item_id = l.item_id
WHERE COALESCE(l.sold_30_days, 0) > 0
  AND l.price > 0
ORDER BY opportunity_score DESC;
