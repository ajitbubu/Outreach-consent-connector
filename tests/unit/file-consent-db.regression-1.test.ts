// Regression: ISSUE-001 — quarantine was not idempotent: every poll cycle
// re-quarantined the same stuck record (same sourceRef + reason), flooding
// the review queue (~288 duplicates/day at a 5-minute poll).
// Found by /qa on 2026-08-11
// Report: .gstack/qa-reports/qa-report-outreach-consent-connector-2026-08-11.md

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FileConsentDb } from "../../src/platform/testing/file-consent-db.js";

function freshDb(): FileConsentDb {
  const dir = mkdtempSync(join(tmpdir(), "or-consent-db-"));
  return new FileConsentDb(pathToFileURL(join(dir, "consent-db.json")));
}

const STUCK_RECORD = {
  tenantId: "TENANT-100",
  reason: "OPT_IN_MISSING_EVIDENCE" as const,
  channel: "EMAIL" as const,
  detail: "field custom12 affirmative but evidence incomplete",
  sourceRef: "outreach:org-demo:PROSPECT:1005",
};

describe("quarantine idempotency (ISSUE-001)", () => {
  it("re-submitting the same stuck record does not duplicate the queue entry", async () => {
    const db = freshDb();
    // Simulates three poll cycles re-observing the same unevidenced opt-in.
    await db.submitQuarantine(STUCK_RECORD);
    await db.submitQuarantine(STUCK_RECORD);
    await db.submitQuarantine(STUCK_RECORD);
    expect(db.snapshot().quarantine).toHaveLength(1);
  });

  it("a different reason for the same source is a NEW queue entry, not a dup", async () => {
    const db = freshDb();
    await db.submitQuarantine(STUCK_RECORD);
    await db.submitQuarantine({ ...STUCK_RECORD, reason: "UNKNOWN_MAPPING", detail: "opt-out on unmapped channel" });
    expect(db.snapshot().quarantine).toHaveLength(2);
  });

  it("a different source with the same reason is a NEW queue entry, not a dup", async () => {
    const db = freshDb();
    await db.submitQuarantine(STUCK_RECORD);
    await db.submitQuarantine({ ...STUCK_RECORD, sourceRef: "outreach:org-demo:PROSPECT:1006" });
    expect(db.snapshot().quarantine).toHaveLength(2);
  });
});
