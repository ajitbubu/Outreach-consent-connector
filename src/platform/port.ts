/**
 * Boundary between this connector and YOUR consent platform — the same
 * contract family as the HubSpot and Highspot connectors, so one platform
 * side serves all three.
 */

import type { Channel, ConsentSignal, QuarantineReason } from "../domain/types.js";

export type PartyResolution =
  | { outcome: "RESOLVED"; partyId: string }
  | { outcome: "UNRESOLVED" }
  | { outcome: "REVIEW" };

export type SignalAck =
  | { accepted: true; deduplicated: boolean }
  | { accepted: false; reason: string };

export interface ConsentPlatformPort {
  resolveParty(input: {
    tenantId: string;
    orgId: string;
    prospectId: string;
    emailNormalized: string | null;
    firstName: string | null;
    lastName: string | null;
  }): Promise<PartyResolution>;

  /** Idempotent on signal.idempotencyKey. */
  submitSignal(signal: ConsentSignal): Promise<SignalAck>;

  submitQuarantine(input: {
    tenantId: string;
    reason: QuarantineReason;
    channel: Channel | null;
    detail: string;
    sourceRef: string;
  }): Promise<void>;
}

export interface PartyDestinationLookup {
  findProspect(
    tenantId: string,
    partyId: string,
    orgId: string,
  ): Promise<{ prospectId: string } | null>;
}
