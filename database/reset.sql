-- Reset: dropa TODOS os objetos de schemas antigos antes de migrar.
-- Rode ANTES de 001_supabase_schema.sql se o projeto Supabase já tiver
-- sido usado por outro schema (ex.: erro 42703 "column does not exist"
-- causado por CREATE TABLE IF NOT EXISTS pulando tabelas legadas).

-- função nova + possíveis funções antigas
DROP FUNCTION IF EXISTS ingest_shopee_batch(jsonb) CASCADE;
DROP FUNCTION IF EXISTS upsert_daily_snapshot(bigint, int, bigint) CASCADE;
DROP FUNCTION IF EXISTS upsert_daily_snapshot(bigint, int, bigint, date) CASCADE;
DROP FUNCTION IF EXISTS update_product_velocity() CASCADE;

-- views
DROP VIEW IF EXISTS vw_sales_by_date_velocity CASCADE;
DROP VIEW IF EXISTS v_product_radar CASCADE;

-- schema novo (ordem: filhos primeiro / CASCADE resolve)
DROP TABLE IF EXISTS product_negative_reviews CASCADE;
DROP TABLE IF EXISTS product_sku_models CASCADE;
DROP TABLE IF EXISTS product_daily_snapshots CASCADE;
DROP TABLE IF EXISTS monitored_products CASCADE;
DROP TABLE IF EXISTS competitor_shops CASCADE;
DROP TABLE IF EXISTS niches CASCADE;

-- schema antigo (product_daily_snapshots era PARTICIONADA — CASCADE
-- derruba as partições junto)
DROP TABLE IF EXISTS shop_daily_snapshots CASCADE;
DROP TABLE IF EXISTS product_velocity_metrics CASCADE;
DROP TABLE IF EXISTS product_reviews CASCADE;
DROP TABLE IF EXISTS product_reviews_summary CASCADE;
DROP TABLE IF EXISTS niche_daily_stats CASCADE;
DROP TABLE IF EXISTS profit_simulations CASCADE;
DROP TABLE IF EXISTS crawl_jobs CASCADE;
DROP TABLE IF EXISTS internal_ads_daily CASCADE;
DROP TABLE IF EXISTS internal_orders CASCADE;
DROP TABLE IF EXISTS shopee_connections CASCADE;
DROP TABLE IF EXISTS users CASCADE;
