-- ============================================================================
-- Migration 006 — recalibra vw_breach_opportunities pra tese REAL do usuário:
--   "até 300 vendas/mês, boa procura, R$ 15–120, margem p/ kit, brecha no líder"
--
-- A 004 foi calibrada pra campeão de vendas (OPORTUNIDADE exigia receita_30d
-- >= R$ 60 mil — impossível dentro do teto de 300×R$120=R$36k). Resultado:
-- 100% dos itens viravam MONITOR e a limpeza do tracker marcava tudo.
--
-- Nova régua (alinhada ao ⚔️ Plano de Entrada do drawer: só é sinal se
-- houver brecha explorável — incumbente sólido vira MONITOR):
--   OPORTUNIDADE — faixa da tese + brecha forte
--     · sold_30_days entre 30 e 300  (demanda provada, não saturada)
--     · price entre R$ 15 e R$ 120   (comporta margem e kit)
--     · lucro_unitario_bruto > 5     (sobra algo por venda)
--     · brecha: produto <4.6★ OU chat <70% OU loja <4.7★
--   BOM SINAL — mesma faixa, brecha mais fraca
--     · produto <4.8★ OU chat <85% OU loja <4.8★
--   MONITOR — o resto (inclui incumbentes sólidos com demanda)
--
-- Score recalibrado: receita em cheio aos R$ 20k/mês (300 vendas × ~R$67),
-- não mais R$ 160k. Mesmas colunas → CREATE OR REPLACE é seguro.
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
    ROUND(COALESCE(l.sold_30_days, 0) * l.price, 2) AS receita_30d,
    v.vendas_ultimos_7d,
    v.vendas_ultimos_30d,
    v.dias_com_delta,
    ROUND(l.price - _ssp_fees(l.price), 2)          AS lucro_unitario_bruto,
    ROUND(l.price - _ssp_fees(l.price) - 0.2 * l.price, 2) AS cmv_teto_20pct,
    ROUND(
        LEAST(40, COALESCE(l.sold_30_days, 0) * l.price / 500.0)
        + LEAST(20, COALESCE(v.vendas_ultimos_7d, 0) / 3.5)
        + LEAST(20, GREATEST(0, (4.8 - COALESCE(l.rating_star, 5)) * 40))
        + LEAST(12, GREATEST(0, (4.8 - COALESCE(s.rating_star, 4.8)) * 100))
        + LEAST(8,  (100 - COALESCE(s.response_rate, 100)) / 15.0)
    , 1) AS opportunity_score,
    CASE
        WHEN COALESCE(l.sold_30_days, 0) BETWEEN 30 AND 300
         AND l.price BETWEEN 15 AND 120
         AND l.price - _ssp_fees(l.price) > 5
         AND (COALESCE(l.rating_star, 5) < 4.6
              OR COALESCE(s.response_rate, 100) < 70
              OR COALESCE(s.rating_star, 5) < 4.7)
            THEN 'OPORTUNIDADE'
        -- BOM SINAL: mesma faixa da tese, mas brecha mais fraca.
        -- Campeões saturados (>300) e incumbentes sem falha caem em
        -- MONITOR: demanda sem brecha explorável não é oportunidade
        WHEN COALESCE(l.sold_30_days, 0) BETWEEN 30 AND 300
         AND l.price BETWEEN 15 AND 120
         AND (COALESCE(l.rating_star, 5) < 4.8
              OR COALESCE(s.response_rate, 100) < 85
              OR COALESCE(s.rating_star, 5) < 4.8)
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
