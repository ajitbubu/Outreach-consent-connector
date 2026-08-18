/**
 * One-time OAuth bootstrap against a real Outreach org (developer account).
 *
 * Prereq: an Outreach OAuth app (developers.outreach.io) with redirect URI
 * http://localhost:8123/callback and at least the prospects.read scope.
 *
 * Run:
 *   OUTREACH_CLIENT_ID=... OUTREACH_CLIENT_SECRET=... npm run live:oauth
 *
 * Opens the authorize URL, catches the redirect on localhost:8123, exchanges
 * the code, and saves tokens to .outreach-tokens.json (gitignored). Outreach
 * rotates refresh tokens on every exchange; live scripts persist each new one
 * back to the same file.
 */

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOKENS_FILE = fileURLToPath(new URL("../.outreach-tokens.json", import.meta.url));
const REDIRECT_URI = process.env["OUTREACH_REDIRECT_URI"] ?? "http://localhost:8123/callback";
const SCOPES = process.env["OUTREACH_SCOPES"] ?? "prospects.read";

const clientId = process.env["OUTREACH_CLIENT_ID"];
const clientSecret = process.env["OUTREACH_CLIENT_SECRET"];
if (!clientId || !clientSecret) {
  console.error("Set OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET (from your Outreach OAuth app).");
  process.exit(1);
}

const authorizeUrl =
  "https://api.outreach.io/oauth/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
  }).toString();

const port = Number(new URL(REDIRECT_URI).port || 80);

// https redirect URIs (Outreach apps often register https://localhost:...)
// need a local TLS server; provide a self-signed cert via TLS_CERT/TLS_KEY.
const useTls = REDIRECT_URI.startsWith("https:");
const tlsOptions = useTls
  ? { cert: readFileSync(process.env["TLS_CERT"]!), key: readFileSync(process.env["TLS_KEY"]!) }
  : null;

const handler = async (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing ?code");
    return;
  }
  try {
    const response = await fetch("https://api.outreach.io/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code,
      }),
    });
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !json.access_token || !json.refresh_token) {
      throw new Error(`token exchange failed (${response.status}): ${JSON.stringify(json)}`);
    }
    writeFileSync(
      TOKENS_FILE,
      JSON.stringify(
        {
          clientId,
          clientSecret,
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
        },
        null,
        2,
      ),
    );
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Tokens saved — return to the terminal.");
    console.log(`✓ Tokens saved to ${TOKENS_FILE}`);
    console.log("Next: npm run live:smoke");
  } catch (error) {
    res.writeHead(500).end("Token exchange failed — see terminal.");
    console.error(error);
  } finally {
    server.close();
  }
};

const server = useTls ? createHttpsServer(tlsOptions!, handler) : createHttpServer(handler);

server.listen(port, () => {
  console.log("Open this URL in a browser logged into your Outreach developer org:\n");
  console.log(`  ${authorizeUrl}\n`);
  console.log(`Waiting for the redirect on ${REDIRECT_URI} ...`);
});
