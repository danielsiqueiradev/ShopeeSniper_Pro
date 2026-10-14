-- ============================================================================
-- ShopeeProfit AI — Database Schema (PostgreSQL 15+)
-- Otimizado para séries temporais (snapshots diários de produtos/shops).
-- Compatível com TimescaleDB (hypertables) — ver notas ao final.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- busca fuzzy em keywords/nomes

-- ============================================================================
-- 1. IDENTIDADE & AUTENTICAÇÃO DA PLATAFORMA
-- ============================================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT,
    plan            TEXT NOT NULL DEFAULT 'trial'
                    CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. MÓDULO INTERNO — SHOPEE OPEN PLATFORM (loja do próprio usuário)
-- ============================================================================

-- Tokens OAuth2 por loja conectada. Um usuário pode ter N shops (matriz/filiais).
CREATE TABLE shopee_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_id         BIGINT NOT NULL,                 -- shop_id retornado pela Shopee
    shop_name       TEXT,
    region          TEXT NOT NULL DEFAULT 'BR',      -- BR, SG, MY, ...
    access_token    TEXT NOT NULL,                   -- criptografar em repouso (app-level)
    refresh_token   TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,           -- access_token expira (~4h)
    refresh_expires_at TIMESTAMPTZ NOT NULL,         -- refresh_token expira (~30d)
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'revoked', 'error')),
    last_sync_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, shop_id)
);

-- Pedidos internos (conciliação de taxas e ticket médio real)
CREATE TABLE internal_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id   UUID NOT NULL REFERENCES shopee_connections(id) ON DELETE CASCADE,
    order_sn        TEXT NOT NULL,                   -- order serial number Shopee
    order_status    TEXT NOT NULL,
    order_time      TIMESTAMPTZ NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL,          -- valor pago pelo comprador
    escrow_amount   NUMERIC(12,2),                   -- valor líquido a receber
    commission_fee  NUMERIC(12,2),
    service_fee     NUMERIC(12,2),                   -- frete grátis / programas
    transaction_fee NUMERIC(12,2),
    shipping_fee    NUMERIC(12,2),
    items           JSONB NOT NULL DEFAULT '[]',     -- [{item_id, model_id, qty, price}]
    raw_payload     JSONB,                           -- resposta original p/ auditoria
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, order_sn)
);
CREATE INDEX idx_internal_orders_time ON internal_orders (connection_id, order_time DESC);

-- Performance de Shopee Ads por dia (ACOS/ROAS reais do usuário)
CREATE TABLE internal_ads_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id   UUID NOT NULL REFERENCES shopee_connections(id) ON DELETE CASCADE,
    report_date     DATE NOT NULL,
    campaign_id     BIGINT,
    item_id         BIGINT,
    impressions     INT NOT NULL DEFAULT 0,
    clicks          INT NOT NULL DEFAULT 0,
    spend           NUMERIC(12,2) NOT NULL DEFAULT 0,
    direct_revenue  NUMERIC(12,2) NOT NULL DEFAULT 0, -- GMV atribuído
    direct_orders   INT NOT NULL DEFAULT 0,
    UNIQUE (connection_id, report_date, campaign_id, item_id)
);

-- ============================================================================
-- 3. MÓDULO DE INTELIGÊNCIA DE MERCADO — NICHOS E CONCORRENTES
-- ============================================================================

-- Nicho = categoria Shopee + conjunto de palavras-chave monitoradas
CREATE TABLE niches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL = nicho global
    name            TEXT NOT NULL,
    shopee_category_id BIGINT,                       -- catid oficial da taxonomia
    keywords        TEXT[] NOT NULL DEFAULT '{}',    -- ["garrafa termica", "squeeze 1l"]
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_niches_keywords ON niches USING GIN (keywords);

-- Lojas concorrentes (Seller Intelligence / Radar de Vulnerabilidade)
CREATE TABLE competitor_shops (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         BIGINT NOT NULL UNIQUE,          -- shopid público Shopee
    name            TEXT NOT NULL,
    username        TEXT,
    location        TEXT,                            -- cidade/UF p/ análise de frete
    is_official     BOOLEAN NOT NULL DEFAULT FALSE,  -- Shopee Mall
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_crawled_at TIMESTAMPTZ
);

-- Snapshot diário das métricas do vendedor (permite detectar deterioração)
CREATE TABLE shop_daily_snapshots (
    id              BIGSERIAL,
    shop_id         BIGINT NOT NULL REFERENCES competitor_shops(shop_id),
    snapshot_date   DATE NOT NULL,
    rating_star     NUMERIC(3,2),                    -- nota geral da loja (ex: 4.82)
    response_rate   NUMERIC(5,2),                    -- % resposta chat (0-100)
    response_time_s INT,                             -- tempo médio de resposta (seg)
    ship_prep_days  NUMERIC(4,1),                    -- tempo de preparo de envio (dias)
    follower_count  INT,
    product_count   INT,
    rating_count    INT,
    -- métricas derivadas
    is_vulnerable   BOOLEAN GENERATED ALWAYS AS
        (rating_star < 4.70 OR response_rate < 80) STORED,
    PRIMARY KEY (shop_id, snapshot_date)
);
CREATE INDEX idx_shop_snap_date ON shop_daily_snapshots (snapshot_date DESC);
CREATE INDEX idx_shop_snap_vuln ON shop_daily_snapshots (snapshot_date)
    WHERE is_vulnerable;

-- ============================================================================
-- 4. PRODUTOS MONITORADOS + SÉRIE TEMPORAL (Sales Velocity Engine)
-- ============================================================================

CREATE TABLE monitored_products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         BIGINT NOT NULL,                 -- itemid público Shopee
    shop_id         BIGINT NOT NULL REFERENCES competitor_shops(shop_id),
    niche_id        UUID REFERENCES niches(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    image_url       TEXT,
    product_url     TEXT,
    brand           TEXT,
    category_path   TEXT[],                          -- ["Casa", "Cozinha", "Térmicas"]
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    monitoring      BOOLEAN NOT NULL DEFAULT TRUE,   -- false = para de snapshotar
    UNIQUE (item_id, shop_id)
);
CREATE INDEX idx_products_niche ON monitored_products (niche_id) WHERE monitoring;
CREATE INDEX idx_products_name_trgm ON monitored_products USING GIN (name gin_trgm_ops);

-- ★ TABELA CRUCIAL — um registro por produto por dia.
-- A Shopee expõe apenas vendas ACUMULADAS ("historical_sold"). A velocidade
-- diária é derivada: sold_delta = sold_today - sold_yesterday.
CREATE TABLE product_daily_snapshots (
    id              BIGSERIAL,
    product_id      UUID NOT NULL REFERENCES monitored_products(id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL,

    -- dados brutos coletados
    price           NUMERIC(12,2) NOT NULL,          -- preço efetivo (pós-promoção)
    price_before_discount NUMERIC(12,2),
    stock           INT,
    historical_sold INT NOT NULL,                    -- vendas acumuladas (cumulativo)
    liked_count     INT,
    comment_count   INT,
    rating_star     NUMERIC(3,2),
    rating_count    INT,

    -- derivados calculados pelo Velocity Engine no momento da ingestão
    sold_delta_1d   INT,                             -- vendas nas últimas 24h
    price_changed   BOOLEAN NOT NULL DEFAULT FALSE,  -- flutuação de preço vs D-1

    PRIMARY KEY (product_id, snapshot_date)
) PARTITION BY RANGE (snapshot_date);

-- Partições mensais (TimescaleDB dispensaria isso via hypertable)
CREATE TABLE product_daily_snapshots_2026_10 PARTITION OF product_daily_snapshots
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE product_daily_snapshots_2026_11 PARTITION OF product_daily_snapshots
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE product_daily_snapshots_2026_12 PARTITION OF product_daily_snapshots
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE INDEX idx_snap_date ON product_daily_snapshots (snapshot_date DESC);
CREATE INDEX idx_snap_product_date ON product_daily_snapshots (product_id, snapshot_date DESC);

-- ============================================================================
-- 5. VELOCIDADE AGREGADA (cache pré-computado para leitura do dashboard)
-- ============================================================================
-- Preenchida diariamente pelo worker após ingestão dos snapshots.
-- Evita recalcular janelas móveis (7d/15d/30d) a cada request da API.

CREATE TABLE product_velocity_metrics (
    product_id          UUID PRIMARY KEY REFERENCES monitored_products(id) ON DELETE CASCADE,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    sold_last_24h       INT NOT NULL DEFAULT 0,
    sold_last_7d        INT NOT NULL DEFAULT 0,
    sold_last_15d       INT NOT NULL DEFAULT 0,
    sold_last_30d       INT NOT NULL DEFAULT 0,
    avg_daily_7d        NUMERIC(10,2) NOT NULL DEFAULT 0,
    avg_daily_30d       NUMERIC(10,2) NOT NULL DEFAULT 0,
    -- curva de tendência: > 1.15 crescendo, < 0.85 caindo
    trend_ratio_7v30    NUMERIC(8,4),                -- avg_daily_7d / avg_daily_30d
    trend_label         TEXT GENERATED ALWAYS AS (
        CASE
            WHEN trend_ratio_7v30 IS NULL THEN 'insufficient_data'
            WHEN trend_ratio_7v30 >= 1.15 THEN 'rising'
            WHEN trend_ratio_7v30 <= 0.85 THEN 'falling'
            ELSE 'stable'
        END) STORED,
    revenue_est_30d     NUMERIC(14,2),               -- sold_30d * preço atual
    opportunity_score   NUMERIC(5,2),                -- 0-100 (ver scoring service)
    opportunity_factors JSONB                        -- breakdown p/ explainability
);
CREATE INDEX idx_velocity_score ON product_velocity_metrics (opportunity_score DESC NULLS LAST);
CREATE INDEX idx_velocity_trend ON product_velocity_metrics (trend_label);

-- ============================================================================
-- 6. ANÁLISE DE AVALIAÇÕES (Sentiment & Pain Mining)
-- ============================================================================

CREATE TABLE product_reviews (
    id              BIGSERIAL PRIMARY KEY,
    product_id      UUID NOT NULL REFERENCES monitored_products(id) ON DELETE CASCADE,
    review_id       TEXT NOT NULL UNIQUE,            -- id da review na Shopee
    author_masked   TEXT,
    rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    review_date     TIMESTAMPTZ,
    -- classificação do Pain Miner
    pain_categories TEXT[] DEFAULT '{}',             -- ['defeito','atraso','tamanho']
    sentiment       TEXT CHECK (sentiment IN ('negative','neutral','positive')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reviews_product_rating ON product_reviews (product_id, rating);
CREATE INDEX idx_reviews_pains ON product_reviews USING GIN (pain_categories);

-- Agregado por produto (regenerado pelo worker após cada coleta)
CREATE TABLE product_reviews_summary (
    product_id          UUID PRIMARY KEY REFERENCES monitored_products(id) ON DELETE CASCADE,
    total_reviews       INT NOT NULL DEFAULT 0,
    negative_reviews    INT NOT NULL DEFAULT 0,      -- 1-3 estrelas
    negative_ratio      NUMERIC(5,4),                -- negative/total
    top_pain_points     JSONB NOT NULL DEFAULT '[]', -- [{category, count, pct, samples}]
    improvement_insight TEXT,                        -- copywriting/QA sugerido (LLM ou regra)
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 7. ANÁLISE DE NICHO AGREGADA (Ticket Médio + Concentração)
-- ============================================================================

CREATE TABLE niche_daily_stats (
    id                  BIGSERIAL,
    niche_id            UUID NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
    stat_date           DATE NOT NULL,
    top_products_count  INT NOT NULL DEFAULT 0,      -- top 50 analisados
    weighted_avg_ticket NUMERIC(12,2),               -- ticket médio ponderado por volume
    total_sold_30d      INT,
    total_revenue_est   NUMERIC(14,2),
    -- índice de concentração de mercado
    top3_share          NUMERIC(5,4),                -- % vendas dos 3 maiores sellers
    hhi_index           NUMERIC(8,6),                -- Herfindahl-Hirschman (0-1)
    concentration_label TEXT GENERATED ALWAYS AS (
        CASE
            WHEN top3_share IS NULL THEN NULL
            WHEN top3_share >= 0.60 THEN 'concentrated'    -- difícil entrar
            WHEN top3_share >= 0.35 THEN 'moderate'
            ELSE 'fragmented'                            -- pulverizado, fácil entrar
        END) STORED,
    PRIMARY KEY (niche_id, stat_date)
);

-- ============================================================================
-- 8. CALCULADORA REVERSA DE LUCRO (Unit Economics)
-- ============================================================================

CREATE TABLE profit_simulations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id          UUID REFERENCES monitored_products(id) ON DELETE SET NULL,
    niche_id            UUID REFERENCES niches(id) ON DELETE SET NULL,
    name                TEXT,

    -- inputs
    sale_price          NUMERIC(12,2) NOT NULL,      -- preço de venda pretendido
    target_margin_pct   NUMERIC(5,2) NOT NULL,       -- margem líquida desejada (ex: 20)
    commission_pct      NUMERIC(5,2) NOT NULL,       -- comissão Shopee (ex: 14)
    freeship_pct        NUMERIC(5,2) NOT NULL,       -- programa frete grátis (ex: 6)
    fixed_fee_per_item  NUMERIC(10,2) NOT NULL,      -- taxa fixa por item (ex: 4.00)
    tax_pct             NUMERIC(5,2) NOT NULL,       -- Simples Nacional / MEI
    acos_pct            NUMERIC(5,2) NOT NULL DEFAULT 0, -- custo Ads sobre receita
    extra_cost_per_unit NUMERIC(10,2) DEFAULT 0,     -- embalagem, brinde, etc.

    -- outputs
    cmv_ceiling         NUMERIC(12,2),               -- ★ CMV TETO (máx p/ fornecedor)
    net_profit_per_unit NUMERIC(12,2),
    breakeven_price     NUMERIC(12,2),               -- preço mínimo p/ margem = 0
    viability_label     TEXT CHECK (viability_label IN
                        ('viable', 'tight', 'unviable')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_simulations_user ON profit_simulations (user_id, created_at DESC);

-- ============================================================================
-- 9. OBSERVABILIDADE DA COLETA
-- ============================================================================

CREATE TABLE crawl_jobs (
    id              BIGSERIAL PRIMARY KEY,
    job_type        TEXT NOT NULL,                   -- 'snapshot', 'reviews', 'discovery'
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','done','failed','rate_limited')),
    target          TEXT,                            -- niche_id / product_id / shop_id
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs (status, created_at);

-- ============================================================================
-- VIEWS AUXILIARES PARA O DASHBOARD
-- ============================================================================

-- Velocidade + dados do produto + loja em uma leitura só
CREATE VIEW v_product_radar AS
SELECT
    p.id                AS product_id,
    p.item_id,
    p.name,
    p.image_url,
    p.niche_id,
    n.name              AS niche_name,
    cs.shop_id,
    cs.name             AS shop_name,
    cs.location         AS shop_location,
    s.price,
    s.historical_sold,
    vm.sold_last_24h,
    vm.sold_last_7d,
    vm.sold_last_30d,
    vm.avg_daily_30d,
    vm.revenue_est_30d,
    vm.trend_label,
    vm.trend_ratio_7v30,
    vm.opportunity_score,
    ss.rating_star      AS shop_rating,
    ss.response_rate    AS shop_response_rate,
    ss.ship_prep_days   AS shop_prep_days,
    ss.is_vulnerable    AS shop_is_vulnerable
FROM monitored_products p
JOIN niches n                 ON n.id = p.niche_id
JOIN competitor_shops cs      ON cs.shop_id = p.shop_id
LEFT JOIN LATERAL (
    SELECT * FROM product_daily_snapshots s
    WHERE s.product_id = p.id
    ORDER BY s.snapshot_date DESC LIMIT 1
) s ON TRUE
LEFT JOIN product_velocity_metrics vm ON vm.product_id = p.id
LEFT JOIN LATERAL (
    SELECT * FROM shop_daily_snapshots ss
    WHERE ss.shop_id = p.shop_id
    ORDER BY ss.snapshot_date DESC LIMIT 1
) ss ON TRUE
WHERE p.monitoring;

-- ============================================================================
-- NOTA TIMESCALEDB (opcional, recomendado em produção):
--   CREATE EXTENSION timescaledb;
--   Remover PARTITION BY e rodar:
--   SELECT create_hypertable('product_daily_snapshots','snapshot_date',
--          partitioning_column => 'product_id', number_partitions => 8);
--   + política de compressão após 30 dias e retenção de 24 meses.
-- ============================================================================
