/**
 * Normalization — ProspectRecord → per-channel ConsentSignals (spec §5–§7).
 *
 * Rules encoded here:
 *  - An explicit channel opt-out (with timestamp) → OPTED_OUT signal for that
 *    channel's mapped purpose.
 *  - GRANULAR DISABLED: only the global flag is meaningful; a global opt-out
 *    fans out to EVERY mapped channel (the connector must not invent
 *    channel-level permission). Channel flags are ignored in that mode.
 *  - Not opted out → NOT_OPTED_OUT verbatim; absence is never consent — the
 *    platform records it as UNKNOWN, and clearing an opt-out never grants.
 *  - The approved custom opt-in field yields an OPTED_IN candidate ONLY with
 *    full evidence (statement hash + notice + timestamp); otherwise the
 *    caller quarantines it (OPT_IN_MISSING_EVIDENCE).
 *  - Engagement never reaches this layer: prospect records carry preference
 *    fields only; sends/opens/replies are simply not ingested.
 */

import { createHash } from "node:crypto";
import {
  ALL_CHANNELS,
  type Channel,
  type ConsentSignal,
  type MappingProfile,
  type ProspectRecord,
  type QuarantineReason,
} from "../domain/types.js";

export interface NormalizeResult {
  signals: ConsentSignal[];
  quarantined: Array<{ reason: QuarantineReason; channel: Channel | null; detail: string }>;
}

export function normalizeProspect(
  record: ProspectRecord,
  input: {
    tenantId: string;
    partyId: string | null;
    findMapping: (channel: Channel) => MappingProfile | null;
    observedAt: string;
  },
): NormalizeResult {
  const signals: ConsentSignal[] = [];
  const quarantined: NormalizeResult["quarantined"] = [];

  const channelStates: Array<{ channel: Channel; optedOut: boolean; at: string | null; fromGlobal: boolean }> =
    [];

  if (!record.granularOptOutEnabled) {
    // Global-only tenant: one flag governs every channel.
    for (const channel of ALL_CHANNELS) {
      channelStates.push({
        channel,
        optedOut: record.globalOptedOut,
        at: record.globalOptedOutAt,
        fromGlobal: true,
      });
    }
  } else {
    channelStates.push(
      { channel: "EMAIL", optedOut: record.emailOptedOut === true, at: record.emailOptedOutAt, fromGlobal: false },
      { channel: "CALL", optedOut: record.callOptedOut === true, at: record.callOptedOutAt, fromGlobal: false },
      { channel: "SMS", optedOut: record.smsOptedOut === true, at: record.smsOptedOutAt, fromGlobal: false },
    );
    // A global opt-out on a granular tenant still suppresses everything.
    if (record.globalOptedOut) {
      for (const state of channelStates) {
        if (!state.optedOut) {
          state.optedOut = true;
          state.at = record.globalOptedOutAt;
          state.fromGlobal = true;
        }
      }
    }
  }

  for (const state of channelStates) {
    const mapping = input.findMapping(state.channel);
    if (!mapping) {
      // Unmapped channels flow with purposeCode null only when restrictive —
      // an unmapped opt-out is still worth surfacing; unmapped neutral is noise.
      if (state.optedOut) {
        quarantined.push({ reason: "UNKNOWN_MAPPING", channel: state.channel, detail: "opt-out on unmapped channel" });
      }
      continue;
    }

    const status = state.optedOut ? "OPTED_OUT" : "NOT_OPTED_OUT";
    const effectiveAt = state.optedOut ? (state.at ?? record.updatedAt) : record.updatedAt;

    signals.push(buildSignal(record, input, {
      status,
      channel: state.channel,
      purposeCode: mapping.purposeCode,
      mapping,
      fromGlobalOptOut: state.fromGlobal && state.optedOut,
      evidence: null,
      effectiveAt,
    }));
  }

  // Explicit opt-in candidate from the approved custom field.
  const optIn = record.optInField;
  if (optIn && isAffirmative(optIn.value)) {
    const mapping = input.findMapping("EMAIL");
    if (!mapping) {
      quarantined.push({ reason: "UNKNOWN_MAPPING", channel: "EMAIL", detail: "opt-in field with no EMAIL mapping" });
    } else if (!optIn.statementHash || !optIn.noticeId || !optIn.noticeVersion || !optIn.capturedAt) {
      // §6: a grant requires statement, notice, and timestamp — else quarantine.
      quarantined.push({
        reason: "OPT_IN_MISSING_EVIDENCE",
        channel: "EMAIL",
        detail: `field ${optIn.fieldName} affirmative but evidence incomplete`,
      });
    } else {
      signals.push(buildSignal(record, input, {
        status: "OPTED_IN",
        channel: "EMAIL",
        purposeCode: mapping.purposeCode,
        mapping,
        fromGlobalOptOut: false,
        evidence: {
          statementHash: optIn.statementHash,
          noticeId: optIn.noticeId,
          noticeVersion: optIn.noticeVersion,
        },
        effectiveAt: optIn.capturedAt,
      }));
    }
  }

  return { signals, quarantined };
}

function buildSignal(
  record: ProspectRecord,
  input: { tenantId: string; partyId: string | null; observedAt: string },
  fields: {
    status: ConsentSignal["status"];
    channel: Channel;
    purposeCode: string;
    mapping: MappingProfile;
    fromGlobalOptOut: boolean;
    evidence: ConsentSignal["evidence"];
    effectiveAt: string;
  },
): ConsentSignal {
  return {
    tenantId: input.tenantId,
    partyId: input.partyId,
    prospectId: record.prospectId,
    emailNormalized: record.emailNormalized,
    status: fields.status,
    channel: fields.channel,
    purposeCode: fields.purposeCode,
    fromGlobalOptOut: fields.fromGlobalOptOut,
    source: {
      system: "OUTREACH",
      orgId: record.orgId,
      objectType: fields.status === "OPTED_IN" ? "CUSTOM_OPT_IN_FIELD" : "PROSPECT",
      objectId: record.prospectId,
    },
    mapping: { mappingProfileId: fields.mapping.mappingProfileId, version: fields.mapping.version },
    evidence: fields.evidence,
    effectiveAt: fields.effectiveAt,
    observedAt: input.observedAt,
    idempotencyKey: buildSignalIdempotencyKey({
      orgId: record.orgId,
      prospectId: record.prospectId,
      channel: fields.channel,
      status: fields.status,
      effectiveAt: fields.effectiveAt,
    }),
    payloadHash: record.payloadHash,
  };
}

function isAffirmative(value: string | null): boolean {
  if (!value) return false;
  return ["YES", "TRUE", "CHECKED", "ACCEPTED", "AGREE"].includes(value.trim().toUpperCase());
}

/** Deterministic — same fact, same key; a status flip produces a new key. */
export function buildSignalIdempotencyKey(input: {
  orgId: string;
  prospectId: string;
  channel: string;
  status: string;
  effectiveAt: string;
}): string {
  const material = ["OUTREACH", input.orgId, input.prospectId, input.channel, input.status, input.effectiveAt].join(":");
  return "sig-" + createHash("sha256").update(material).digest("hex");
}
