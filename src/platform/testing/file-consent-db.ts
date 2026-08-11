/**
 * File-backed consent DB — persistent demo implementation of the platform side
 * (your real consent platform replaces this behind the same port). Same shape
 * family as the HubSpot/Highspot demo DBs: parties, append-only events with
 * evidence, quarantine, receipts, applied versions in .consent-db.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  Channel,
  ConsentSignal,
  ConsentStateChange,
  DeliveryReceipt,
  QuarantineReason,
} from "../../domain/types.js";
import type {
  ConsentPlatformPort,
  PartyDestinationLookup,
  PartyResolution,
  SignalAck,
} from "../port.js";
import type { DeliveryStore } from "../../delivery/outreach-writer.js";

export type EffectiveStatus = "GRANTED" | "WITHDRAWN" | "UNKNOWN";

export interface ConsentDbEvent {
  eventId: string;
  partyId: string;
  purposeCode: string | null;
  channel: string;
  status: string;
  derivedStatus: EffectiveStatus;
  origin: "OUTREACH" | "PREFERENCE_CENTER";
  consentVersion: number;
  effectiveAt: string;
  recordedAt: string;
  evidence: Record<string, string | boolean | null>;
}

export interface ConsentDbParty {
  partyId: string;
  tenantId: string;
  orgId: string;
  prospectId: string;
  emailNormalized: string | null;
  displayName: string | null;
}

interface DbShape {
  parties: Record<string, ConsentDbParty>;
  events: ConsentDbEvent[];
  quarantine: Array<{ quarantineId: string; reason: QuarantineReason; channel: string | null; detail: string; sourceRef: string; recordedAt: string }>;
  receipts: DeliveryReceipt[];
  appliedVersions: Record<string, number>;
  seenSignalKeys: string[];
}

const EMPTY: DbShape = { parties: {}, events: [], quarantine: [], receipts: [], appliedVersions: {}, seenSignalKeys: [] };

export class FileConsentDb implements ConsentPlatformPort, PartyDestinationLookup, DeliveryStore {
  private db: DbShape;

  constructor(private readonly filePath: URL) {
    try {
      this.db = { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(filePath, "utf8")) as DbShape) };
    } catch {
      this.db = structuredClone(EMPTY);
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.db, null, 2));
  }

  async resolveParty(input: {
    tenantId: string;
    orgId: string;
    prospectId: string;
    emailNormalized: string | null;
    firstName: string | null;
    lastName: string | null;
  }): Promise<PartyResolution> {
    const key = `${input.orgId}|${input.prospectId}`;
    let party = Object.values(this.db.parties).find((p) => `${p.orgId}|${p.prospectId}` === key);
    if (!party) {
      party = {
        partyId: `PARTY-${Object.keys(this.db.parties).length + 1}`,
        tenantId: input.tenantId,
        orgId: input.orgId,
        prospectId: input.prospectId,
        emailNormalized: input.emailNormalized,
        displayName: [input.firstName, input.lastName].filter(Boolean).join(" ") || null,
      };
      this.db.parties[party.partyId] = party;
      this.save();
    }
    return { outcome: "RESOLVED", partyId: party.partyId };
  }

  async submitSignal(signal: ConsentSignal): Promise<SignalAck> {
    if (this.db.seenSignalKeys.includes(signal.idempotencyKey)) {
      return { accepted: true, deduplicated: true };
    }
    this.db.seenSignalKeys.push(signal.idempotencyKey);

    // Demo policy: OPTED_OUT → WITHDRAWN (explicit restrictive action);
    // OPTED_IN (full evidence, pre-screened by the normalizer) → GRANTED;
    // NOT_OPTED_OUT → UNKNOWN (absence is never consent).
    const derivedStatus: EffectiveStatus =
      signal.status === "OPTED_OUT" ? "WITHDRAWN" : signal.status === "OPTED_IN" ? "GRANTED" : "UNKNOWN";

    this.appendEvent({
      partyId: signal.partyId ?? "UNRESOLVED",
      purposeCode: signal.purposeCode,
      channel: signal.channel,
      status: signal.status,
      derivedStatus,
      origin: "OUTREACH",
      effectiveAt: signal.effectiveAt,
      evidence: {
        method: signal.status === "OPTED_IN" ? "OUTREACH_CUSTOM_OPT_IN_FIELD" : "OUTREACH_PROSPECT_PREFERENCE",
        fromGlobalOptOut: signal.fromGlobalOptOut,
        statementHash: signal.evidence?.statementHash ?? null,
        noticeId: signal.evidence?.noticeId ?? null,
        noticeVersion: signal.evidence?.noticeVersion ?? null,
        sourceRef: `outreach:${signal.source.orgId}:${signal.source.objectType}:${signal.source.objectId}`,
        payloadHash: signal.payloadHash,
        idempotencyKey: signal.idempotencyKey,
      },
    });
    return { accepted: true, deduplicated: false };
  }

  async submitQuarantine(input: {
    tenantId: string;
    reason: QuarantineReason;
    channel: Channel | null;
    detail: string;
    sourceRef: string;
  }): Promise<void> {
    this.db.quarantine.push({
      quarantineId: randomUUID(),
      reason: input.reason,
      channel: input.channel,
      detail: input.detail,
      sourceRef: input.sourceRef,
      recordedAt: new Date().toISOString(),
    });
    this.save();
  }

  recordPreferenceCenterChange(input: {
    partyId: string;
    purposeCode: string;
    channel: Channel;
    status: "GRANTED" | "WITHDRAWN";
    actor: string;
    noticeVersion: string;
  }): ConsentStateChange {
    const party = this.db.parties[input.partyId];
    if (!party) throw new Error(`Unknown party ${input.partyId}`);
    const event = this.appendEvent({
      partyId: input.partyId,
      purposeCode: input.purposeCode,
      channel: input.channel,
      status: input.status,
      derivedStatus: input.status,
      origin: "PREFERENCE_CENTER",
      effectiveAt: new Date().toISOString(),
      evidence: { method: "PREFERENCE_CENTER_ACTION", actor: input.actor, noticeVersion: input.noticeVersion },
    });
    return {
      changeId: `CHG-${event.eventId}`,
      tenantId: party.tenantId,
      partyId: input.partyId,
      purposeCode: input.purposeCode,
      channel: input.channel,
      effectiveStatus: input.status,
      effectiveAt: event.effectiveAt,
      consentVersion: event.consentVersion,
      originSystem: "PREFERENCE_CENTER",
      correlationId: `CORR-${event.eventId.slice(0, 8)}`,
    };
  }

  private appendEvent(input: Omit<ConsentDbEvent, "eventId" | "consentVersion" | "recordedAt">): ConsentDbEvent {
    const event: ConsentDbEvent = {
      ...input,
      eventId: randomUUID(),
      consentVersion: this.db.events.filter((e) => e.partyId === input.partyId).length + 1,
      recordedAt: new Date().toISOString(),
    };
    this.db.events.push(event);
    this.save();
    return event;
  }

  async findProspect(_tenantId: string, partyId: string, orgId: string): Promise<{ prospectId: string } | null> {
    const party = this.db.parties[partyId];
    if (!party || party.orgId !== orgId) return null;
    return { prospectId: party.prospectId };
  }

  async lastAppliedVersion(change: ConsentStateChange, orgId: string): Promise<number | null> {
    return this.db.appliedVersions[versionKey(change, orgId)] ?? null;
  }

  async recordAppliedVersion(change: ConsentStateChange, orgId: string): Promise<void> {
    this.db.appliedVersions[versionKey(change, orgId)] = change.consentVersion;
    this.save();
  }

  async insertReceipt(receipt: DeliveryReceipt): Promise<void> {
    this.db.receipts.push(receipt);
    this.save();
  }

  snapshot(): Readonly<DbShape> {
    return this.db;
  }

  findPartyByEmail(email: string): ConsentDbParty | null {
    const normalized = email.trim().toLowerCase();
    return Object.values(this.db.parties).find((p) => p.emailNormalized === normalized) ?? null;
  }
}

function versionKey(change: ConsentStateChange, orgId: string): string {
  return [change.tenantId, orgId, change.partyId, change.purposeCode, change.channel].join("|");
}
