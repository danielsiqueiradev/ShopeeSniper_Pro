-- ============================================================================
-- Migration 009 — EAN (código de barras) nos itens trackados
--
-- O match do catálogo de fornecedores por EAN é a evidência mais forte
-- que existe (match exato, sem ambiguidade de texto). A Issam expõe o
-- EAN em data-id-produto/URL, a Modenuti em coluna própria.
--
-- Fonte na extensão: array `attributes` do payload (pdp/get_pc traz
-- "Código de barras" pra várias categorias) + fallback de raspagem do
-- bloco "Especificações" da PDP.
--
-- Vai em tracked_items (não monitored_products): o upsert via REST
-- direto evita cirurgia no RPC ingest_shopee_batch, e o consumidor
-- (aba 📦 Catálogo do dashboard) só precisa do EAN dos trackados.
-- ============================================================================

ALTER TABLE tracked_items ADD COLUMN IF NOT EXISTS ean TEXT;
CREATE INDEX IF NOT EXISTS idx_tracked_ean ON tracked_items(ean);
