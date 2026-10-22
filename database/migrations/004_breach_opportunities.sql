-- ============================================================================
-- Migration 004 — vw_breach_opportunities: score de oportunidade p/ REVENDA
--
-- Tese: comprar do fornecedor e revender. O que importa é demanda alta +
-- lucro + concorrente fraco o suficiente pra perder venda pra você.
--
-- Score 0-100:
--   receita 30d      até 50 pts  (sold_30d × preço — demanda em R$)
--   produto fraco    até 30 pts  (rating < 4.8 — review ruim = produto melhorável)
--   loja+chat fraco  até 20 pts  (rating loja + response_rate baixo)
--
-- Unit economics (espelha unit_economics.py):
--   comissão 14% (teto R$100) + frete grátis 6% + fixa R$4 (ou preço/2 se <R$8)
--   + imposto 6% + ads 8%
--   lucro_unitario = preço − taxas | cmv_teto = máx. custo fornecedor p/ 20% margem
-- ============================================================================

CREATE OR REPLACE FUNCTION _ssp_fees(p NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
    SELECT LEAST(p * 0.14, 100)          -- comissão c/ teto
         + p * 0.06                      -- programa frete grátis
         + CASE WHEN p < 8 THEN p / 2 ELSE 4 END   -- taxa fixa
         + p * 0.06 + p * 0.08           -- imposto + ads
$$;

CREATE OR REPLACE VIEW vw_breach_opportunities AS
WITH latest AS (
    SELECT DISTINCT ON (item_id)
        item_id, snapshot_date, price, stock, sold_30_days,
        historical_sold, rating_star
    FROM product_daily_snapshots
    ORDER BY item_id, snapshot_date DESC
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
    -- demanda em dinheiro
    ROUND(COALESCE(l.sold_30_days, 0) * l.price, 2) AS receita_30d,
    -- o que sobra por unidade depois das taxas da Shopee
    ROUND(l.price - _ssp_fees(l.price), 2)          AS lucro_unitario_bruto,
    -- custo máximo do fornecedor pra manter 20% de margem
    ROUND(l.price - _ssp_fees(l.price) - 0.2 * l.price, 2) AS cmv_teto_20pct,
    ROUND(
        LEAST(50, COALESCE(l.sold_30_days, 0) * l.price / 2000.0)
        + LEAST(30, GREATEST(0, (4.8 - COALESCE(l.rating_star, 5)) * 60))
        + LEAST(12, GREATEST(0, (4.8 - COALESCE(s.rating_star, 4.8)) * 100))
        + LEAST(8,  (100 - COALESCE(s.response_rate, 100)) / 10.0)
    , 1) AS opportunity_score
FROM latest l
JOIN monitored_products p ON p.item_id = l.item_id
LEFT JOIN competitor_shops s ON s.shop_id = p.shop_id
WHERE COALESCE(l.sold_30_days, 0) > 0
  AND l.price > 0
ORDER BY opportunity_score DESC;
