-- Qualification app for the SDK test stack. Runs after 01-schema.sql, which
-- already carries the plan rows (including the mandatory `free` plan).
--
-- The signing secret below is the AES-256-GCM encryption of the plaintext
-- "js-ci-signing-secret" under APP_SECRET "celeris-ci-app-secret", in the
-- server's storage format: base64(salt16 || nonce12 || ciphertext || tag16)
-- with a PBKDF2-HMAC-SHA256 (100k iterations, 32-byte) key. Both values are
-- test-only; regenerate with .ci/README.md's recipe if APP_SECRET changes.

INSERT INTO accounts (id, alias, name, email, password, status)
VALUES (
    900100,
    'sdk-ci-account',
    'SDK CI Account',
    'sdk-ci@celeris.test',
    'placeholder',
    'active'::account_status
)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO apps (id, name, description, client_id, signing_secret, account_id, status)
VALUES (
    900100,
    'SDK CI App',
    'Qualification app for the JavaScript SDK test suites',
    'js-ci',
    'a1LTkrvOrBMGP5UPSPCVy/V5VnoZxAahP6p63Hy8A9G+dcqONXTXv/ikkzAyPdjGs99Q3jvh/mF0hHIVNYh1WA==',
    900100,
    'active'::app_status
)
ON CONFLICT (id) DO UPDATE SET
    client_id = EXCLUDED.client_id,
    signing_secret = EXCLUDED.signing_secret,
    account_id = EXCLUDED.account_id,
    status = EXCLUDED.status;

-- Headroom above the free plan so a qualification run is never throttled.
INSERT INTO plans (
    slug, title, description,
    connection_rate_limit_per_second, connection_message_rate_limit_per_second,
    message_rate_limit_per_second, message_rate_limit_per_month,
    concurrent_connection_limit, concurrent_channel_limit,
    features, status
)
VALUES (
    'sdk-ci-plan', 'SDK CI Plan', 'Generous limits for SDK qualification runs',
    100000, 100000, 100000, 1000000000, 10000, 10000,
    '[]'::json, 'active'::plan_status
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO plan_prices (id, title, plan_slug, billing_mode, cost_in_cents, currency)
VALUES (900100, 'SDK CI Price', 'sdk-ci-plan', 'indefinite'::billing_mode, 0, 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (
    id, account_id, plan_price_id, provider_id, status, usage_period_starts_at
)
VALUES (
    900100, 900100, 900100, 'sdk-ci-subscription',
    'active'::subscription_status,
    now() - interval '2 minutes'
)
ON CONFLICT (id) DO UPDATE SET
    plan_price_id = EXCLUDED.plan_price_id,
    status = EXCLUDED.status,
    usage_period_starts_at = EXCLUDED.usage_period_starts_at;
