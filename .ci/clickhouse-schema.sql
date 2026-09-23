-- Celeris ClickHouse schema for the e2e stack.
--
-- Combined from the celeris-backend `clickhouse_migration` crate (the realtime
-- app has no ClickHouse migrations of its own; it WRITES the three base metrics
-- tables below — active_connection_metrics, active_channel_metrics,
-- message_increase_metrics — and the *_1m tables + materialized views are the
-- aggregation rollups). Re-derive from `celeris-backend/clickhouse_migration/src/*`
-- if that schema changes.
--
-- Loaded at container init via /docker-entrypoint-initdb.d. All objects are
-- qualified with the `celeris` database (init scripts do not reliably carry a
-- `USE` across statements).

CREATE DATABASE IF NOT EXISTS celeris;

-- ── messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS celeris.message_increase_metrics (
    instance_id String,
    app_id UInt64,
    account_id UInt64,
    increase_count UInt64,
    billable_count UInt64,
    byte_size UInt64,
    direction LowCardinality(String),
    timestamp DateTime64(3, 'UTC')
) ENGINE = MergeTree()
ORDER BY (account_id, app_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS celeris.message_increase_metrics_1m (
    account_id UInt64,
    app_id UInt64,
    increase_count UInt64,
    billable_count UInt64,
    byte_size UInt64,
    direction LowCardinality(String),
    minute DateTime64(3, 'UTC')
) ENGINE = SummingMergeTree()
ORDER BY (account_id, app_id, direction, minute)
PARTITION BY toYYYYMM(minute)
TTL minute + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS celeris.mv_message_increase_metrics_1m
    TO celeris.message_increase_metrics_1m
AS
SELECT
    account_id,
    app_id,
    direction,
    sum(increase_count) AS increase_count,
    sum(billable_count) AS billable_count,
    sum(byte_size) AS byte_size,
    toStartOfMinute(timestamp) AS minute
FROM celeris.message_increase_metrics
GROUP BY account_id, app_id, direction, minute;

-- ── connections ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS celeris.active_connection_metrics (
    instance_id String,
    app_id UInt64,
    account_id UInt64,
    count UInt64,
    timestamp DateTime64(3, 'UTC')
) ENGINE = MergeTree()
ORDER BY (account_id, app_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS celeris.active_connection_metrics_1m (
    app_id UInt64,
    account_id UInt64,
    instance_id LowCardinality(String),
    avg_count AggregateFunction(avg, Float64),
    minute DateTime64(3, 'UTC')
) ENGINE = AggregatingMergeTree()
ORDER BY (account_id, app_id, instance_id, minute)
PARTITION BY toYYYYMM(minute)
TTL minute + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS celeris.mv_active_connection_metrics_1m
    TO celeris.active_connection_metrics_1m
AS
SELECT
    app_id,
    account_id,
    instance_id,
    avgState(toFloat64(count)) AS avg_count,
    toStartOfMinute(timestamp) AS minute
FROM celeris.active_connection_metrics
GROUP BY account_id, app_id, instance_id, minute;

-- ── channels ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS celeris.active_channel_metrics (
    instance_id String,
    app_id UInt64,
    account_id UInt64,
    count UInt64,
    global_count UInt64,
    timestamp DateTime64(3, 'UTC')
) ENGINE = MergeTree()
ORDER BY (account_id, app_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS celeris.active_channel_metrics_1m (
    app_id UInt64,
    account_id UInt64,
    instance_id LowCardinality(String),
    global_count AggregateFunction(avg, Float64),
    count AggregateFunction(avg, Float64),
    minute DateTime64(3, 'UTC')
) ENGINE = AggregatingMergeTree()
ORDER BY (account_id, app_id, instance_id, minute)
PARTITION BY toYYYYMM(minute)
TTL minute + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS celeris.mv_active_channel_metrics_1m
    TO celeris.active_channel_metrics_1m
AS
SELECT
    app_id,
    account_id,
    instance_id,
    avgState(toFloat64(global_count)) AS global_count,
    avgState(toFloat64(count)) AS count,
    toStartOfMinute(timestamp) AS minute
FROM celeris.active_channel_metrics
GROUP BY account_id, app_id, instance_id, minute;
