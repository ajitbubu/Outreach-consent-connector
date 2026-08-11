/**
 * Fixture ProspectSource + PreferenceWriter — FOR TESTS AND DEMOS ONLY.
 * Serves pages of ProspectRecords and records opt-out writes in memory.
 */

import type { ProspectPage, ProspectSource, PreferenceWriter } from "../prospects-api.js";
import type { Channel, ProspectRecord } from "../../domain/types.js";

export class FixtureSource implements ProspectSource, PreferenceWriter {
  readonly appliedOptOuts: Array<{ prospectId: string; channels: Channel[] }> = [];

  constructor(
    private readonly prospects: ProspectRecord[],
    private readonly options: { pageSize?: number } = {},
  ) {}

  async fetchPage(
    cursor: string | undefined,
    updatedAfterIso: string | null,
    pageSize: number,
  ): Promise<ProspectPage> {
    const eligible =
      updatedAfterIso === null
        ? this.prospects
        : this.prospects.filter((p) => Date.parse(p.updatedAt) > Date.parse(updatedAfterIso));

    const start = cursor === undefined ? 0 : Number(cursor);
    const size = this.options.pageSize ?? pageSize;
    const slice = eligible.slice(start, start + size);
    return {
      prospects: slice,
      nextCursor: start + size < eligible.length ? String(start + size) : undefined,
    };
  }

  async applyOptOut(prospectId: string, channels: Channel[]): Promise<void> {
    this.appliedOptOuts.push({ prospectId, channels });
  }
}

/** Convenience builder for fixture prospects. */
export function fixtureProspect(
  overrides: Partial<ProspectRecord> & { prospectId: string },
): ProspectRecord {
  return {
    orgId: "org-demo",
    emailNormalized: null,
    firstName: null,
    lastName: null,
    granularOptOutEnabled: true,
    globalOptedOut: false,
    globalOptedOutAt: null,
    emailOptedOut: null,
    emailOptedOutAt: null,
    callOptedOut: null,
    callOptedOutAt: null,
    smsOptedOut: null,
    smsOptedOutAt: null,
    optInField: null,
    updatedAt: "2026-08-10T12:00:00Z",
    payloadHash: "sha256:fixture-" + overrides.prospectId,
    ...overrides,
  };
}
