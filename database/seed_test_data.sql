-- Seed de teste: 1 loja, 2 produtos, 7 dias de snapshots
-- Rode DEPOIS de 001_supabase_schema.sql

INSERT INTO competitor_shops
    (shop_id, shop_name, location, rating_star, response_rate, follower_count, is_official_shop)
VALUES
    (900001, 'Concorrente Fraco LTDA', 'São Paulo', 4.5, 62.0, 800, false),
    (900002, 'Mall Forte Oficial', 'Guangdong', 4.9, 98.0, 150000, true)
ON CONFLICT (shop_id) DO NOTHING;

INSERT INTO monitored_products (item_id, shop_id, name, ctime, category_id, image_url)
VALUES
    (800001, 900001, 'Caneca Térmica 500ml Inox',
     EXTRACT(EPOCH FROM now() - INTERVAL '60 days')::BIGINT, 1001, 'cf1.png'),
    (800002, 900002, 'Mousepad Gamer RGB 80x30',
     EXTRACT(EPOCH FROM now() - INTERVAL '500 days')::BIGINT, 1002, 'cf2.png')
ON CONFLICT (item_id) DO NOTHING;

-- snapshots: produto 800001 vende ~8/dia e acelera; 800002 estagnado ~1/dia
INSERT INTO product_daily_snapshots
    (item_id, snapshot_date, price, stock, sold_30_days, historical_sold, rating_star, rating_count)
SELECT 800001,
       CURRENT_DATE - g.n,
       49.90, 300 - g.n * 8, 200 + g.n * 8, 1000 + (7 - g.n) * 8, 4.5, 320
FROM generate_series(7, 1, -1) AS g(n)
ON CONFLICT (item_id, snapshot_date) DO NOTHING;

INSERT INTO product_daily_snapshots
    (item_id, snapshot_date, price, stock, sold_30_days, historical_sold, rating_star, rating_count)
SELECT 800002,
       CURRENT_DATE - g.n,
       25.00, 5000, 30, 9000 + (7 - g.n) * 1, 4.9, 5100
FROM generate_series(7, 1, -1) AS g(n)
ON CONFLICT (item_id, snapshot_date) DO NOTHING;

INSERT INTO product_sku_models (model_id, item_id, sku_name, price, stock)
VALUES
    (700001, 800001, 'Preto', 49.90, 100),
    (700002, 800001, 'Branco', 49.90, 0),
    (700003, 800001, 'Vermelho', 54.90, 150),
    (700004, 800002, 'Único', 25.00, 5000)
ON CONFLICT (model_id) DO NOTHING;

INSERT INTO product_negative_reviews (rating_id, item_id, rating_star, comment)
VALUES
    (600001, 800001, 1, 'A caneca rasgou o revestimento em uma semana, material frágil'),
    (600002, 800001, 2, 'Veio com a embalagem amassada e atrasou a entrega'),
    (600003, 800001, 3, 'Tamanho menor que na foto, parece diferente do anúncio')
ON CONFLICT (rating_id) DO NOTHING;
