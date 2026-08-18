/**
 * READ-ONLY live smoke test against a real Outreach org.
 *
 * Exercises the production wiring end to end: OAuthTokenProvider (rotating
 * refresh tokens persisted back to .outreach-tokens.json) → OutreachClient
 * (JSON:API, 401 refresh, backoff) → ProspectsApi.fetchPage → normalizer.
 * Never PATCHes anything.
 *
 * Prereq: npm run live:oauth (once). Then: npm run live:smoke
 *
 * Env knobs:
 *   OUTREACH_GRANULAR=true|false   tenant granular opt-out setting (default true)
 *   OUTREACH_OPTIN_FIELD=custom12  approved opt-in custom field (default none)
 *   OUTREACH_PAGE_SIZE=25
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OAuthTokenProvider, type OAuthCredentialStore, type OAuthTokenExchanger } from "../src/auth/token-service.js";
import { OutreachClient, type FetchLike } from "../src/outreach/client.js";
import { ProspectsApi } from "../src/outreach/prospects-api.js";
import { normalizeProspect } from "../src/ingestion/normalizer.js";
import type { Channel, MappingProfile } from "../src/domain/types.js";

const TOKENS_FILE = fileURLToPath(new URL("../.outreach-tokens.json", import.meta.url));

interface TokenFile {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadTokens(): TokenFile {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as TokenFile;
  } catch {
    console.error("No .outreach-tokens.json — run `npm run live:oauth` first.");
    process.exit(1);
  }
}

const fileStore: OAuthCredentialStore = {
  async readRefreshToken() {
    return loadTokens().refreshToken;
  },
  async writeTokens(_connectorId, accessToken, refreshToken, expiresAt) {
    // Outreach rotates the refresh token on every exchange — persist immediately.
    writeFileSync(TOKENS_FILE, JSON.stringify({ ...loadTokens(), accessToken, refreshToken, expiresAt }, null, 2));
  },
};

const exchanger: OAuthTokenExchanger = {
  async exchangeRefreshToken(refreshToken) {
    const { clientId, clientSecret } = loadTokens();
    const response = await fetch("https://api.outreach.io/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (response.status === 400 || response.status === 401) return null; // revoked
    if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
    const json = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in };
  },
};

const MAPPINGS: Record<Channel, MappingProfile> = {
  EMAIL: mapping("EMAIL", "SALES_OUTREACH_EMAIL"),
  CALL: mapping("CALL", "SALES_OUTREACH_CALL"),
  SMS: mapping("SMS", "SALES_OUTREACH_SMS"),
};

function mapping(channel: Channel, purposeCode: string): MappingProfile {
  return {
    mappingProfileId: "or-map-live",
    version: "1.0.0",
    orgId: "org-live",
    channel,
    purposeCode,
    direction: "BIDIRECTIONAL",
  };
}

async function main() {
  const granular = process.env["OUTREACH_GRANULAR"] !== "false";
  const optInFieldName = process.env["OUTREACH_OPTIN_FIELD"] ?? null;
  const pageSize = Number(process.env["OUTREACH_PAGE_SIZE"] ?? 25);

  const tokens = new OAuthTokenProvider("outreach-live", fileStore, exchanger);
  const client = new OutreachClient(fetch as unknown as FetchLike, tokens);
  const api = new ProspectsApi(client, { orgId: "org-live", granularOptOutEnabled: granular, optInFieldName });

  console.log(`Fetching up to ${pageSize} prospects (granular=${granular}, optInField=${optInFieldName ?? "none"})...\n`);
  const page = await api.fetchPage(undefined, null, pageSize);

  let signals = 0;
  let quarantined = 0;
  for (const record of page.prospects) {
    const flags = [
      record.globalOptedOut ? "GLOBAL-OPTOUT" : null,
      record.emailOptedOut ? "email-optout" : null,
      record.callOptedOut ? "call-optout" : null,
      record.smsOptedOut ? "sms-optout" : null,
    ].filter(Boolean);
    const result = normalizeProspect(record, {
      tenantId: "tenant-live",
      partyId: null,
      findMapping: (channel) => MAPPINGS[channel],
      observedAt: new Date().toISOString(),
    });
    signals += result.signals.length;
    quarantined += result.quarantined.length;

    const derived = result.signals.map((s) => `${s.channel}:${s.status}${s.fromGlobalOptOut ? "(global)" : ""}`);
    console.log(
      `  #${record.prospectId} ${record.firstName ?? ""} ${record.lastName ?? ""}`.trimEnd() +
        ` <${record.emailNormalized ?? "no-email"}>` +
        (flags.length ? ` [${flags.join(", ")}]` : "") +
        `\n     → ${derived.join(", ") || "no signals"}` +
        (result.quarantined.length ? ` | quarantined: ${result.quarantined.map((q) => q.reason).join(", ")}` : ""),
    );
  }

  console.log(`\n✓ Live smoke passed: ${page.prospects.length} prospects → ${signals} signals, ${quarantined} quarantined`);
  console.log(`  nextCursor: ${page.nextCursor ?? "none (last page)"}`);
  console.log("  (read-only: no opt-outs were written)");
}

main().catch((error) => {
  console.error("✗ Live smoke failed:", error);
  process.exit(1);
});
