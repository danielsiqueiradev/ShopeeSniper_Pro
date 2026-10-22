-- ============================================================================
-- Migration 003 — tracked_items: itens marcados com 📌 pela extensão
--
-- Sync entre PCs: a extensão faz upsert/delete aqui e baixa a lista no
-- load (merge com localStorage). Read+write liberado pro anon porque é
-- ferramenta pessoal — escrita direta só nesta tabela (as demais seguem
-- write-protected, acesso via RPC SECURITY DEFINER).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tracked_items (
    item_id    BIGINT PRIMARY KEY,
    shop_id    BIGINT REFERENCES competitor_shops(shop_id) ON DELETE SET NULL,
    name       TEXT,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tracked_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_all ON tracked_items;
CREATE POLICY read_all ON tracked_items FOR SELECT USING (true);

DROP POLICY IF EXISTS write_all ON tracked_items;
CREATE POLICY write_all ON tracked_items FOR ALL
    USING (true) WITH CHECK (true);
