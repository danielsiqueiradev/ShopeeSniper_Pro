-- ============================================================================
-- Migration 004 — vw_breach_opportunities: score de brecha por item
--
-- Tese: demanda real mas NÃO saturada + produto fraco (rating baixo)
-- + vendedor fraco (rating/chat baixo) = onde dá pra ganhar do líder.
--
-- Score 0-100:
--   demanda 30d      até 40 pts  (teto em 3.000 — acima disso satura)
--   saturação        -15 pts     (sold_30d > 5.000 = oceano vermelho)
--   produto fraco    até 30 pts  (rating < 4.8 pesa mais quanto menor)
--   loja fraca       até 20 pts  (rating da loja < 4.8)
--   chat fraco       até 10 pts  (response_rate baixo = conversão vazando)
-- ============================================================================

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
    ROUND(
        LEAST(40, COALESCE(l.sold_30_days, 0) / 75.0)
        - CASE WHEN COALESCE(l.sold_30_days, 0) > 5000 THEN 15 ELSE 0 END
        + LEAST(30, GREATEST(0, (4.8 - COALESCE(l.rating_star, 5)) * 60))
        + LEAST(20, GREATEST(0, (4.8 - COALESCE(s.rating_star, 4.8)) * 100))
        + LEAST(10, (100 - COALESCE(s.response_rate, 100)) / 10.0)
    , 1) AS breach_score
FROM latest l
JOIN monitored_products p ON p.item_id = l.item_id
LEFT JOIN competitor_shops s ON s.shop_id = p.shop_id
WHERE COALESCE(l.sold_30_days, 0) > 0          -- sem demanda = sem brecha
ORDER BY breach_score DESC;
