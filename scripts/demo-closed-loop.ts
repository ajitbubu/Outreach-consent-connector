/**
 * Closed-loop demo — the operating model on a fixture Outreach org (no real
 * credentials needed):
 *
 *   Outreach (inbound) → Consent DB → Preference Center → Downstream (Outreach)
 *
 * Fixture org covers the consent states that matter: a channel-specific email
 * opt-out, a global opt-out fanned across channels, a clean prospect, an
 * evidenced explicit opt-in, and an under-evidenced opt-in that quarantines.
 * Stage ③ delivers a preference-center withdrawal (applied as a channel
 * opt-out) and a grant (refused NOT_SUPPORTED — opt-outs are never cleared).
 *
 * Run: npm run demo        (state persists in .consent-db.json; delete to reset)
 */

import { SyncWorker, type CheckpointStore } from "../src/ingestion/sync-worker.js";
import { OutreachDeliveryWorker } from "../src/delivery/outreach-writer.js";
import { FixtureSource, fixtureProspect } from "../src/outreach/testing/fixture-source.js";
import { FileConsentDb } from "../src/platform/testing/file-consent-db.js";
import type { Channel, MappingProfile } from "../src/domain/types.js";

const DB_FILE = new URL("../.consent-db.json", import.meta.url);

const MAPPINGS: Record<Channel, MappingProfile> = {
  EMAIL: mapping("EMAIL", "SALES_OUTREACH_EMAIL"),
  CALL: mapping("CALL", "SALES_OUTREACH_CALL"),
  SMS: mapping("SMS", "SALES_OUTREACH_SMS"),
};

function mapping(channel: Channel, purposeCode: string): MappingProfile {
  return {
    mappingProfileId: "or-map-01",
    version: "1.0.0",
    orgId: "org-demo",
    channel,
    purposeCode,
    direction: "BIDIRECTIONAL",
  };
}

const FIXTURE_PROSPECTS = [
  fixtureProspect({
    prospectId: "1001",
    emailNormalized: "ada.emailout@example.com",
    firstName: "Ada",
    lastName: "Emailout",
    emailOptedOut: true,
    emailOptedOutAt: "2026-08-08T09:00:00Z",
  }),
  fixtureProspect({
    prospectId: "1002",
    emailNormalized: "bruno.globalout@example.com",
    firstName: "Bruno",
    lastName: "Globalout",
    globalOptedOut: true,
    globalOptedOutAt: "2026-08-08T09:30:00Z",
  }),
  fixtureProspect({
    prospectId: "1003",
    emailNormalized: "cleo.clean@example.com",
    firstName: "Cleo",
    lastName: "Clean",
  }),
  fixtureProspect({
    prospectId: "1004",
    emailNormalized: "dara.optin@example.com",
    firstName: "Dara",
    lastName: "Optin",
    optInField: {
      fieldName: "custom12",
      value: "YES",
      statementHash: "sha256:stmt-demo",
      noticeId: "privacy-notice",
      noticeVersion: "2.0",
      capturedAt: "2026-08-09T11:00:00Z",
    },
  }),
  fixtureProspect({
    prospectId: "1005",
    emailNormalized: "evan.noevidence@example.com",
    firstName: "Evan",
    lastName: "Noevidence",
    optInField: {
      fieldName: "custom12",
      value: "YES",
      statementHash: null, // affirmative but unevidenced → must quarantine
      noticeId: null,
      noticeVersion: null,
      capturedAt: null,
    },
  }),
];

function memoryCheckpoints(): CheckpointStore {
  const cursors = new Map<string, string | null>();
  const watermarks = new Map<string, number>();
  return {
    readCursor: async (job) => cursors.get(job) ?? null,
    writeCursor: async (job, cursor) => void cursors.set(job, cursor),
    readWatermark: async (job) => watermarks.get(job) ?? null,
    writeWatermark: async (job, epochMs) => void watermarks.set(job, epochMs),
  };
}

async function main(): Promise<void> {
  const consentDb = new FileConsentDb(DB_FILE);

  console.log("① Outreach (inbound) → Consent DB");
  const source = new FixtureSource(FIXTURE_PROSPECTS, { pageSize: 2 });
  const stats = await new SyncWorker(source, consentDb, memoryCheckpoints(), {
    tenantId: "TENANT-DEMO",
    orgId: "org-demo",
    pageSize: 2,
    overlapMinutes: 10,
    findMapping: (c) => MAPPINGS[c] ?? null,
  }).runHistoricalImport();

  console.log(
    `   ${stats.prospectsSeen} prospects → ${stats.signalsSubmitted} signals, ` +
      `${stats.quarantined} quarantined, ${stats.signalsDeduplicated} deduplicated`,
  );
  for (const q of consentDb.snapshot().quarantine) {
    console.log(`   ⚠ quarantined: ${q.reason} (${q.sourceRef})`);
  }
  const withdrawn = consentDb.snapshot().events.filter((e) => e.derivedStatus === "WITHDRAWN");
  const granted = consentDb.snapshot().events.filter((e) => e.derivedStatus === "GRANTED");
  console.log(`   derived: ${withdrawn.length} WITHDRAWN (1 email + 3 global fan-out), ${granted.length} GRANTED (evidenced opt-in)`);

  console.log("\n② Preference Center: Cleo withdraws SALES_OUTREACH_EMAIL");
  const cleo = consentDb.findPartyByEmail("cleo.clean@example.com");
  if (!cleo) throw new Error("Cleo not found — stage ① must run first");
  const withdrawal = consentDb.recordPreferenceCenterChange({
    partyId: cleo.partyId,
    purposeCode: "SALES_OUTREACH_EMAIL",
    channel: "EMAIL",
    status: "WITHDRAWN",
    actor: "DATA_PRINCIPAL",
    noticeVersion: "demo-notice-v1",
  });
  console.log(`   event v${withdrawal.consentVersion} appended (${withdrawal.correlationId})`);

  console.log("\n③ Downstream (Outreach): deliver the withdrawal");
  const worker = new OutreachDeliveryWorker(source, consentDb, consentDb, "org-demo");
  const receiptA = await worker.deliver(withdrawal);
  console.log(
    `   receipt: ${receiptA.status} → prospect ${receiptA.destinationProspectId} ` +
      `(opt-out set: ${JSON.stringify(source.appliedOptOuts[0])})`,
  );

  console.log("\n   And a GRANTED change — must be refused, never clears an opt-out:");
  const dara = consentDb.findPartyByEmail("dara.optin@example.com")!;
  const grant = consentDb.recordPreferenceCenterChange({
    partyId: dara.partyId,
    purposeCode: "SALES_OUTREACH_EMAIL",
    channel: "EMAIL",
    status: "GRANTED",
    actor: "DATA_PRINCIPAL",
    noticeVersion: "demo-notice-v1",
  });
  const receiptB = await worker.deliver(grant);
  console.log(`   receipt: ${receiptB.status}${receiptB.requiresAlternateEnforcement ? " → route via approved human/CRM process" : ""}`);
  console.log(`   detail: ${receiptB.detail}`);

  const db = consentDb.snapshot();
  console.log(
    `\nConsent DB: ${Object.keys(db.parties).length} parties · ${db.events.length} events · ` +
      `${db.quarantine.length} quarantined · ${db.receipts.length} receipts (.consent-db.json)`,
  );
  console.log("Withdrawals enforce; grants stay effective in the consent DB and route to a human process — same rule family as the HubSpot and Highspot connectors.");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
