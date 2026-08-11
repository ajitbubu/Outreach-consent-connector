/**
 * Outreach HTTP client — JSON:API over https://api.outreach.io/api/v2.
 * Injectable fetch, 401 refresh-once-then-fail-closed, 429/Retry-After with
 * jittered backoff, email-redacted errors. Every vendor call goes through here.
 */

import type { AccessTokenProvider } from "../auth/token-service.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class OutreachApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    detail: string,
  ) {
    super(`Outreach API error ${status}: ${detail}`);
    this.name = "OutreachApiError";
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface OutreachClientOptions {
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export class OutreachClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly tokens: AccessTokenProvider,
    options: OutreachClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://api.outreach.io/api/v2";
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = options.jitter ?? Math.random;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.tokens.getToken();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.api+json",
          ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status >= 200 && response.status < 300) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.tokens.refresh();
        continue;
      }

      const retryable = RETRYABLE_STATUSES.has(response.status);
      if (retryable && attempt < this.maxRetries) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        const backoffMs = Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.jitter() / 2);
        await this.sleep(backoffMs);
        continue;
      }

      const excerpt = redactIdentifiers(await response.text()).slice(0, 300);
      throw new OutreachApiError(response.status, retryable, `${method} ${redactIdentifiers(path)} → ${excerpt}`);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}

export function redactIdentifiers(value: string): string {
  return value.replace(/[^/?&=\s"']+@[^/?&=\s"']+/g, "<redacted-email>");
}
