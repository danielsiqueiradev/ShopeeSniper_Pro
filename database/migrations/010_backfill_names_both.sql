-- ============================================================================
-- Migration 010 — backfill de nomes em ambas as direções
--
-- Itens restaurados no tracker entraram sem nome, e itens do
-- monitored_products podem ter sido ingeridos quando o payload não
-- trazia name. Aqui os dois lados se completam.
-- Idempotente: só toca NULL/vazio. Rode no SQL Editor.
-- ============================================================================

-- tracked_items ← monitored_products (caso mais comum: o restore
-- trouxe ids sem nome, mas o catálogo visto na busca tem o nome)
UPDATE tracked_items t
SET    name = mp.name,
       updated_at = now()
FROM   monitored_products mp
WHERE  mp.item_id = t.item_id
  AND  mp.name IS NOT NULL AND mp.name <> ''
  AND  (t.name IS NULL OR t.name = '');

-- monitored_products ← tracked_items (o inverso: item só conhecido
-- via track manual do usuário que gravou o nome)
UPDATE monitored_products mp
SET    name = t.name,
       updated_at = now()
FROM   tracked_items t
WHERE  t.item_id = mp.item_id
  AND  t.name IS NOT NULL AND t.name <> ''
  AND  (mp.name IS NULL OR mp.name = '');
