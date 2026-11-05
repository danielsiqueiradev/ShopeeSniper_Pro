-- ============================================================================
-- Migration 011 — limpeza de sold_30_days poluído (segunda onda)
--
-- A 008 anulou sold_30_days quando ≈ historical_sold (≥90%). Mas
-- snapshots sem historical_sold escaparam: o campo 30d carrega a
-- venda VITALÍCIA (números redondos tipo 50.000). Sintoma: a
-- Oportunidades mostrava itens "MONITOR" com 50k vendas — a régua
-- rejeita certo, mas o número engana na tela.
--
-- Heurística: sold_30_days > 2000 é quase sempre lifetime (a tese
-- trava em 300/mês; incumbentes reais de 2k+ são raríssimos e mesmo
-- assim o valor continua útil zerado depois). Para não destruir
-- dados, guardamos o valor em historical_sold quando ele for NULL.
-- Idempotente. Rode no SQL Editor.
-- ============================================================================

UPDATE product_daily_snapshots
SET    historical_sold = COALESCE(historical_sold, sold_30_days),
       sold_30_days = NULL
WHERE  sold_30_days > 2000;
