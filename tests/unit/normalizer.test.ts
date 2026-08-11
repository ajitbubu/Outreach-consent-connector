/**
 * NORMALIZATION TESTS — the spec's channel-preference rules.
 * Channel opt-outs become per-channel withdrawals; global opt-out fans out;
 * granular-disabled tenants use only the global flag; absence is never
 * consent; opt-ins need full evidence or they quarantine.
 */

import { describe, expect, it } from "vitest";
import { normalizeProspect, buildSignalIdempotencyKey } from "../../src/ingestion/normalizer.js";
import { fixtureProspect } from "../../src/outreach/testing/fixture-source.js";
import type { Channel, MappingProfile } from "../../src/domain/types.js";

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

const context = {
  tenantId: "TENANT-100",
  partyId: "PARTY-1",
  findMapping: (channel: Channel) => MAPPINGS[channel] ?? null,
  observedAt: "2026-08-10T13:00:00Z",
};

describe("channel opt-outs (granular enabled)", () => {
  it("an email opt-out becomes OPTED_OUT for the email purpose only", () => {
    const result = normalizeProspect(
      fixtureProspect({ prospectId: "p1", emailOptedOut: true, emailOptedOutAt: "2026-08-01T10:00:00Z" }),
      context,
    );
    const byChannel = Object.fromEntries(result.signals.map((s) => [s.channel, s.status]));
    expect(byChannel).toEqual({ EMAIL: "OPTED_OUT", CALL: "NOT_OPTED_OUT", SMS: "NOT_OPTED_OUT" });
    const email = result.signals.find((s) => s.channel === "EMAIL")!;
    expect(email.effectiveAt).toBe("2026-08-01T10:00:00Z"); // opt-out timestamp, not updatedAt
    expect(email.purposeCode).toBe("SALES_OUTREACH_EMAIL");
    expect(email.fromGlobalOptOut).toBe(false);
  });

  it("a global opt-out on a granular tenant suppresses every channel, marked fromGlobalOptOut", () => {
    const result = normalizeProspect(
      fixtureProspect({ prospectId: "p2", globalOptedOut: true, globalOptedOutAt: "2026-08-02T10:00:00Z" }),
      context,
    );
    expect(result.signals.every((s) => s.status === "OPTED_OUT")).toBe(true);
    expect(result.signals.every((s) => s.fromGlobalOptOut)).toBe(true);
    expect(result.signals).toHaveLength(3);
  });

  it("a channel-specific opt-out keeps its own timestamp when global also set", () => {
    const result = normalizeProspect(
      fixtureProspect({
        prospectId: "p3",
        emailOptedOut: true,
        emailOptedOutAt: "2026-08-01T10:00:00Z",
        globalOptedOut: true,
        globalOptedOutAt: "2026-08-03T10:00:00Z",
      }),
      context,
    );
    const email = result.signals.find((s) => s.channel === "EMAIL")!;
    expect(email.effectiveAt).toBe("2026-08-01T10:00:00Z");
    expect(email.fromGlobalOptOut).toBe(false); // explicitly opted out itself
    const call = result.signals.find((s) => s.channel === "CALL")!;
    expect(call.fromGlobalOptOut).toBe(true);
  });
});

describe("granular disabled — the connector must not invent channel permission", () => {
  it("only the global flag is meaningful; channel flags are ignored", () => {
    const result = normalizeProspect(
      fixtureProspect({
        prospectId: "p4",
        granularOptOutEnabled: false,
        globalOptedOut: false,
        // Stale channel flags that must NOT produce withdrawals in global mode:
        emailOptedOut: true,
        emailOptedOutAt: "2026-08-01T10:00:00Z",
      }),
      context,
    );
    expect(result.signals.every((s) => s.status === "NOT_OPTED_OUT")).toBe(true);
  });

  it("a global opt-out suppresses all three mapped channels", () => {
    const result = normalizeProspect(
      fixtureProspect({
        prospectId: "p5",
        granularOptOutEnabled: false,
        globalOptedOut: true,
        globalOptedOutAt: "2026-08-04T10:00:00Z",
      }),
      context,
    );
    expect(result.signals.filter((s) => s.status === "OPTED_OUT")).toHaveLength(3);
    expect(result.signals.every((s) => s.fromGlobalOptOut)).toBe(true);
  });
});

describe("explicit opt-in via approved custom field", () => {
  const fullEvidence = {
    fieldName: "custom12",
    value: "YES",
    statementHash: "sha256:stmt",
    noticeId: "privacy-notice",
    noticeVersion: "2.0",
    capturedAt: "2026-08-05T10:00:00Z",
  };

  it("a fully-evidenced affirmative opt-in becomes OPTED_IN with evidence attached", () => {
    const result = normalizeProspect(
      fixtureProspect({ prospectId: "p6", optInField: fullEvidence }),
      context,
    );
    const optIn = result.signals.find((s) => s.status === "OPTED_IN")!;
    expect(optIn).toBeDefined();
    expect(optIn.evidence).toEqual({ statementHash: "sha256:stmt", noticeId: "privacy-notice", noticeVersion: "2.0" });
    expect(optIn.effectiveAt).toBe("2026-08-05T10:00:00Z");
    expect(optIn.source.objectType).toBe("CUSTOM_OPT_IN_FIELD");
  });

  it("an affirmative value WITHOUT evidence quarantines — never a grant", () => {
    const result = normalizeProspect(
      fixtureProspect({
        prospectId: "p7",
        optInField: { ...fullEvidence, statementHash: null },
      }),
      context,
    );
    expect(result.signals.some((s) => s.status === "OPTED_IN")).toBe(false);
    expect(result.quarantined).toContainEqual(
      expect.objectContaining({ reason: "OPT_IN_MISSING_EVIDENCE" }),
    );
  });

  it("a non-affirmative value produces nothing — absence is never consent", () => {
    const result = normalizeProspect(
      fixtureProspect({ prospectId: "p8", optInField: { ...fullEvidence, value: "maybe" } }),
      context,
    );
    expect(result.signals.some((s) => s.status === "OPTED_IN")).toBe(false);
    expect(result.quarantined).toHaveLength(0);
  });
});

describe("mapping and idempotency", () => {
  it("an opt-out on an unmapped channel quarantines instead of vanishing", () => {
    const noSms = { ...context, findMapping: (c: Channel) => (c === "SMS" ? null : MAPPINGS[c]) };
    const result = normalizeProspect(
      fixtureProspect({ prospectId: "p9", smsOptedOut: true, smsOptedOutAt: "2026-08-06T10:00:00Z" }),
      noSms,
    );
    expect(result.quarantined).toContainEqual(
      expect.objectContaining({ reason: "UNKNOWN_MAPPING", channel: "SMS" }),
    );
  });

  it("keys are deterministic per fact and change when the status flips", () => {
    const base = { orgId: "org-demo", prospectId: "p1", channel: "EMAIL", status: "OPTED_OUT", effectiveAt: "t1" };
    expect(buildSignalIdempotencyKey(base)).toBe(buildSignalIdempotencyKey({ ...base }));
    expect(buildSignalIdempotencyKey(base)).not.toBe(
      buildSignalIdempotencyKey({ ...base, status: "NOT_OPTED_OUT" }),
    );
  });
});
