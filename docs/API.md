# API Reference — Outreach Consent Connector

Two API surfaces meet in this connector:

1. **Outreach API v2** (vendor side) — JSON:API over HTTPS, what the
   connector calls.
2. **Platform ports** (your consent platform side) — the TypeScript contracts
   the connector calls inbound and consumes outbound.

Every Outreach call goes through `OutreachClient` (`src/outreach/client.ts`);
endpoint construction lives in `ProspectsApi` (`src/outreach/prospects-api.ts`).

---

## Authentication — OAuth 2.0 with rotating refresh tokens

| Step | Endpoint |
|---|---|
| Authorize (browser) | `GET https://api.outreach.io/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=prospects.read` |
| Code → tokens | `POST https://api.outreach.io/oauth/token` (`grant_type=authorization_code`) |
| Refresh | `POST https://api.outreach.io/oauth/token` (`grant_type=refresh_token`) |

**Outreach ROTATES the refresh token on every exchange** — the old one is
invalidated immediately. `OAuthTokenProvider` (`src/auth/token-service.ts`)
persists both tokens via `OAuthCredentialStore` on every refresh; losing the
new refresh token means re-authorization. Access tokens are cached and
refreshed 60 s before expiry, or on 401 (once, then fail closed with
`AuthorizationRequiredError`).

Scopes: `prospects.read` for inbound sync; prospect **write** scope
(`prospects.all`) is required only for outbound opt-out enforcement.

---

## Common HTTP behavior (all Outreach calls)

| Aspect | Behavior |
|---|---|
| Base URL | `https://api.outreach.io/api/v2` (overridable via `OutreachClientOptions.baseUrl`) |
| Media type | `Accept: application/vnd.api+json`; same `Content-Type` on writes (JSON:API) |
| Auth | `Authorization: Bearer <access token>` from `AccessTokenProvider` |
| 401 | Refresh token once, retry; second 401 fails closed (`AuthorizationRequiredError` surfaces from the provider). |
| 429 / 500 / 502 / 503 / 504 | Retried up to 4 times; honors `Retry-After` (seconds), else jittered exponential backoff `min(30s, 500ms·2^attempt)·(0.5–1.0)`. |
| Other non-2xx | `OutreachApiError{status, retryable:false}`; error text is email-redacted and truncated to 300 chars. |

---

## Inbound — Outreach → Consent Platform

### 1. Page prospects (historical import + incremental poll)

```
GET /prospects
      ?filter[updatedAt]=<ISO-8601>..inf     ← omitted on historical import
      &sort=updatedAt
      &page[size]=<pageSize>
```

Response (JSON:API page shape):

```json
{
  "data": [
    {
      "type": "prospect",
      "id": 3,
      "attributes": {
        "firstName": "Ajit",
        "lastName": "Sahu",
        "emails": ["ajit.sahu@example.com"],
        "optedOut": false,
        "optedOutAt": null,
        "emailOptedOut": false,
        "emailOptedOutAt": null,
        "callOptedOut": false,
        "callOptedOutAt": null,
        "smsOptedOut": false,
        "smsOptedOutAt": null,
        "updatedAt": "2026-08-17T15:10:00.000Z"
      }
    }
  ],
  "links": { "next": "https://api.outreach.io/api/v2/prospects?page[…]" },
  "meta": { "count": 1 }
}
```

Paging: `links.next` is the opaque cursor (base URL stripped, path reused
verbatim); absent `links.next` means last page. The incremental-poll
watermark is the max observed `updatedAt` minus an overlap window
(configured in `SyncOptions.overlapMinutes`); overlap duplicates are
absorbed by idempotency keys, never re-recorded. Checkpoints
(`CheckpointStore`) advance only after every prospect in a page is accepted,
deduplicated, or durably quarantined.

### 2. Read one prospect (tooling / spot checks)

```
GET /prospects/{id}
```

`404` → `null` (not an error).

### What the connector derives from a prospect

| Outreach attribute | Channel | Meaning |
|---|---|---|
| `emailOptedOut` / `emailOptedOutAt` | EMAIL | `true` → OPTED_OUT; `false` → NOT_OPTED_OUT (recorded as UNKNOWN — absence is never consent) |
| `callOptedOut` / `callOptedOutAt` | CALL | same |
| `smsOptedOut` / `smsOptedOutAt` | SMS | same |
| `optedOut` / `optedOutAt` | global | `true` fans OPTED_OUT out to every mapped channel (`fromGlobalOptOut=true` on channels whose own flag was not set) |
| approved custom field (e.g. `custom12`) | EMAIL | opt-in claim; affirmative value (`YES`/`TRUE`/`CHECKED`/`ACCEPTED`/`AGREE`) with full evidence → OPTED_IN, else quarantine |
| `<field>_statement_hash` / `<field>_notice_id` / `<field>_notice_version` / `<field>_captured_at` | — | evidence companions; all four required for a grant candidate |

**Tenant granular setting** (`ProspectSourceOptions.granularOptOutEnabled`):
when `false`, channel flags are IGNORED — only the global flag is meaningful
and it fans out to every mapped channel (the connector never invents
channel-level permission). When `true`, channel flags are read individually
and a global opt-out still suppresses everything.

Engagement data (sends, opens, clicks, replies, sequence enrollment) is
**never** read or ingested.

### 3. Signal submitted to the platform (`ConsentPlatformPort.submitSignal`)

One `ConsentSignal` per mapped channel:

```jsonc
{
  "tenantId": "tenant-live",
  "partyId": null,                          // null when unresolved
  "prospectId": "3",
  "emailNormalized": "ajit.sahu@example.com",
  "status": "OPTED_OUT",                    // OPTED_OUT | NOT_OPTED_OUT | OPTED_IN
  "channel": "EMAIL",                       // EMAIL | CALL | SMS
  "purposeCode": "SALES_OUTREACH_EMAIL",
  "fromGlobalOptOut": false,                // true when a global opt-out fanned out
  "source": {
    "system": "OUTREACH",
    "orgId": "org-live",
    "objectType": "PROSPECT",               // CUSTOM_OPT_IN_FIELD for opt-ins
    "objectId": "3"
  },
  "mapping": { "mappingProfileId": "or-map-live", "version": "1.0.0" },
  "evidence": null,                         // only OPTED_IN carries {statementHash, noticeId, noticeVersion}
  "effectiveAt": "2026-08-17T15:10:00.000Z",  // opt-out timestamp; opt-ins use captured_at; neutral uses updatedAt
  "observedAt": "2026-08-17T15:12:00.000Z",
  "idempotencyKey": "sig-<sha256 of OUTREACH:org:prospect:channel:status:effectiveAt>",
  "payloadHash": "sha256:<hash of raw JSON:API resource>"
}
```

Quarantine (`submitQuarantine`) instead of a signal when:
`OPT_IN_MISSING_EVIDENCE` (affirmative opt-in without all four evidence
fields), `UNKNOWN_MAPPING` (opt-out on an unmapped channel, or opt-in with
no EMAIL mapping), `MISSING_TIMESTAMP`. Quarantine is idempotent on
(sourceRef, reason) across poll cycles.

---

## Outbound — Consent Platform → Outreach

### Input: `ConsentStateChange` (from your platform)

```jsonc
{
  "changeId": "CHG-…",
  "tenantId": "tenant-live",
  "partyId": "PARTY-3",
  "purposeCode": "SALES_OUTREACH_EMAIL",
  "channel": "EMAIL",
  "effectiveStatus": "WITHDRAWN",           // GRANTED | WITHDRAWN | SUPPRESSED
  "effectiveAt": "2026-08-17T16:07:40.000Z",
  "consentVersion": 3,                      // monotonic gate — stale versions never written
  "originSystem": "PREFERENCE_CENTER",
  "correlationId": "CORR-…"
}
```

The party is resolved to an Outreach prospect via
`PartyDestinationLookup.findProspect`.

### The write — one PATCH per delivery (withdrawals ONLY)

```
PATCH /prospects/{id}
Content-Type: application/vnd.api+json
```

| Change | Body attributes |
|---|---|
| WITHDRAWN / SUPPRESSED, granular tenant | `{"emailOptedOut": true}` / `{"callOptedOut": true}` / `{"smsOptedOut": true}` per channel |
| WITHDRAWN / SUPPRESSED, global-only tenant | `{"optedOut": true}` |
| GRANTED | **never written** — receipted `NOT_SUPPORTED` with `requiresAlternateEnforcement: true` |

Full body shape:

```json
{ "data": { "type": "prospect", "id": 3, "attributes": { "emailOptedOut": true } } }
```

**Clearing an opt-out is never renewed consent** (spec §6 rule 4): the
connector sets opt-out flags but never clears one. A GRANTED change stays
effective in the consent DB; re-permission in Outreach is an approved
human/CRM process, not a bit-flip.

### Output: `DeliveryReceipt`

```jsonc
{
  "deliveryId": "DEL-<uuid>",
  "changeId": "CHG-…",
  "destinationSystem": "OUTREACH",
  "destinationOrgId": "org-live",
  "destinationProspectId": "3",
  "consentVersion": 3,
  "status": "APPLIED",
  "attemptCount": 1,
  "deliveredAt": "2026-08-17T16:07:40.324Z",   // only on APPLIED
  // on a GRANTED change:
  "detail": "grants are not written to Outreach; opt-out clearing requires an approved human/CRM process",
  "requiresAlternateEnforcement": true
}
```

| Status | When |
|---|---|
| `APPLIED` | PATCH succeeded (or same version already applied — idempotent) |
| `STALE_VERSION_SKIPPED` | `consentVersion` < last applied for the (tenant, org, party, purpose) — no write |
| `NOT_SUPPORTED` | GRANTED change → alternate enforcement required |
| `PROSPECT_NOT_FOUND` | party has no Outreach destination, or PATCH returned 404 |
| `RETRYABLE_FAILURE` | 429/5xx after retries exhausted, or transport error |
| `PERMANENT_FAILURE` | other 4xx |

---

## Platform ports (consumer contracts)

| Port | Module | Role |
|---|---|---|
| `ProspectSource` / `PreferenceWriter` | `src/outreach/prospects-api.ts` | vendor-side seams; `ProspectsApi` implements both over the real API, fixtures over test data |
| `ConsentPlatformPort` | `src/platform/port.ts` | inbound: `submitSignal` / `submitQuarantine` (idempotent) |
| `PartyDestinationLookup` | `src/platform/port.ts` | outbound: party → prospect resolution |
| `CheckpointStore` | `src/ingestion/sync-worker.ts` | cursors + watermarks (SQL schema: `database/migrations/001_init.sql`) |
| `OAuthCredentialStore` | `src/auth/token-service.ts` | rotating refresh-token persistence (wire to a secrets manager) |

---

## Live test scripts (developer org)

| Script | Command | What it does |
|---|---|---|
| `scripts/live-oauth.ts` | `npm run live:oauth` | One-time OAuth bootstrap: opens the authorize URL, catches the redirect on `localhost:8123` (HTTP, or HTTPS with `OUTREACH_REDIRECT_URI` + `TLS_CERT`/`TLS_KEY` for a self-signed cert), exchanges the code, saves tokens to `.outreach-tokens.json` (gitignored). Env: `OUTREACH_CLIENT_ID`, `OUTREACH_CLIENT_SECRET`, optional `OUTREACH_REDIRECT_URI`, `OUTREACH_SCOPES`. |
| `scripts/live-smoke.ts` | `npm run live:smoke` | **Read-only** end-to-end: token refresh → `GET /prospects` page → normalizer; prints per-prospect flags and derived signals. Env: `OUTREACH_GRANULAR`, `OUTREACH_OPTIN_FIELD`, `OUTREACH_PAGE_SIZE`. |
| `scripts/live-optout.ts` | `PROSPECT_ID=<id> CHANNELS=EMAIL npx tsx scripts/live-optout.ts` | Writeback test: reads the prospect, applies an opt-out via `ProspectsApi.applyOptOut`, re-reads to verify. `DRY_RUN=true` for the read only. Requires a write scope on the OAuth app. |
| `scripts/demo-closed-loop.ts` | `npm run demo` | Fixture closed loop, no credentials needed (state in `.consent-db.json`). |
