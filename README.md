# Outreach Consent Connector

Bidirectional Outreach connector for an **existing** consent management
platform — third member of the connector family, same operating model and
platform-port contract as `../HubSpot-consent-connector` and
`../HighSpot-Consent-connector`:

```text
Outreach (inbound) → Consent DB / Preference Center → Downstream (Outreach)
```

Source spec: `Outreach-Sentinel-Consent-Connector-Architecture-API-Specification.md`
(in this folder).

## Outreach's consent shape — and how this connector handles it

| Reality | Consequence in this codebase |
|---|---|
| Prospects carry **channel-specific opt-outs** (email / call / SMS + global, each with timestamps) | The normalizer emits one signal per mapped channel. Opt-outs are reliable withdrawals; `NOT_OPTED_OUT` passes through verbatim and the platform records it as UNKNOWN — absence is never consent. |
| **Granular opt-out is a tenant setting.** When disabled, only the global flag is meaningful | Global-only tenants: channel flags are ignored; a global opt-out fans out to every mapped channel (the connector must not invent channel-level permission). Granular tenants: a global opt-out still suppresses everything, marked `fromGlobalOptOut`. |
| Explicit opt-ins exist only via an **approved, versioned custom field** | An affirmative value with full evidence (statement hash + notice + timestamp) becomes an `OPTED_IN` candidate; anything less quarantines as `OPT_IN_MISSING_EVIDENCE`. Engagement (sends, opens, replies, sequences) is never ingested. |
| **Clearing an opt-out is never renewed consent** (spec §6 rule 4) | Outbound delivery applies WITHDRAWALS by setting opt-out flags, and refuses GRANTED changes with `NOT_SUPPORTED` + `requiresAlternateEnforcement` — re-permission is a human/CRM process, not a bit-flip. The grant stays effective in the consent DB. |
| JSON:API + OAuth with **rotating refresh tokens** | `OAuthTokenProvider` persists the new refresh token on every exchange (Outreach invalidates the old one); JSON:API `links.next` is the pagination cursor; `filter[updatedAt]` + overlap window drives incremental polling. |

## Try it (no Outreach credentials needed)

```bash
npm install
npm run typecheck && npm test    # 20 unit tests
npm run demo                     # closed loop on a fixture org
```

The demo imports five fixture prospects (channel opt-out, global opt-out,
clean, evidenced opt-in, unevidenced opt-in → quarantine), performs a
preference-center withdrawal (delivered as a channel opt-out) and a grant
(refused `NOT_SUPPORTED`), and persists everything in `.consent-db.json`.

## Modules

| Area | Module |
|---|---|
| OAuth (rotating refresh tokens, fail closed) | `src/auth/token-service.ts` |
| JSON:API client (401 refresh, 429/backoff, redaction) | `src/outreach/client.ts` |
| Prospect resource + ports (`ProspectSource`, `PreferenceWriter`) | `src/outreach/prospects-api.ts` |
| Fixture source (tests/demo) | `src/outreach/testing/fixture-source.ts` |
| Normalizer (channel rules, global fan-out, opt-in evidence gate) | `src/ingestion/normalizer.ts` |
| Historical import + overlap polling | `src/ingestion/sync-worker.ts` |
| Delivery worker (withdrawals only; version gate) | `src/delivery/outreach-writer.ts` |
| Platform boundary | `src/platform/port.ts` |
| Demo consent DB (file-backed) | `src/platform/testing/file-consent-db.ts` |
| Connector-owned schema | `database/migrations/001_init.sql` |

## Going live

1. Create the Outreach OAuth app; scope to prospect read (+ write only when
   outbound opt-out enforcement is approved). Wire `OAuthCredentialStore` to
   your secrets manager — remember the refresh token ROTATES per exchange.
2. Confirm the tenant's granular opt-out setting and set
   `granularOptOutEnabled` accordingly (it changes both normalization and
   writeback shape).
3. If the tenant has an approved opt-in custom field, configure its name and
   evidence-companion fields; leave null otherwise (opt-ins then never occur).
4. Approve channel → purpose mapping profiles per org.
5. Wire `ConsentPlatformPort` to your real consent DB; replace in-memory
   checkpoints with `database/migrations/001_init.sql`.
6. Optional: webhooks for lower latency (spec §8) — polling + reconciliation
   remain the reliability net either way.

## Connector invariants

- Engagement is never consent; ambiguous opt-in values produce nothing.
- A grant candidate requires statement + notice + timestamp evidence or it
  quarantines; opt-outs are accepted with lighter evidence (restrictive is the
  safe direction).
- Global opt-out always wins for every mapped channel; granular-disabled
  tenants never yield channel-level permission.
- Idempotency keys are deterministic per (org, prospect, channel, status,
  time); overlap re-reads and restarts never duplicate ledger events.
- Checkpoints advance only after every prospect is accepted, deduplicated, or
  durably quarantined; watermarks store max observed SOURCE time.
- A stale `consentVersion` is never written downstream.
- The connector never clears an opt-out — GRANTED deliveries are refused with
  `NOT_SUPPORTED` and routed to an approved human/CRM process.
