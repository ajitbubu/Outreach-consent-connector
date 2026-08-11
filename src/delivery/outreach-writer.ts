/**
 * Outbound delivery: platform ConsentStateChange → Outreach.
 *
 * The Outreach-specific rule (spec §6 rule 4 + §2 out-of-scope): the connector
 * enforces WITHDRAWALS by setting opt-out flags, but NEVER clears an opt-out —
 * a GRANTED change is receipted NOT_SUPPORTED with requiresAlternateEnforcement
 * (re-permission is a human/CRM process, not a bit-flip). Version gate,
 * receipts, and retry classification match the sibling connectors.
 */

import { randomUUID } from "node:crypto";
import type { PreferenceWriter } from "../outreach/prospects-api.js";
import { OutreachApiError } from "../outreach/client.js";
import type { PartyDestinationLookup } from "../platform/port.js";
import type { ConsentStateChange, DeliveryReceipt, DeliveryStatus } from "../domain/types.js";

export interface DeliveryStore {
  lastAppliedVersion(change: ConsentStateChange, orgId: string): Promise<number | null>;
  recordAppliedVersion(change: ConsentStateChange, orgId: string): Promise<void>;
  insertReceipt(receipt: DeliveryReceipt): Promise<void>;
}

export type VersionDecision = "APPLY" | "SKIP_EQUAL" | "STALE_VERSION_SKIPPED";

export function compareVersions(incoming: number, lastApplied: number | null): VersionDecision {
  if (lastApplied === null || incoming > lastApplied) return "APPLY";
  if (incoming === lastApplied) return "SKIP_EQUAL";
  return "STALE_VERSION_SKIPPED";
}

export class OutreachDeliveryWorker {
  constructor(
    private readonly writer: PreferenceWriter,
    private readonly destinations: PartyDestinationLookup,
    private readonly store: DeliveryStore,
    private readonly orgId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(change: ConsentStateChange): Promise<DeliveryReceipt> {
    const destination = await this.destinations.findProspect(change.tenantId, change.partyId, this.orgId);
    if (!destination) return this.receipt(change, "-", "PROSPECT_NOT_FOUND");

    const decision = compareVersions(
      change.consentVersion,
      await this.store.lastAppliedVersion(change, this.orgId),
    );
    if (decision === "SKIP_EQUAL") return this.receipt(change, destination.prospectId, "APPLIED");
    if (decision === "STALE_VERSION_SKIPPED") {
      return this.receipt(change, destination.prospectId, "STALE_VERSION_SKIPPED");
    }

    if (change.effectiveStatus === "GRANTED") {
      // Never clear an opt-out programmatically — re-permission is not a bit-flip.
      return this.receipt(
        change,
        destination.prospectId,
        "NOT_SUPPORTED",
        "grants are not written to Outreach; opt-out clearing requires an approved human/CRM process",
        true,
      );
    }

    try {
      await this.writer.applyOptOut(destination.prospectId, [change.channel]);
      await this.store.recordAppliedVersion(change, this.orgId);
      return this.receipt(change, destination.prospectId, "APPLIED");
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return this.receipt(change, destination.prospectId, classified.status, classified.detail);
    }
  }

  private async receipt(
    change: ConsentStateChange,
    prospectId: string,
    status: DeliveryStatus,
    detail?: string,
    requiresAlternateEnforcement?: boolean,
  ): Promise<DeliveryReceipt> {
    const receipt: DeliveryReceipt = {
      deliveryId: `DEL-${randomUUID()}`,
      changeId: change.changeId,
      destinationSystem: "OUTREACH",
      destinationOrgId: this.orgId,
      destinationProspectId: prospectId,
      consentVersion: change.consentVersion,
      status,
      attemptCount: 1,
      ...(status === "APPLIED" ? { deliveredAt: this.now().toISOString() } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(requiresAlternateEnforcement ? { requiresAlternateEnforcement: true } : {}),
    };
    await this.store.insertReceipt(receipt);
    return receipt;
  }
}

export function classifyDeliveryError(error: unknown): { status: DeliveryStatus; detail?: string } {
  if (error instanceof OutreachApiError) {
    if (error.status === 404) return { status: "PROSPECT_NOT_FOUND" };
    if (error.retryable) return { status: "RETRYABLE_FAILURE", detail: "retry with backoff" };
    return { status: "PERMANENT_FAILURE", detail: `HTTP ${error.status}` };
  }
  return { status: "RETRYABLE_FAILURE", detail: "transient transport failure" };
}
