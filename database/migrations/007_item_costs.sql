-- ============================================================================
-- Migration 007 — item_costs: cotação de fornecedor + pipeline de decisão
--
-- O dashboard preenche custo real, frete de compra e MOQ por item — é o que
-- transforma "CMV teto teórico" em ROI/payback/breakeven de verdade.
-- Mesma regra da tracked_items: ferramenta pessoal, read+write liberado
-- pro anon (demais tabelas seguem só-leitura via REST).
-- ============================================================================

CREATE TABLE IF NOT EXISTS item_costs (
    item_id        BIGINT PRIMARY KEY REFERENCES monitored_products(item_id) ON DELETE CASCADE,
    status         TEXT NOT NULL DEFAULT 'observando'
                   CHECK (status IN ('observando','cotando','teste','escalando','cortado')),
    supplier_url   TEXT,
    unit_cost      NUMERIC(12,2),
    buy_freight    NUMERIC(12,2) DEFAULT 0,   -- frete da reposição, rateado por un
    moq            INTEGER DEFAULT 1,
    lead_time_days INTEGER,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE item_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_all ON item_costs;
CREATE POLICY read_all ON item_costs FOR SELECT USING (true);

DROP POLICY IF EXISTS write_all ON item_costs;
CREATE POLICY write_all ON item_costs FOR ALL
    USING (true) WITH CHECK (true);
