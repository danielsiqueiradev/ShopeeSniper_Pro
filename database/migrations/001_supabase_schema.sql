-- ============================================================================
-- ShopeeSniper Pro — Schema Supabase/PostgreSQL
-- Tabelas de inteligência de mercado + snapshots diários (time-series)
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. NICHOS (keywords pesquisadas)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS niches (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    keyword           TEXT NOT NULL UNIQUE,
    avg_ticket        NUMERIC(12,2) DEFAULT 0,
    total_30d_revenue NUMERIC(14,2) DEFAULT 0,
    total_30d_volume  INTEGER DEFAULT 0,
    avg_seller_rating NUMERIC(3,2)  DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- 2. LOJAS CONCORRENTES
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS competitor_shops (
    shop_id          BIGINT PRIMARY KEY,
    shop_name        TEXT,
    location         TEXT,
    rating_star      NUMERIC(3,2),
    response_rate    NUMERIC(5,2),          -- % de resposta no chat
    follower_count   INTEGER,
    is_official_shop BOOLEAN DEFAULT FALSE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- 3. PRODUTOS MONITORADOS
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitored_products (
    item_id     BIGINT PRIMARY KEY,
    shop_id     BIGINT REFERENCES competitor_shops(shop_id) ON DELETE SET NULL,
    name        TEXT,
    ctime       BIGINT,                     -- unix ts de criação do anúncio
    category_id BIGINT,
    image_url   TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitored_products_shop ON monitored_products(shop_id);
CREATE INDEX IF NOT EXISTS idx_monitored_products_ctime ON monitored_products(ctime);

-- --------------------------------------------------------------------------
-- 4. SNAPSHOTS DIÁRIOS (time-series — coração do Sales Velocity Engine)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_daily_snapshots (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id         BIGINT NOT NULL REFERENCES monitored_products(item_id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    price           NUMERIC(12,2),
    stock           INTEGER,
    sold_30_days    INTEGER,
    historical_sold BIGINT,
    rating_star     NUMERIC(3,2),
    rating_count    INTEGER,
    UNIQUE (item_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_date
    ON product_daily_snapshots(item_id, snapshot_date);

-- --------------------------------------------------------------------------
-- 5. MODELOS/SKUs DOS PRODUTOS (variações: cor, tamanho...)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_sku_models (
    model_id   BIGINT PRIMARY KEY,
    item_id    BIGINT NOT NULL REFERENCES monitored_products(item_id) ON DELETE CASCADE,
    sku_name   TEXT,
    price      NUMERIC(12,2),
    stock      INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sku_models_item ON product_sku_models(item_id);

-- --------------------------------------------------------------------------
-- 6. REVIEWS NEGATIVAS (1–3★) pra pain mining
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_negative_reviews (
    rating_id   BIGINT PRIMARY KEY,
    item_id     BIGINT NOT NULL REFERENCES monitored_products(item_id) ON DELETE CASCADE,
    rating_star SMALLINT CHECK (rating_star BETWEEN 1 AND 3),
    comment     TEXT,
    created_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_neg_reviews_item ON product_negative_reviews(item_id);

-- ============================================================================
-- VIEW: vendas por data via LAG() sobre historical_sold
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
    -- vendas do dia: delta do acumulado; reset de contador (delta<0) → 0
    CASE
        WHEN prev_historical_sold IS NULL THEN NULL
        WHEN historical_sold - prev_historical_sold < 0 THEN 0
        ELSE historical_sold - prev_historical_sold
    END AS sales_on_date,
    -- receita estimada do dia (delta × preço do snapshot)
    CASE
        WHEN prev_historical_sold IS NULL THEN NULL
        WHEN historical_sold - prev_historical_sold < 0 THEN 0
        ELSE (historical_sold - prev_historical_sold) * price
    END AS revenue_on_date,
    -- dias efetivamente decorridos (normaliza gaps de coleta)
    snapshot_date - prev_snapshot_date AS days_since_prev
FROM ordered;

-- ============================================================================
-- RPC: ingest_shopee_batch — upsert atômico de um lote capturado pela extensão
-- payload = {"items": [...], "shop": {...} | null}
-- Cada item: {item_id, shop_id, name, ctime, category_id, image_url, price,
--             stock, sold_30_days (ou historical_sold), historical_sold,
--             rating_star, rating_count, models: [{model_id,name,price,stock}]}
-- ============================================================================
-- helper: JSONB → NUMERIC tolerante. A Shopee manda campos numéricos
-- como array (catid = path de categorias, rating_count = [total, ...]).
-- arr_idx escolhe o índice do array (-1 = último). Não-numérico → NULL.
CREATE OR REPLACE FUNCTION _ssp_num(j JSONB, k TEXT, arr_idx INT DEFAULT 0)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN j -> k IS NULL OR jsonb_typeof(j -> k) = 'null' THEN NULL
        WHEN jsonb_typeof(j -> k) = 'array' THEN
            CASE WHEN COALESCE(j -> k ->> arr_idx, '') ~ '^-?\d+(\.\d+)?$'
                 THEN (j -> k ->> arr_idx)::NUMERIC ELSE NULL END
        WHEN COALESCE(j ->> k, '') ~ '^-?\d+(\.\d+)?$' THEN (j ->> k)::NUMERIC
        ELSE NULL
    END
$$;

CREATE OR REPLACE FUNCTION ingest_shopee_batch(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER               -- roda como owner: permite a extensão (anon)
SET search_path = public       --  escrever via RPC sem abrir INSERT direto
AS $$
DECLARE
    item            JSONB;
    model           JSONB;
    shop            JSONB;
    n_products      INT := 0;
    n_snapshots     INT := 0;
    n_models        INT := 0;
BEGIN
    -- shop (se vier agregado do /shop/get_shop_base)
    shop := payload -> 'shop';
    IF shop IS NOT NULL AND _ssp_num(shop, 'shopid') IS NOT NULL THEN
        INSERT INTO competitor_shops
            (shop_id, shop_name, location, rating_star, response_rate,
             follower_count, is_official_shop, updated_at)
        VALUES (
            _ssp_num(shop, 'shopid')::BIGINT,
            shop ->> 'name',
            shop ->> 'location',
            _ssp_num(shop, 'rating_star'),
            _ssp_num(shop, 'response_rate'),
            _ssp_num(shop, 'follower_count')::INT,
            COALESCE((shop ->> 'is_official_shop')::BOOLEAN, FALSE),
            now()
        )
        ON CONFLICT (shop_id) DO UPDATE SET
            shop_name      = EXCLUDED.shop_name,
            location       = EXCLUDED.location,
            rating_star    = EXCLUDED.rating_star,
            response_rate  = EXCLUDED.response_rate,
            follower_count = EXCLUDED.follower_count,
            updated_at     = now();
    END IF;

    -- itens (cada um num bloco: um item ruim não derruba o lote)
    FOR item IN SELECT * FROM jsonb_array_elements(payload -> 'items') LOOP
        IF _ssp_num(item, 'itemid') IS NULL THEN
            CONTINUE;
        END IF;

        BEGIN
            -- upsert da loja embutida no item, se houver
            IF _ssp_num(item, 'shopid') IS NOT NULL THEN
                INSERT INTO competitor_shops (shop_id, updated_at)
                VALUES (_ssp_num(item, 'shopid')::BIGINT, now())
                ON CONFLICT (shop_id) DO NOTHING;
            END IF;

            INSERT INTO monitored_products
                (item_id, shop_id, name, ctime, category_id, image_url, updated_at)
            VALUES (
                _ssp_num(item, 'itemid')::BIGINT,
                _ssp_num(item, 'shopid')::BIGINT,
                item ->> 'name',
                _ssp_num(item, 'ctime')::BIGINT,
                _ssp_num(item, 'catid', -1)::BIGINT, -- path de categorias → folha
                item ->> 'image',
                now()
            )
            ON CONFLICT (item_id) DO UPDATE SET
                shop_id  = COALESCE(EXCLUDED.shop_id, monitored_products.shop_id),
                name     = COALESCE(EXCLUDED.name, monitored_products.name),
                ctime    = COALESCE(EXCLUDED.ctime, monitored_products.ctime),
                updated_at = now();
            n_products := n_products + 1;

            -- snapshot diário (idempotente por UNIQUE(item_id, snapshot_date))
            INSERT INTO product_daily_snapshots
                (item_id, snapshot_date, price, stock, sold_30_days,
                 historical_sold, rating_star, rating_count)
            VALUES (
                _ssp_num(item, 'itemid')::BIGINT,
                CURRENT_DATE,
                _ssp_num(item, 'price'),
                _ssp_num(item, 'stock')::INT,
                _ssp_num(item, 'sold_30_days')::INT,
                _ssp_num(item, 'historical_sold')::BIGINT,
                _ssp_num(item, 'rating_star'),
                _ssp_num(item, 'rating_count')::INT
            )
            ON CONFLICT (item_id, snapshot_date) DO UPDATE SET
                price           = EXCLUDED.price,
                stock           = EXCLUDED.stock,
                sold_30_days    = EXCLUDED.sold_30_days,
                historical_sold = EXCLUDED.historical_sold,
                rating_star     = EXCLUDED.rating_star,
                rating_count    = EXCLUDED.rating_count;
            n_snapshots := n_snapshots + 1;

            -- modelos/SKUs
            IF item -> 'models' IS NOT NULL THEN
                FOR model IN SELECT * FROM jsonb_array_elements(item -> 'models') LOOP
                    IF _ssp_num(model, 'modelid') IS NULL THEN
                        CONTINUE;
                    END IF;
                    INSERT INTO product_sku_models
                        (model_id, item_id, sku_name, price, stock, updated_at)
                    VALUES (
                        _ssp_num(model, 'modelid')::BIGINT,
                        _ssp_num(item, 'itemid')::BIGINT,
                        COALESCE(model ->> 'name', model ->> 'model_name'),
                        _ssp_num(model, 'price'),
                        _ssp_num(model, 'stock')::INT,
                        now()
                    )
                    ON CONFLICT (model_id) DO UPDATE SET
                        price      = EXCLUDED.price,
                        stock      = EXCLUDED.stock,
                        updated_at = now();
                    n_models := n_models + 1;
                END LOOP;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- item malformado não pode derrubar os outros N-1 do lote
            RAISE WARNING 'ingest_shopee_batch: item % ignorado: %',
                          item ->> 'itemid', SQLERRM;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'products_upserted', n_products,
        'snapshots_upserted', n_snapshots,
        'models_upserted', n_models
    );
END;
$$;

-- ============================================================================
-- RLS (Supabase): leitura pública opcional — ajuste conforme sua política
-- ============================================================================
ALTER TABLE niches                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_shops         ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitored_products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_daily_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sku_models       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_negative_reviews ENABLE ROW LEVEL SECURITY;

-- Leitura anônima liberada (dashboard público); escrita só via service_role/RPC
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'niches','competitor_shops','monitored_products',
        'product_daily_snapshots','product_sku_models','product_negative_reviews']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS read_all ON %I', t);
        EXECUTE format(
            'CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
    END LOOP;
END $$;
