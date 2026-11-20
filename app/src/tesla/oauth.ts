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
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "login");
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
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) throw new AppError("tesla_token_rejected", 502);
  return payload;
}

export async function exchangeTeslaCode(env: Env, code: string, verifier: string): Promise<TokenResponse> {
  return tokenPost(
    env,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.TESLA_CLIENT_ID,
      client_secret: env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: env.TESLA_REDIRECT_URI,
      code_verifier: verifier,
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
      client_secret: env.TESLA_CLIENT_SECRET,
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
