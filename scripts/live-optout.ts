/**
 * Live writeback test: read one prospect's consent flags, then apply an
 * opt-out through the production writer (ProspectsApi.applyOptOut) and
 * re-read to verify. WITHDRAWALS ONLY — this can never clear a flag.
 *
 * Run: PROSPECT_ID=3 CHANNELS=EMAIL npm run live:optout
 * DRY_RUN=true to only read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OAuthTokenProvider, type OAuthCredentialStore, type OAuthTokenExchanger } from "../src/auth/token-service.js";
import { OutreachClient, type FetchLike } from "../src/outreach/client.js";
import { ProspectsApi } from "../src/outreach/prospects-api.js";
import type { Channel, ProspectRecord } from "../src/domain/types.js";

const TOKENS_FILE = fileURLToPath(new URL("../.outreach-tokens.json", import.meta.url));

interface TokenFile {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadTokens(): TokenFile {
  return JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as TokenFile;
}

const fileStore: OAuthCredentialStore = {
  async readRefreshToken() {
    return loadTokens().refreshToken;
  },
  async writeTokens(_id, accessToken, refreshToken, expiresAt) {
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
    if (response.status === 400 || response.status === 401) return null;
    if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
    const json = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in };
  },
};

function printStatus(label: string, r: ProspectRecord) {
  console.log(`${label}: #${r.prospectId} ${r.firstName ?? ""} ${r.lastName ?? ""} <${r.emailNormalized ?? "no-email"}>`);
  console.log(`   global: ${r.globalOptedOut} (${r.globalOptedOutAt ?? "-"})`);
  console.log(`   email:  ${r.emailOptedOut} (${r.emailOptedOutAt ?? "-"})`);
  console.log(`   call:   ${r.callOptedOut} (${r.callOptedOutAt ?? "-"})`);
  console.log(`   sms:    ${r.smsOptedOut} (${r.smsOptedOutAt ?? "-"})`);
}

async function main() {
  const prospectId = process.env["PROSPECT_ID"];
  if (!prospectId) throw new Error("Set PROSPECT_ID");
  const channels = (process.env["CHANNELS"] ?? "EMAIL").split(",") as Channel[];
  const dryRun = process.env["DRY_RUN"] === "true";

  const tokens = new OAuthTokenProvider("outreach-live", fileStore, exchanger);
  const client = new OutreachClient(fetch as unknown as FetchLike, tokens);
  const api = new ProspectsApi(client, { orgId: "org-live", granularOptOutEnabled: true, optInFieldName: null });

  const before = await api.fetchProspect(prospectId);
  if (!before) throw new Error(`Prospect ${prospectId} not found`);
  printStatus("BEFORE", before);

  if (dryRun) return;

  console.log(`\nApplying opt-out for channels: ${channels.join(", ")} ...`);
  await api.applyOptOut(prospectId, channels);

  const after = await api.fetchProspect(prospectId);
  console.log("");
  printStatus("AFTER ", after!);
  console.log("\n✓ Writeback applied.");
}

main().catch((error) => {
  console.error("✗ Failed:", error);
  process.exit(1);
});
