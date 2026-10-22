-- ============================================================================
-- Migration 004 — vw_breach_opportunities: radar de oportunidades p/ REVENDA
--
-- Tese: comprar do fornecedor e revender. "Ei cria, olha esse item: vende
-- bem, tem espaço no mercado e dá bom lucro — probabilidade de sucesso alta."
--
-- Score 0-100:
--   receita 30d      até 40 pts  (sold_30d × preço — demanda em R$)
--   saída real       até 20 pts  (deltas diários medidos pela série temporal)
--   produto fraco    até 20 pts  (rating < 4.8 — review ruim = produto melhorável)
--   loja+chat fraco  até 20 pts  (rating loja + response_rate baixo)
--
-- Colunas de decisão:
--   vendas_ultimos_7d / 30d  — deltas reais entre snapshots (prova a saída)
--   lucro_unitario_bruto     — o que sobra por venda depois das taxas
--   cmv_teto_20pct           — custo máx. do fornecedor p/ 20% de margem
--   sinal                    — OPORTUNIDADE / BOM SINAL / MONITOR
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
    -- demanda em dinheiro + saída real medida
    ROUND(COALESCE(l.sold_30_days, 0) * l.price, 2) AS receita_30d,
    v.vendas_ultimos_7d,
    v.vendas_ultimos_30d,
    v.dias_com_delta,
    -- o que sobra por unidade depois das taxas da Shopee
    ROUND(l.price - _ssp_fees(l.price), 2)          AS lucro_unitario_bruto,
    -- custo máximo do fornecedor pra manter 20% de margem
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
