/**
 * Checkpointed sync worker — historical import + incremental polling.
 * Checkpoint advances only after every prospect on the page is accepted,
 * deduplicated, or durably quarantined; incremental polling uses an overlap
 * window whose duplicates the idempotency keys absorb; the watermark stores
 * the max observed SOURCE updatedAt, never the job clock.
 */

import type { ProspectSource } from "../outreach/prospects-api.js";
import type { ConsentPlatformPort } from "../platform/port.js";
import type { Channel, MappingProfile } from "../domain/types.js";
import { normalizeProspect } from "./normalizer.js";

export interface CheckpointStore {
  readCursor(jobType: string): Promise<string | null>;
  writeCursor(jobType: string, cursor: string | null): Promise<void>;
  readWatermark(jobType: string): Promise<number | null>;
  writeWatermark(jobType: string, epochMs: number): Promise<void>;
}

export interface SyncOptions {
  tenantId: string;
  orgId: string;
  pageSize: number;
  overlapMinutes: number;
  findMapping: (channel: Channel) => MappingProfile | null;
  now?: () => Date;
}

export interface SyncStats {
  pagesProcessed: number;
  prospectsSeen: number;
  signalsSubmitted: number;
  signalsDeduplicated: number;
  quarantined: number;
}

const IMPORT_JOB = "HISTORICAL_IMPORT";
const POLL_JOB = "INCREMENTAL_POLL";
const DONE = "DONE";

export class SyncWorker {
  constructor(
    private readonly source: ProspectSource,
    private readonly platform: ConsentPlatformPort,
    private readonly checkpoints: CheckpointStore,
    private readonly options: SyncOptions,
  ) {}

  async runHistoricalImport(): Promise<SyncStats> {
    const stats = emptyStats();
    let cursor = await this.checkpoints.readCursor(IMPORT_JOB);
    if (cursor === DONE) return stats;

    while (true) {
      const page = await this.source.fetchPage(cursor ?? undefined, null, this.options.pageSize);
      await this.processProspects(page, stats);
      stats.pagesProcessed += 1;

      if (page.nextCursor === undefined) {
        await this.checkpoints.writeCursor(IMPORT_JOB, DONE);
        return stats;
      }
      cursor = page.nextCursor;
      await this.checkpoints.writeCursor(IMPORT_JOB, cursor);
    }
  }

  async runIncrementalPoll(): Promise<SyncStats> {
    const stats = emptyStats();
    const watermark = (await this.checkpoints.readWatermark(POLL_JOB)) ?? 0;
    const updatedAfter = new Date(Math.max(0, watermark - this.options.overlapMinutes * 60_000)).toISOString();

    let cursor: string | undefined;
    let maxObserved = watermark;

    while (true) {
      const page = await this.source.fetchPage(cursor, updatedAfter, this.options.pageSize);
      await this.processProspects(page, stats);
      stats.pagesProcessed += 1;

      for (const prospect of page.prospects) {
        const updated = Date.parse(prospect.updatedAt);
        if (Number.isFinite(updated) && updated > maxObserved) maxObserved = updated;
      }

      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    if (maxObserved > watermark) await this.checkpoints.writeWatermark(POLL_JOB, maxObserved);
    return stats;
  }

  private async processProspects(
    page: Awaited<ReturnType<ProspectSource["fetchPage"]>>,
    stats: SyncStats,
  ): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    for (const prospect of page.prospects) {
      stats.prospectsSeen += 1;

      const resolution = await this.platform.resolveParty({
        tenantId: this.options.tenantId,
        orgId: this.options.orgId,
        prospectId: prospect.prospectId,
        emailNormalized: prospect.emailNormalized,
        firstName: prospect.firstName,
        lastName: prospect.lastName,
      });
      const partyId = resolution.outcome === "RESOLVED" ? resolution.partyId : null;

      const result = normalizeProspect(prospect, {
        tenantId: this.options.tenantId,
        partyId,
        findMapping: this.options.findMapping,
        observedAt: now.toISOString(),
      });

      for (const entry of result.quarantined) {
        await this.platform.submitQuarantine({
          tenantId: this.options.tenantId,
          reason: entry.reason,
          channel: entry.channel,
          detail: entry.detail,
          sourceRef: `outreach:${this.options.orgId}:PROSPECT:${prospect.prospectId}`,
        });
        stats.quarantined += 1;
      }

      for (const signal of result.signals) {
        const ack = await this.platform.submitSignal(signal);
        if (ack.accepted && ack.deduplicated) stats.signalsDeduplicated += 1;
        else if (ack.accepted) stats.signalsSubmitted += 1;
      }
    }
  }
}

function emptyStats(): SyncStats {
  return { pagesProcessed: 0, prospectsSeen: 0, signalsSubmitted: 0, signalsDeduplicated: 0, quarantined: 0 };
}
