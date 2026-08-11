/**
 * SYNC + DELIVERY TESTS.
 * Sync: resumable import, overlap polling with source-time watermark, dedup.
 * Delivery: version gate, withdrawals applied per channel, grants refused
 * (NOT_SUPPORTED + alternate enforcement), never clears an opt-out.
 */

import { describe, expect, it } from "vitest";
import { SyncWorker, type CheckpointStore } from "../../src/ingestion/sync-worker.js";
import { OutreachDeliveryWorker, compareVersions, type DeliveryStore } from "../../src/delivery/outreach-writer.js";
import { FixtureSource, fixtureProspect } from "../../src/outreach/testing/fixture-source.js";
import type { ConsentPlatformPort, PartyDestinationLookup } from "../../src/platform/port.js";
import type { Channel, ConsentSignal, ConsentStateChange, DeliveryReceipt, MappingProfile } from "../../src/domain/types.js";

function mapping(channel: Channel): MappingProfile {
  return {
    mappingProfileId: "or-map-01",
    version: "1.0.0",
    orgId: "org-demo",
    channel,
    purposeCode: `SALES_OUTREACH_${channel}`,
    direction: "BIDIRECTIONAL",
  };
}

const OPTIONS = {
  tenantId: "TENANT-100",
  orgId: "org-demo",
  pageSize: 2,
  overlapMinutes: 10,
  findMapping: (c: Channel) => mapping(c),
  now: () => new Date("2026-08-10T13:00:00Z"),
};

function memoryCheckpoints(): CheckpointStore & { cursors: Map<string, string | null>; watermarks: Map<string, number> } {
  const cursors = new Map<string, string | null>();
  const watermarks = new Map<string, number>();
  return {
    cursors,
    watermarks,
    readCursor: async (job) => cursors.get(job) ?? null,
    writeCursor: async (job, cursor) => void cursors.set(job, cursor),
    readWatermark: async (job) => watermarks.get(job) ?? null,
    writeWatermark: async (job, epochMs) => void watermarks.set(job, epochMs),
  };
}

function memoryPlatform() {
  const signals: ConsentSignal[] = [];
  const quarantined: string[] = [];
  const seen = new Set<string>();
  const platform: ConsentPlatformPort = {
    resolveParty: async (input) => ({ outcome: "RESOLVED", partyId: `PARTY-${input.prospectId}` }),
    submitSignal: async (signal) => {
      if (seen.has(signal.idempotencyKey)) return { accepted: true, deduplicated: true };
      seen.add(signal.idempotencyKey);
      signals.push(signal);
      return { accepted: true, deduplicated: false };
    },
    submitQuarantine: async (input) => void quarantined.push(input.reason),
  };
  return { platform, signals, quarantined };
}

describe("historical import", () => {
  it("pages through all prospects and emits per-channel signals", async () => {
    const prospects = [
      fixtureProspect({ prospectId: "1", emailOptedOut: true, emailOptedOutAt: "2026-08-01T10:00:00Z" }),
      fixtureProspect({ prospectId: "2" }),
      fixtureProspect({ prospectId: "3", globalOptedOut: true, globalOptedOutAt: "2026-08-02T10:00:00Z" }),
    ];
    const { platform, signals } = memoryPlatform();
    const stats = await new SyncWorker(new FixtureSource(prospects, { pageSize: 2 }), platform, memoryCheckpoints(), OPTIONS).runHistoricalImport();

    expect(stats).toMatchObject({ prospectsSeen: 3, signalsSubmitted: 9, quarantined: 0 });
    expect(signals.filter((s) => s.status === "OPTED_OUT")).toHaveLength(4); // 1 email + 3 global fan-out
  });

  it("marks DONE; re-running imports nothing", async () => {
    const checkpoints = memoryCheckpoints();
    const source = new FixtureSource([fixtureProspect({ prospectId: "1" })]);
    const first = memoryPlatform();
    await new SyncWorker(source, first.platform, checkpoints, OPTIONS).runHistoricalImport();
    expect(checkpoints.cursors.get("HISTORICAL_IMPORT")).toBe("DONE");

    const second = memoryPlatform();
    const rerun = await new SyncWorker(source, second.platform, checkpoints, OPTIONS).runHistoricalImport();
    expect(rerun.prospectsSeen).toBe(0);
  });

  it("does not advance the cursor past a failing page and resumes exactly there", async () => {
    const prospects = ["1", "2", "3"].map((id) =>
      fixtureProspect({ prospectId: id, emailOptedOut: true, emailOptedOutAt: "2026-08-01T10:00:00Z" }),
    );
    const checkpoints = memoryCheckpoints();
    const base = memoryPlatform();
    let calls = 0;
    const failing: ConsentPlatformPort = {
      ...base.platform,
      submitSignal: async (signal) => {
        calls += 1;
        if (calls === 7) throw new Error("infrastructure failure"); // first signal of page 2
        return base.platform.submitSignal(signal);
      },
    };
    const source = new FixtureSource(prospects, { pageSize: 2 });

    await expect(new SyncWorker(source, failing, checkpoints, OPTIONS).runHistoricalImport()).rejects.toThrow();
    expect(checkpoints.cursors.get("HISTORICAL_IMPORT")).toBe("2");

    const resumed = memoryPlatform();
    await new SyncWorker(source, resumed.platform, checkpoints, OPTIONS).runHistoricalImport();
    expect(resumed.signals.every((s) => s.prospectId === "3")).toBe(true);
  });
});

describe("incremental poll", () => {
  it("applies overlap, dedupes re-reads, and stores max observed source time", async () => {
    const checkpoints = memoryCheckpoints();
    checkpoints.watermarks.set("INCREMENTAL_POLL", Date.parse("2026-08-10T11:00:00Z"));
    const prospects = [
      fixtureProspect({ prospectId: "old", updatedAt: "2026-08-10T10:00:00Z" }),  // before overlap → excluded
      fixtureProspect({ prospectId: "edge", updatedAt: "2026-08-10T10:55:00Z" }), // in overlap → read
      fixtureProspect({ prospectId: "new", updatedAt: "2026-08-10T12:30:00Z" }),
    ];
    const { platform } = memoryPlatform();
    const worker = new SyncWorker(new FixtureSource(prospects), platform, checkpoints, OPTIONS);

    const stats = await worker.runIncrementalPoll();
    expect(stats.prospectsSeen).toBe(2);
    expect(checkpoints.watermarks.get("INCREMENTAL_POLL")).toBe(Date.parse("2026-08-10T12:30:00Z"));

    const again = await worker.runIncrementalPoll(); // overlap re-reads → all dedupe
    expect(again.signalsSubmitted).toBe(0);
    expect(again.signalsDeduplicated).toBeGreaterThan(0);
  });
});

describe("outbound delivery", () => {
  function harness(options: { lastApplied?: number | null } = {}) {
    const writer = new FixtureSource([]);
    const receipts: DeliveryReceipt[] = [];
    const applied: number[] = [];
    const destinations: PartyDestinationLookup = {
      findProspect: async (_t, partyId) => (partyId === "PARTY-1" ? { prospectId: "42" } : null),
    };
    const store: DeliveryStore = {
      lastAppliedVersion: async () => options.lastApplied ?? null,
      recordAppliedVersion: async (c) => void applied.push(c.consentVersion),
      insertReceipt: async (r) => void receipts.push(r),
    };
    const worker = new OutreachDeliveryWorker(writer, destinations, store, "org-demo");
    return { worker, writer, receipts, applied };
  }

  function change(overrides: Partial<ConsentStateChange> = {}): ConsentStateChange {
    return {
      changeId: "CHG-1",
      tenantId: "TENANT-100",
      partyId: "PARTY-1",
      purposeCode: "SALES_OUTREACH_EMAIL",
      channel: "EMAIL",
      effectiveStatus: "WITHDRAWN",
      effectiveAt: "2026-08-10T14:00:00Z",
      consentVersion: 3,
      originSystem: "PREFERENCE_CENTER",
      correlationId: "CORR-1",
      ...overrides,
    };
  }

  it("applies a withdrawal by setting the channel opt-out", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change());
    expect(receipt.status).toBe("APPLIED");
    expect(h.writer.appliedOptOuts).toEqual([{ prospectId: "42", channels: ["EMAIL"] }]);
    expect(h.applied).toEqual([3]);
  });

  it("refuses GRANTED — never clears an opt-out; flags alternate enforcement", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change({ effectiveStatus: "GRANTED" }));
    expect(receipt.status).toBe("NOT_SUPPORTED");
    expect(receipt.requiresAlternateEnforcement).toBe(true);
    expect(h.writer.appliedOptOuts).toHaveLength(0);
  });

  it("skips stale versions without touching Outreach", async () => {
    const h = harness({ lastApplied: 5 });
    const receipt = await h.worker.deliver(change({ consentVersion: 3 }));
    expect(receipt.status).toBe("STALE_VERSION_SKIPPED");
    expect(h.writer.appliedOptOuts).toHaveLength(0);
  });

  it("acknowledges an equal version as already applied", async () => {
    const h = harness({ lastApplied: 3 });
    const receipt = await h.worker.deliver(change({ consentVersion: 3 }));
    expect(receipt.status).toBe("APPLIED");
    expect(h.writer.appliedOptOuts).toHaveLength(0);
  });

  it("returns PROSPECT_NOT_FOUND for unmapped parties", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change({ partyId: "PARTY-UNKNOWN" }));
    expect(receipt.status).toBe("PROSPECT_NOT_FOUND");
  });

  it("version comparison: newer applies, equal skips, older refuses", () => {
    expect(compareVersions(3, 2)).toBe("APPLY");
    expect(compareVersions(3, null)).toBe("APPLY");
    expect(compareVersions(3, 3)).toBe("SKIP_EQUAL");
    expect(compareVersions(2, 3)).toBe("STALE_VERSION_SKIPPED");
  });
});
