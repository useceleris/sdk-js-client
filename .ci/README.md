# CI test stack

A traffic-shaped Celeris stack for the `test:celeris` suites: two realtime
nodes behind the real HAProxy entrypoint (with its discovery sidecar), Kafka,
Redis, Postgres and ClickHouse. Tests connect to the entrypoint, so they take
the path production clients take. Every Celeris image is pulled prebuilt from
GHCR — nothing here builds from source.

```sh
docker compose -f .ci/compose.yaml up -d --wait
CELERIS_WS_URL=ws://localhost:19001 \
CELERIS_CLIENT_ID=js-ci \
CELERIS_SIGNING_SECRET=js-ci-signing-secret \
  npm run test:celeris
docker compose -f .ci/compose.yaml down -v
```

The sibling `@useceleris/server` package points at the same stack with the
same three variables.

## Knobs

| Variable                  | Default                                           | Use                                        |
| ------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `CELERIS_REALTIME_IMAGE`  | `ghcr.io/useceleris/celeris-realtime:main`        | Pin a tag or digest, or a local image      |
| `CELERIS_SIDECAR_IMAGE`   | `ghcr.io/useceleris/celeris-haproxy-sidecar:main` | Same, for the sidecar                      |
| `CELERIS_ENTRYPOINT_PORT` | `19001`                                           | Move the entrypoint when the port is taken |

## Image notes

- **Registry authentication is required**, and a stale local copy is the
  trap: `docker pull` failures fall back to whatever is already cached. An
  image predating server-assigned message ids fails every delivery test with
  `ProtocolError: Server message is missing its identifier` — that is the
  SDK's REV-01 rejection working correctly, not a client defect. If you see
  it, `docker login ghcr.io` and re-pull before looking anywhere else.
- **The realtime image publishes `linux/arm64` only** (its release workflow
  has `linux/amd64` commented out), so the live CI job runs on an arm64
  runner. Adding amd64 to that workflow would let the stack run on x86
  runners too.

Verified locally 2026-09-22 against an image built from realtime `b826574`:
both packages' suites pass in full.

## Seeded credentials

`seed.sql` creates account/app `900100` with client id `js-ci` and signing
secret `js-ci-signing-secret`, plus a generous plan so a run is never
throttled. The stored signing secret is AES-256-GCM encrypted under
`APP_SECRET` (`celeris-ci-app-secret`) in the server's format —
`base64(salt16 ‖ nonce12 ‖ ciphertext ‖ tag16)` with a PBKDF2-HMAC-SHA256
(100 000 iterations, 32-byte) key. All values are test-only. Regenerate the
stored secret after changing `APP_SECRET` or the plaintext:

```sh
node -e '
const c = require("node:crypto");
const [secret, plaintext] = ["celeris-ci-app-secret", "js-ci-signing-secret"];
const salt = c.randomBytes(16), nonce = c.randomBytes(12);
const key = c.pbkdf2Sync(secret, salt, 100000, 32, "sha256");
const ci = c.createCipheriv("aes-256-gcm", key, nonce);
const ct = Buffer.concat([ci.update(plaintext, "utf8"), ci.final()]);
console.log(Buffer.concat([salt, nonce, ct, ci.getAuthTag()]).toString("base64"));'
```

`postgres-schema.sql` and `clickhouse-schema.sql` are copies of the schema
dumps in `celeris-realtime/.infra/tests/seed/`; refresh them from there when
the service's schema changes.
