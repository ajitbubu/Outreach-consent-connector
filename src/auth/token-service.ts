/**
 * OAuth 2.0 authentication — Outreach uses authorization-code + refresh tokens
 * (developers.outreach.io/api/oauth). Same fail-closed posture as the HubSpot
 * connector: cache the short-lived access token, refresh before expiry or on
 * 401, surface AUTHORIZATION_REQUIRED when the refresh token is revoked.
 */

export interface AccessTokenProvider {
  getToken(): Promise<string>;
  refresh(): Promise<string>;
}

export class AuthorizationRequiredError extends Error {
  constructor(public readonly connectorId: string) {
    super(`Connector ${connectorId} requires re-authorization`);
    this.name = "AuthorizationRequiredError";
  }
}

/** Static token (dev/test); a 401 means it was revoked. */
export class StaticTokenProvider implements AccessTokenProvider {
  constructor(private readonly readSecret: () => Promise<string>) {}
  async getToken(): Promise<string> {
    return this.readSecret();
  }
  async refresh(): Promise<string> {
    throw new AuthorizationRequiredError("static-token");
  }
}

export interface OAuthCredentialStore {
  readRefreshToken(connectorId: string): Promise<string | null>;
  writeTokens(connectorId: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<void>;
}

export interface OAuthTokenExchanger {
  /**
   * POST https://api.outreach.io/oauth/token grant_type=refresh_token.
   * Outreach ROTATES refresh tokens on every exchange — the new one must be
   * persisted or the next refresh fails. Returns null when revoked.
   */
  exchangeRefreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresInSeconds: number } | null>;
}

export class OAuthTokenProvider implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private static readonly EXPIRY_MARGIN_MS = 60_000;

  constructor(
    private readonly connectorId: string,
    private readonly store: OAuthCredentialStore,
    private readonly exchanger: OAuthTokenExchanger,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - OAuthTokenProvider.EXPIRY_MARGIN_MS > this.now()) {
      return this.cached.token;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const refreshToken = await this.store.readRefreshToken(this.connectorId);
    if (!refreshToken) throw new AuthorizationRequiredError(this.connectorId);

    const result = await this.exchanger.exchangeRefreshToken(refreshToken);
    if (!result) throw new AuthorizationRequiredError(this.connectorId);

    const expiresAt = this.now() + result.expiresInSeconds * 1000;
    this.cached = { token: result.accessToken, expiresAt };
    // Persist BOTH tokens — Outreach rotates the refresh token per exchange.
    await this.store.writeTokens(this.connectorId, result.accessToken, result.refreshToken, expiresAt);
    return result.accessToken;
  }
}
