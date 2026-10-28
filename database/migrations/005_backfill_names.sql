-- ============================================================================
-- Migration 005 — backfill de nomes NULL em monitored_products
--
-- Itens ingeridos de payloads magros (recommend/SSR sem name) ficam com
-- monitored_products.name NULL, mas tracked_items.name foi capturado do
-- DOM no momento do 📌 — propaga de volta pros produtos monitorados.
-- Idempotente: rodável a qualquer momento, só toca em quem falta nome.
-- ============================================================================

UPDATE monitored_products mp
SET    name = t.name
FROM   tracked_items t
WHERE  t.item_id = mp.item_id
  AND  (mp.name IS NULL OR mp.name = '')
  AND  t.name IS NOT NULL AND t.name <> '';
