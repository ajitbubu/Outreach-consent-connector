/**
 * Outreach Prospect resource — documented JSON:API endpoints only.
 *
 * The sync worker and delivery worker program against the two small ports at
 * the bottom (ProspectSource / PreferenceWriter); this class implements both
 * over the real API, and tests/demos implement them over fixtures.
 *
 * Field names (optedOut, emailOptedOut, callOptedOut, smsOptedOut and their
 * *At timestamps) follow the Prospect resource reference; confirm per tenant
 * during implementation — granular opt-out is a tenant setting.
 */

import { createHash } from "node:crypto";
import type { OutreachClient } from "./client.js";
import { OutreachApiError } from "./client.js";
import type { Channel, ProspectRecord } from "../domain/types.js";

interface JsonApiProspect {
  id: number | string;
  attributes: Record<string, unknown>;
}

interface JsonApiPage {
  data: JsonApiProspect[];
  links?: { next?: string };
  meta?: { count?: number };
}

export interface ProspectPage {
  prospects: ProspectRecord[];
  nextCursor: string | undefined;
}

export interface ProspectSourceOptions {
  orgId: string;
  granularOptOutEnabled: boolean;
  /** Approved custom opt-in field name (e.g. "custom12"), null when none. */
  optInFieldName: string | null;
}

export class ProspectsApi {
  constructor(
    private readonly client: OutreachClient,
    private readonly options: ProspectSourceOptions,
  ) {}

  /**
   * Page prospects modified after a watermark. JSON:API filters + cursor links:
   *   GET /prospects?filter[updatedAt]=<iso>..inf&sort=updatedAt&page[size]=N
   * The `links.next` URL is treated as the opaque cursor.
   */
  async fetchPage(
    cursor: string | undefined,
    updatedAfterIso: string | null,
    pageSize: number,
  ): Promise<ProspectPage> {
    const path =
      cursor ??
      `/prospects?${new URLSearchParams({
        ...(updatedAfterIso ? { "filter[updatedAt]": `${updatedAfterIso}..inf` } : {}),
        sort: "updatedAt",
        "page[size]": String(pageSize),
      }).toString()}`;

    const page = await this.client.get<JsonApiPage>(path);
    return {
      prospects: page.data.map((p) => this.toRecord(p)),
      nextCursor: page.links?.next ? stripBase(page.links.next) : undefined,
    };
  }

  async fetchProspect(prospectId: string): Promise<ProspectRecord | null> {
    try {
      const result = await this.client.get<{ data: JsonApiProspect }>(
        `/prospects/${encodeURIComponent(prospectId)}`,
      );
      return this.toRecord(result.data);
    } catch (error) {
      if (error instanceof OutreachApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Outbound enforcement: set opt-out flags. WITHDRAWALS ONLY — the connector
   * never clears an opt-out (clearing ≠ renewed consent, spec §6 rule 4).
   */
  async applyOptOut(prospectId: string, channels: Channel[]): Promise<void> {
    const attributes: Record<string, boolean> = {};
    if (!this.options.granularOptOutEnabled) {
      attributes["optedOut"] = true;
    } else {
      for (const channel of channels) {
        attributes[CHANNEL_ATTRIBUTE[channel]] = true;
      }
    }
    await this.client.patch(`/prospects/${encodeURIComponent(prospectId)}`, {
      data: { type: "prospect", id: Number(prospectId) || prospectId, attributes },
    });
  }

  private toRecord(p: JsonApiProspect): ProspectRecord {
    const a = p.attributes;
    const emails = Array.isArray(a["emails"]) ? (a["emails"] as string[]) : [];
    const optInFieldName = this.options.optInFieldName;
    return {
      prospectId: String(p.id),
      orgId: this.options.orgId,
      emailNormalized: normalizeEmail(emails[0] ?? null),
      firstName: str(a["firstName"]),
      lastName: str(a["lastName"]),
      granularOptOutEnabled: this.options.granularOptOutEnabled,
      globalOptedOut: a["optedOut"] === true,
      globalOptedOutAt: str(a["optedOutAt"]),
      emailOptedOut: bool(a["emailOptedOut"]),
      emailOptedOutAt: str(a["emailOptedOutAt"]),
      callOptedOut: bool(a["callOptedOut"]),
      callOptedOutAt: str(a["callOptedOutAt"]),
      smsOptedOut: bool(a["smsOptedOut"]),
      smsOptedOutAt: str(a["smsOptedOutAt"]),
      optInField:
        optInFieldName && a[optInFieldName] !== undefined
          ? {
              fieldName: optInFieldName,
              value: str(a[optInFieldName]),
              // Evidence companions live in adjacent approved fields per mapping
              // profile; the tenant adapter config wires them. Null here means
              // the qualifier will quarantine the opt-in (correct default).
              statementHash: str(a[`${optInFieldName}_statement_hash`]),
              noticeId: str(a[`${optInFieldName}_notice_id`]),
              noticeVersion: str(a[`${optInFieldName}_notice_version`]),
              capturedAt: str(a[`${optInFieldName}_captured_at`]),
            }
          : null,
      updatedAt: str(a["updatedAt"]) ?? new Date(0).toISOString(),
      payloadHash: "sha256:" + createHash("sha256").update(JSON.stringify(p)).digest("hex"),
    };
  }
}

export const CHANNEL_ATTRIBUTE: Record<Channel, string> = {
  EMAIL: "emailOptedOut",
  CALL: "callOptedOut",
  SMS: "smsOptedOut",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : null;
}

function stripBase(nextUrl: string): string {
  const index = nextUrl.indexOf("/prospects");
  return index >= 0 ? nextUrl.slice(index) : nextUrl;
}

/** Ports the workers program against (fixtures implement these in tests/demo). */
export interface ProspectSource {
  fetchPage(cursor: string | undefined, updatedAfterIso: string | null, pageSize: number): Promise<ProspectPage>;
}

export interface PreferenceWriter {
  applyOptOut(prospectId: string, channels: Channel[]): Promise<void>;
}
