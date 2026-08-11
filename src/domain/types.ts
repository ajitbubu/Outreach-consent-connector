/**
 * Canonical domain types — Outreach connector.
 *
 * Outreach's consent surface (per the spec):
 *  - Prospects carry CHANNEL-SPECIFIC opt-outs (email / call / SMS) plus a
 *    global opt-out; each with timestamps. Opt-outs are reliable withdrawal
 *    signals. Engagement (sends, opens, clicks, replies, sequence enrollment)
 *    is NEVER consent.
 *  - When granular opt-out is DISABLED in the tenant, a global opt-out must
 *    suppress every configured channel — the connector must not invent
 *    channel-level permission.
 *  - Explicit opt-ins exist only via approved, versioned custom fields with
 *    full evidence; clearing an opt-out is never renewed consent.
 */

export type Channel = "EMAIL" | "CALL" | "SMS";
export const ALL_CHANNELS: readonly Channel[] = ["EMAIL", "CALL", "SMS"];

/** Verbatim per-channel state observed on the prospect. Absence is never consent. */
export type SignalStatus = "OPTED_OUT" | "NOT_OPTED_OUT" | "OPTED_IN";

/** Source key: Outreach org + resource type + prospect ID. Email is never a key. */
export interface SourceRef {
  system: "OUTREACH";
  orgId: string;
  objectType: "PROSPECT" | "CUSTOM_OPT_IN_FIELD";
  objectId: string;
  eventId?: string;
}

/** Minimized prospect snapshot as the API layer returns it. */
export interface ProspectRecord {
  prospectId: string;
  orgId: string;
  emailNormalized: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Tenant setting: when false, only the global opt-out is meaningful. */
  granularOptOutEnabled: boolean;
  globalOptedOut: boolean;
  globalOptedOutAt: string | null;
  emailOptedOut: boolean | null;
  emailOptedOutAt: string | null;
  callOptedOut: boolean | null;
  callOptedOutAt: string | null;
  smsOptedOut: boolean | null;
  smsOptedOutAt: string | null;
  /** Approved, versioned custom opt-in field (null when tenant has none). */
  optInField: {
    fieldName: string;
    value: string | null;
    statementHash: string | null;
    noticeId: string | null;
    noticeVersion: string | null;
    capturedAt: string | null;
  } | null;
  updatedAt: string;
  payloadHash: string;
}

/** Channel → purpose mapping (versioned, tenant-approved). */
export interface MappingProfile {
  mappingProfileId: string;
  version: string;
  orgId: string;
  channel: Channel;
  purposeCode: string;
  direction: "INBOUND" | "OUTBOUND" | "BIDIRECTIONAL";
}

/** Inbound payload for the platform; connector asserts facts, platform judges. */
export interface ConsentSignal {
  tenantId: string;
  partyId: string | null;
  prospectId: string;
  emailNormalized: string | null;
  status: SignalStatus;
  channel: Channel;
  purposeCode: string | null;
  /** True when this withdrawal came from a global opt-out fanned out per channel. */
  fromGlobalOptOut: boolean;
  source: SourceRef;
  mapping: Pick<MappingProfile, "mappingProfileId" | "version"> | null;
  /** Present only for OPTED_IN candidates from the approved custom field. */
  evidence: {
    statementHash: string | null;
    noticeId: string | null;
    noticeVersion: string | null;
  } | null;
  effectiveAt: string;
  observedAt: string;
  idempotencyKey: string;
  payloadHash: string;
}

export type QuarantineReason =
  | "OPT_IN_MISSING_EVIDENCE"
  | "UNKNOWN_MAPPING"
  | "MISSING_TIMESTAMP";

export interface ConsentStateChange {
  changeId: string;
  tenantId: string;
  partyId: string;
  purposeCode: string;
  channel: Channel;
  effectiveStatus: "GRANTED" | "WITHDRAWN" | "SUPPRESSED";
  effectiveAt: string;
  consentVersion: number;
  originSystem: string;
  correlationId: string;
}

export type DeliveryStatus =
  | "APPLIED"
  | "PROSPECT_NOT_FOUND"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "STALE_VERSION_SKIPPED"
  | "NOT_SUPPORTED";

export interface DeliveryReceipt {
  deliveryId: string;
  changeId: string;
  destinationSystem: "OUTREACH";
  destinationOrgId: string;
  destinationProspectId: string;
  consentVersion: number;
  status: DeliveryStatus;
  attemptCount: number;
  deliveredAt?: string;
  detail?: string;
  requiresAlternateEnforcement?: boolean;
}
