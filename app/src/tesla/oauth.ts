import { bytesToBase64Url, randomBytes, utf8 } from "../lib/bytes";
import { sha256 } from "../lib/security";
import { AppError } from "../lib/errors";
import { fleetUrl } from "../config";

export async function buildTeslaAuthorizeUrl(env: Env, state: string, verifier: string): Promise<string> {
  const challenge = bytesToBase64Url(await sha256(utf8(verifier)));
  const url = new URL(env.TESLA_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.TESLA_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.TESLA_REDIRECT_URI);
  url.searchParams.set("scope", env.TESLA_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", bytesToBase64Url(randomBytes(16)));
  // Matches the authorize request that already works for this client: confidential client + state, no PKCE.
  void challenge;
  url.searchParams.set("prompt_missing_scopes", "true");
  return url.href;
}

export function newVerifier(): string {
  return bytesToBase64Url(randomBytes(32));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenPost(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(env.TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await response.text();
  let payload: TokenResponse & { error?: string; error_description?: string } = {};
  try {
    payload = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  if (!response.ok || !payload.access_token) {
    // Only Tesla's public error fields are logged, never the request body or tokens.
    console.error(JSON.stringify({ tesla_token_error: { status: response.status, grant: body.get("grant_type"), error: payload.error ?? null, description: payload.error_description ?? null } }));
    throw new AppError(payload.error === "invalid_auth_code" ? "tesla_code_expired" : "tesla_token_rejected", 502);
  }
  return payload;
}

export async function exchangeTeslaCode(env: Env, code: string, _verifier: string): Promise<TokenResponse> {
  return tokenPost(
    env,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.TESLA_CLIENT_ID,
      client_secret: (env.TESLA_CLIENT_SECRET ?? "").trim(),
      code,
      redirect_uri: env.TESLA_REDIRECT_URI,
      audience: env.TESLA_AUDIENCE,
    }),
  );
}

export async function refreshTesla(env: Env, refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const payload = await tokenPost(
    env,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.TESLA_CLIENT_ID,
      client_secret: (env.TESLA_CLIENT_SECRET ?? "").trim(),
      refresh_token: refreshToken,
    }),
  );
  if (!payload.refresh_token) throw new AppError("tesla_refresh_missing", 502);
  return {
    accessToken: payload.access_token ?? "",
    refreshToken: payload.refresh_token,
    expiresIn: payload.expires_in ?? 3600,
  };
}

export function parsePastedCallback(input: { callbackUrl?: string; code?: string; state?: string }): { code: string; state: string } {
  if (input.callbackUrl) {
    let url: URL;
    try {
      url = new URL(input.callbackUrl);
    } catch {
      throw new AppError("callback_incomplete");
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) throw new AppError("callback_incomplete");
    return { code, state };
  }
  if (!input.code || !input.state) throw new AppError("callback_incomplete");
  return { code: input.code, state: input.state };
}

export async function teslaJson(env: Env, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const response = await fetch(fleetUrl(env, path), { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new AppError(`tesla_${response.status}`, 502);
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

/** One-shot diagnostic: validates the client secret with a partner-token request. Logs no secret or token. */
export async function teslaSecretDiagnostic(env: Env): Promise<void> {
  const raw = env.TESLA_CLIENT_SECRET ?? "";
  const trimmed = raw.trim();
  const fp = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(trimmed)))).slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
  const response = await fetch(env.TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.TESLA_CLIENT_ID, client_secret: trimmed, scope: "openid vehicle_device_data", audience: env.TESLA_AUDIENCE }),
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  console.log(JSON.stringify({ tesla_secret_diag: { rawLength: raw.length, trimmedLength: trimmed.length, hadWhitespace: raw !== trimmed, fp, status: response.status, ok: Boolean(payload.access_token), error: payload.error ?? null } }));
}
