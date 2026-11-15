# Durable storage

The calling backend uses MongoDB for assistants, tools, phone assignments, calls, usage, costs and trace records; Redis for live call context, admission limits and retryable jobs; and private S3-compatible object storage for recordings, transcripts and call logs. Cloudflare R2 is the production object-store target. MinIO uses the same S3 adapter during development. Meetings are outside this storage migration.

## Local setup

1. Use Node.js 24 or newer. Run `npm ci`.
2. If `.env` does not exist, copy `.env.example` to `.env`.
3. Generate a 32-byte encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set `CREDENTIAL_ENCRYPTION_KEY`. Retain it securely; changing it without re-encrypting saved credentials makes them unreadable.
4. Run `docker compose up -d --build`. MongoDB, Redis and MinIO health checks should pass. Then run `npm run storage:init` to create the private development bucket. The first MinIO build downloads Go dependencies and can take several minutes.
5. Run `npm run dev`. The application runs outside Compose and uses the localhost URLs in `.env.example`.

Compose binds services to loopback and persists data in named volumes. `docker compose down` retains data. Do not use `docker compose down -v` unless intentionally deleting development data. The example credentials are development-only; this Compose file is not a production deployment. The MinIO community binary/image distribution has been retired, so the development image builds a fixed upstream source revision. MinIO is AGPL-3.0; the source URL and license are included in `infra/minio/Dockerfile`. Keep this development service local; production uses R2. MongoDB runs standalone locally; deploy a replica set or managed cluster for production availability and majority-acknowledged writes. Redis must use `noeviction`; eviction can destroy locks and queued jobs.

## Cloudflare R2

Create a private bucket and a bucket-scoped API token with object read/write access. Set:

```dotenv
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=YOUR_PRIVATE_BUCKET
S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY
S3_SECRET_ACCESS_KEY=YOUR_SECRET_KEY
S3_FORCE_PATH_STYLE=false
```

Configure `MONGODB_URI`, `MONGODB_DATABASE`, `REDIS_URL` and `CREDENTIAL_ENCRYPTION_KEY` using your deployment secret manager. Use TLS and authenticated connections in production. All backend replicas must use the same database, Redis namespace, object bucket, encryption key and stream-signing secret. Never put database or object-store credentials in `NEXT_PUBLIC_*` variables. Objects remain private; application downloads use expiring signed links. The public webhook service does not expose arbitrary object keys or credential management.

A provider recording is an external artifact until successfully copied to the configured bucket. Inspect its processing status and retry failed jobs; do not delete the provider recording before the object upload completes. Set your bucket lifecycle, database backup and retention policies explicitly according to your needs. No automatic archival deletion policy is enabled by default.

## Import existing local data

Stop the old backend before importing, and retain a backup of the entire `DATA_DIR`, including the old `.credentials.key` if saved Twilio credentials exist. Configure the new storage environment, then run:

```sh
npm run storage:migrate -- /absolute/path/to/old/.data
```

The script reads `assistants.json`, `tools.json`, `calls.json`, `costs.jsonl`, `pricing.json`, the rotated `logs/voice-agent.jsonl` files and encrypted Twilio credentials. It never changes or deletes source files. It creates indexes and imports stable IDs with insert-only writes; rerunning it preserves existing destination configuration and credentials. Conflicting unique tool names or invalid source records stop the import. Correct the conflict and rerun; already imported records remain valid.

Legacy unfinished calls are marked failed because old media sockets cannot be resumed. Existing call records and available cost-ledger entries are preserved. A separate `legacy_cost_ledger` collection retains ledger entries for calls omitted by the previous 200-call history cap. Original provider usage cannot be reconstructed if it was never stored. Transcripts can only be recovered from retained transcript diagnostic events and may contain the old log truncation; migration does not invent missing words or token counts. Legacy meeting files, browser login state and warm-transfer runtime state are not imported. Finish transfers before migrating.

The migration does not retroactively fetch provider recordings or upload historical artifacts. Imported transcript and log documents remain queryable in MongoDB. New completed calls use the durable artifact-export workflow.

## Data and cost semantics

MongoDB stores one call document and separate append-only transcript/event documents, avoiding a growing transcript inside the call's BSON document. Config lookups and paginated history use indexes. Redis context binding and consumption are atomic, with expiry. Queue retries must be safe to repeat; artifact keys and event IDs provide stable deduplication identities.

`RECORDING_ENABLED=false` is the default; enable it only when your recording-consent and retention settings are ready. `CALLS_PER_MINUTE` configures Redis-backed call admission rate limits, and `MAX_CONCURRENT_CALLS` limits active calls. `REDIS_PREFIX` isolates the deployment namespace.

Call metadata retains the existing dashboard fields and adds assistant identity, call type, timestamps, artifact references, structured usage, cost lines and a cost breakdown. LLM usage records prompt, cached and completion tokens by provider/model; transcription records billed audio duration; synthesis records generated characters; telephony records duration and reported provider price when available. Costs include individual provider and infrastructure components. Unknown rates or missing provider usage are explicitly identified. An estimate or known subtotal is not a final provider invoice, and provider-reported prices can arrive after the call ends. Transport defaults are estimates; configure destination/account-specific rates and optional recording/conference rates to match your provider contract. Pricing overrides are stored in MongoDB `billing_pricing` with `_id: "default"` and a `rates` object; legacy `pricing.json` is imported once. New runtime calls read the shared card instead of a worker-local file.

## Operating limits

Shared storage allows multiple workers to query the same history and coordinate contexts. A live media WebSocket and its speech engine still belong to one process. Scale media workers with connection draining and suitable routing; shared storage cannot move an already-open media stream after a worker crash. Warm-transfer coordination and credential-change admission need the documented routing/operational restrictions until all associated runtime state is distributed. The admin API remains a single-workspace, loopback service; this change does not add authentication or customer billing isolation.

Monitor MongoDB latency and pool saturation, Redis memory/persistence and queue failures, object upload failures and billing completeness. Back up MongoDB plus the credential encryption key separately and test restoration. Avoid logging connection strings, provider secrets or signed object URLs.

## Verification and recovery

```sh
npm run typecheck -- --incremental false
npm run build
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 TEST_REDIS_URL=redis://127.0.0.1:6379 npm exec -- tsx --test tests/storage-*.test.ts tests/redis-storage.test.ts tests/billing.test.ts
```

Integration tests create isolated databases/Redis namespaces and remove their own fixtures. Keep provider credentials out of test environments. Object-store integration tests use a dedicated test bucket or temporary keys.

Terminal call writes set a durable `storagePending` flag in MongoDB. A bounded dispatcher retries queue delivery after restart; jobs use deterministic IDs and retained failures. Provider reconciliation retries with exponential delay for roughly 18 hours. After correcting a persistent service or pricing problem, `POST /api/calls/:sid/storage/retry` on the loopback admin API retries that completed call's billing and artifact export. Recording jobs retain their separate failure records in the queue; retry the failed recording job after correcting the provider download or storage error.

Call events/transcripts are queued for ordered Mongo writes, and usage counters checkpoint at most once per second plus explicit flushes. Graceful shutdown drains writes; an abrupt process kill can lose the final unflushed interval. This is not a provider invoice or a guarantee of zero-loss media under process failure. Failed writes are retained for retry with a bounded backlog. Warm-transfer coordination currently requires one voice coordinator and callback affinity; Mongo snapshots provide restart recovery but do not provide distributed coordinator ownership. Meetings keep their existing local persistence.
