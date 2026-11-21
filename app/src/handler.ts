import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { registrationDecision } from "./auth/policy";
import { clearSessionCookie, newSessionSecret, readCookie, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionActive, sessionCookie } from "./auth/session";
import { homePoint, mocksEnabled, stationId } from "./config";
import {
  audit,
  countPasskeys,
  deleteSession,
  insertSession,
  latestVehicle,
  privateLocation,
  readPoll,
  readSession,
  saveChallenge,
  takeChallenge,
} from "./db";
import { toPublicDashboard } from "./energy/public";
import { AppError } from "./lib/errors";
import { asWebBytes, base64ToBytes, bytesToBase64, bytesToBase64Url, randomBytes, utf8 } from "./lib/bytes";
import { sha256Hex, timingSafeEqualString } from "./lib/security";
import { SAMPLE_POINT } from "./mock/sample";
import { initialPlug } from "./plugcharge/machine";
import { sigenAuthorizationUrl } from "./sigen/oauth";
import { callSigenTool, confirmedSigenWrite } from "./sigen/client";
import { acChargeModeArgs, controlChargerArgs, parseSocSettings, withChargeSoc, type AcChargeMode } from "./sigen/parse";
import { loadSnapshot } from "./snapshot";
import { chargeStart, chargeStop, hvacAuto, setChargeLimit, setChargingAmps } from "./tesla/commands";
import { sendVehicleCommand } from "./tesla/command";
import { buildTeslaAuthorizeUrl, exchangeTeslaCode, newVerifier, parsePastedCallback } from "./tesla/oauth";
import { chooseVehicle, parseVehicleList } from "./tesla/parse";
import { teslaJson } from "./tesla/oauth";
import { renderPage } from "./ui/render";
import { siteResponse } from "./site";
import { illustrativeSnapshot } from "./mock/sample";
import { gridPrice } from "./config";

const OWNER_ID = utf8("white-lotus-owner");

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/owner/sigen/import") return await ownerSigenImport(request, env);
    if (request.method === "GET" && (url.pathname === "/owner/tesla/connect" || url.pathname === "/owner/sigen/connect")) {
      return await ownerConnectLink(request, env, url);
    }
    if (request.method === "GET" && (url.pathname === "/callback" || url.pathname === "/callback/")) {
      const done = await teslaCallback(url, env);
      if (done) return done;
    }
    const site = siteResponse(url);
    if (site && request.method === "GET") return site;
    if (url.pathname === "/sigen/callback" && request.method === "POST") return await sigenCallback(request, env);
    if (request.method === "GET" && url.pathname === "/") return renderPage("public", null);
    if (request.method === "GET" && url.pathname === "/login") return renderPage("login", null);
    if (request.method === "GET" && url.pathname === "/controls") {
      if (!(await sessionOrNull(request, env))) return Response.redirect(new URL("/login", url).toString(), 302);
      return renderPage("controls", null);
    }
    if (request.method === "GET" && url.pathname === "/preview/controls") return preview(env);
    if (url.pathname.startsWith("/api/")) return await api(request, env, url);
    throw new AppError("not_found", 404);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.code }, error.status);
    console.error(JSON.stringify({ message: "request_failed", path: url.pathname, error: error instanceof Error ? error.message : "error" }));
    return json({ error: "internal" }, 500);
  }
}

function preview(env: Env): Response {
  if (!mocksEnabled(env)) throw new AppError("not_found", 404);
  const now = Date.now();
  const snap = illustrativeSnapshot(now, env.HOUSE_TIMEZONE, gridPrice(env), env.CURRENCY, env.VEHICLE_NAME);
  return renderPage("preview", {
    preview: true,
    dashboard: toPublicDashboard(snap, now),
    plug: initialPlug(now),
    settings: { chargeLimit: 80, amps: 32, chargeSoc: 80, mode: "pv_surplus", climateOn: false },
    exact: { lat: SAMPLE_POINT.lat, lon: SAMPLE_POINT.lon, sample: true },
    status: { tesla: true, sigen: true, vehicleName: env.VEHICLE_NAME, chargerKnown: true },
  });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/public/dashboard") {
    return json(toPublicDashboard(await loadSnapshot(env), Date.now()));
  }
  if (request.method === "GET" && path === "/api/auth/status") {
    const session = await sessionOrNull(request, env);
    return json({ authenticated: Boolean(session), passkeys: await countPasskeys(env.DB) });
  }
  if (request.method === "GET" && path === "/api/session") {
    const session = await sessionOrNull(request, env);
    if (!session) return json({ authenticated: false });
    return json({ authenticated: true, csrfToken: session.csrf });
  }
  if (path.startsWith("/api/auth/")) return authApi(request, env, path);
  const session = await requireSession(request, env);
  if (request.method !== "GET") {
    await requireCsrf(request, session.csrf);
    if (!(await rateLimit(env, `ctrl:${session.hash}`, 40, 300))) throw new AppError("rate_limited", 429);
  }
  if (path.startsWith("/api/owner/")) return ownerApi(request, env, path);
  if (path.startsWith("/api/controls/")) return controlApi(request, env, path);
  throw new AppError("not_found", 404);
}

async function authApi(request: Request, env: Env, path: string): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await rateLimit(env, `auth:${ip}`, 20, 300))) throw new AppError("rate_limited", 429);
  if (request.method === "POST" && path === "/api/auth/register/options") return registerOptions(request, env);
  if (request.method === "POST" && path === "/api/auth/register/verify") return registerVerify(request, env);
  if (request.method === "POST" && path === "/api/auth/login/options") return loginOptions(env);
  if (request.method === "POST" && path === "/api/auth/login/verify") return loginVerify(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return logout(request, env);
  throw new AppError("not_found", 404);
}

async function registerOptions(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  await assertRegistration(env, body.setupCode);
  const options = await generateRegistrationOptions({
    rpName: env.RP_NAME,
    rpID: env.RP_ID,
    userName: "owner",
    userID: asWebBytes(OWNER_ID),
    userDisplayName: "Owner",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const challengeId = bytesToBase64Url(randomBytes(16));
  await saveChallenge(env.DB, challengeId, options.challenge, "register", Date.now() + 5 * 60 * 1000);
  return json({ challengeId, options });
}

async function registerVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  await assertRegistration(env, body.setupCode);
  const challengeId = stringField(body.challengeId, "challenge");
  const expected = await takeChallenge(env.DB, challengeId, "register");
  if (!expected) throw new AppError("challenge_expired", 400);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential as RegistrationResponseJSON,
      expectedChallenge: expected,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
    });
  } catch {
    throw new AppError("passkey_rejected", 400);
  }
  if (!verification.verified) throw new AppError("passkey_rejected", 400);
  const credential = verification.registrationInfo.credential;
  await env.DB.prepare(
    "INSERT INTO credentials (credential_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      credential.id,
      bytesToBase64(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      Date.now(),
    )
    .run();
  return issueSession(env);
}

async function loginOptions(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT credential_id, transports FROM credentials").all<{
    credential_id: string;
    transports: string | null;
  }>();
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: "required",
    allowCredentials: (rows.results ?? []).map((row) => ({
      id: row.credential_id,
      transports: row.transports ? (JSON.parse(row.transports) as string[]) : undefined,
    })),
  });
  const challengeId = bytesToBase64Url(randomBytes(16));
  await saveChallenge(env.DB, challengeId, options.challenge, "login", Date.now() + 5 * 60 * 1000);
  return json({ challengeId, options });
}

async function loginVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const challengeId = stringField(body.challengeId, "challenge");
  const expected = await takeChallenge(env.DB, challengeId, "login");
  if (!expected) throw new AppError("challenge_expired", 400);
  const response = body.credential as AuthenticationResponseJSON;
  const row = await env.DB.prepare("SELECT credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?")
    .bind(response.id)
    .first<{ credential_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!row) throw new AppError("passkey_rejected", 400);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: asWebBytes(base64ToBytes(row.public_key)),
        counter: row.counter,
        transports: row.transports ? (JSON.parse(row.transports) as string[]) : undefined,
      },
    });
  } catch {
    throw new AppError("passkey_rejected", 400);
  }
  if (!verification.verified) throw new AppError("passkey_rejected", 400);
  await env.DB.prepare("UPDATE credentials SET counter = ? WHERE credential_id = ?")
    .bind(verification.authenticationInfo.newCounter, row.credential_id)
    .run();
  return issueSession(env);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await deleteSession(env.DB, await sha256Hex(token));
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

async function issueSession(env: Env): Promise<Response> {
  const secret = newSessionSecret();
  const csrf = newSessionSecret();
  await insertSession(env.DB, await sha256Hex(secret), csrf, Date.now(), SESSION_TTL_SECONDS);
  return json({ ok: true, csrfToken: csrf }, 200, { "set-cookie": sessionCookie(secret) });
}

async function assertRegistration(env: Env, provided: unknown): Promise<void> {
  const count = await countPasskeys(env.DB);
  const configured = Boolean(env.SETUP_CODE);
  const code = typeof provided === "string" ? provided : "";
  const matches = configured ? await timingSafeEqualString(code, env.SETUP_CODE) : false;
  const decision = registrationDecision(count, configured, matches, code.length > 0);
  if (decision === "locked") throw new AppError("registration_locked", 403);
  if (decision === "setup_required" || decision === "bad_code") throw new AppError(decision, 403);
}

async function ownerApi(request: Request, env: Env, path: string): Promise<Response> {
  const vault = env.TOKEN_VAULT.getByName("owner");
  if (request.method === "GET" && path === "/api/owner/status") return json(await vault.connectionStatus());
  const body = await readJson(request);
  requireConfirm(body);
  if (request.method === "POST" && path === "/api/owner/tesla/start") {
    return json({ url: await startTesla(env) });
  }
  if (request.method === "POST" && path === "/api/owner/tesla/finish") {
    const parsed = parsePastedCallback({
      callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
      code: typeof body.code === "string" ? body.code : undefined,
      state: typeof body.state === "string" ? body.state : undefined,
    });
    const name = await finishTesla(env, parsed.code, parsed.state);
    return json({ connected: true, name });
  }
  if (request.method === "POST" && path === "/api/owner/sigen/start") {
    const redirect = `${env.APP_ORIGIN}/sigen/callback`;
    return json({
      url: await startSigen(env),
      redirect,
      note: "If the portal only posts back to loopback, paste the tokens instead.",
    });
  }
  if (request.method === "POST" && path === "/api/owner/sigen/import") {
    const accessToken = stringField(body.accessToken, "access_token");
    const refreshToken = stringField(body.refreshToken, "refresh_token");
    const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : 3600;
    await vault.importTokens("sigen", { accessToken, refreshToken, expiresIn });
    await audit(env.DB, "sigen_import", "ok");
    return json({ connected: true });
  }
  throw new AppError("not_found", 404);
}

async function startTesla(env: Env): Promise<string> {
  const state = bytesToBase64Url(randomBytes(32));
  const verifier = newVerifier();
  await env.DB.prepare("INSERT INTO oauth_pending (state, verifier, provider, expires_at) VALUES (?, ?, 'tesla', ?)")
    .bind(state, verifier, Date.now() + 10 * 60 * 1000)
    .run();
  return buildTeslaAuthorizeUrl(env, state, verifier);
}

async function startSigen(env: Env): Promise<string> {
  const state = bytesToBase64Url(randomBytes(32));
  await env.DB.prepare("INSERT INTO oauth_pending (state, verifier, provider, expires_at) VALUES (?, '', 'sigen', ?)")
    .bind(state, Date.now() + 10 * 60 * 1000)
    .run();
  return sigenAuthorizationUrl(env.SIGEN_LOGIN_URL, state, `${env.APP_ORIGIN}/sigen/callback`, env.SIGEN_REGION);
}

/**
 * One-time owner connect link, minted out of band (only its SHA-256 is stored in D1, 15-minute expiry).
 * Single use: the row is deleted on first visit whether or not it is still valid.
 */
async function ownerConnectLink(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimit(env, `ownerlink:${ip}`, 10, 900))) return new Response("Too many attempts.", { status: 429, headers });
  const provider = url.pathname === "/owner/tesla/connect" ? "tesla" : "sigen";
  const token = url.searchParams.get("t") ?? "";
  if (token.length < 32 || token.length > 128) return new Response("This link is not valid.", { status: 404, headers });
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT expires_at FROM owner_links WHERE token_hash = ? AND provider = ?").bind(hash, provider).first<{ expires_at: number }>();
  if (row) await env.DB.prepare("DELETE FROM owner_links WHERE token_hash = ?").bind(hash).run();
  await env.DB.prepare("DELETE FROM owner_links WHERE expires_at < ?").bind(Date.now()).run();
  if (!row || row.expires_at < Date.now()) return new Response("This link has expired or was already used.", { status: 404, headers });
  await audit(env.DB, `${provider}_owner_link`, "used");
  const target = provider === "tesla" ? await startTesla(env) : await startSigen(env);
  return new Response(null, { status: 302, headers: { ...headers, location: target } });
}

/**
 * Server-to-server import of a Sigen grant made by the official loopback login on the owner's machine.
 * Authorised by a one-time token minted out of band; D1 holds SHA-256("import:" + token) so connect tokens cannot be used here.
 */
async function ownerSigenImport(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimit(env, `ownerlink:${ip}`, 10, 900))) throw new AppError("rate_limited", 429);
  const body = await readJson(request);
  const token = typeof body.t === "string" ? body.t : "";
  if (token.length < 32 || token.length > 128) throw new AppError("not_found", 404);
  const hash = await sha256Hex(`import:${token}`);
  const row = await env.DB.prepare("SELECT expires_at FROM owner_links WHERE token_hash = ? AND provider = 'sigen'").bind(hash).first<{ expires_at: number }>();
  if (row) await env.DB.prepare("DELETE FROM owner_links WHERE token_hash = ?").bind(hash).run();
  if (!row || row.expires_at < Date.now()) throw new AppError("not_found", 404);
  const accessToken = stringField(body.accessToken, "access_token");
  const refreshToken = stringField(body.refreshToken, "refresh_token");
  const expiresIn = typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn : 3600;
  await env.TOKEN_VAULT.getByName("owner").importTokens("sigen", { accessToken, refreshToken, expiresIn });
  await audit(env.DB, "sigen_import", "ok", "owner loopback grant");
  return json({ connected: true });
}

async function finishTesla(env: Env, code: string, state: string): Promise<string> {
  const vault = env.TOKEN_VAULT.getByName("owner");
  const parsed = { code, state };
  const pending = await env.DB.prepare("SELECT verifier, expires_at FROM oauth_pending WHERE state = ? AND provider = 'tesla'")
    .bind(parsed.state)
    .first<{ verifier: string; expires_at: number }>();
  await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ?").bind(parsed.state).run();
  if (!pending || pending.expires_at < Date.now() || !pending.verifier) throw new AppError("oauth_state", 400);
  const tokens = await exchangeTeslaCode(env, parsed.code, pending.verifier);
  if (!tokens.access_token || !tokens.refresh_token) throw new AppError("tesla_token_rejected", 502);
  await vault.importTokens("tesla", {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in ?? 3600,
  });
  const vehicles = parseVehicleList(await teslaJson(env, tokens.access_token, "vehicles"));
  const chosen = chooseVehicle(vehicles, env.VEHICLE_NAME);
  if (!chosen) throw new AppError("no_vehicle", 404);
  await vault.setVehicle({ id: chosen.id, vin: chosen.vin, name: chosen.name || env.VEHICLE_NAME });
  await audit(env.DB, "tesla_connect", "ok", chosen.name || env.VEHICLE_NAME);
  return chosen.name || env.VEHICLE_NAME;
}

/** Tesla returns here. If the state belongs to a pending owner connect, finish it server-side. */
async function teslaCallback(url: URL, env: Env): Promise<Response | null> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  const pending = await env.DB.prepare("SELECT 1 AS ok FROM oauth_pending WHERE state = ? AND provider = 'tesla'").bind(state).first<{ ok: number }>();
  if (!pending) return null;
  let message = "Tesla is connected. Taking you back to the command centre…";
  let ok = true;
  try {
    await finishTesla(env, code, state);
  } catch (error) {
    ok = false;
    const reason = error instanceof AppError ? error.code : "internal";
    message = `Tesla didn't connect (${reason}). Go back to the command centre and press Connect Tesla again.`;
  }
  // An HTML hop (not a 303) so the return to /controls is a same-site navigation and the SameSite=Strict session cookie is sent.
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>White Lotus</title><style>body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#f5f5f5}a{color:#9cf}</style></head><body><p>${message}</p><p><a href="/controls">Open the command centre</a></p>${ok ? '<script>setTimeout(function(){location.replace("/controls?tesla=connected")},800)</script>' : ""}</body></html>`;
  return new Response(html, { status: ok ? 200 : 502, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
}

async function sigenCallback(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const pending = state
    ? await env.DB.prepare("SELECT expires_at FROM oauth_pending WHERE state = ? AND provider = 'sigen'").bind(state).first<{ expires_at: number }>()
    : null;
  if (pending) await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ?").bind(state).run();
  const ok =
    pending &&
    pending.expires_at >= Date.now() &&
    form.get("type") === "sigen.authorization.success" &&
    form.get("version") === "1" &&
    typeof form.get("access_token") === "string" &&
    typeof form.get("refresh_token") === "string";
  if (!ok || !pending) return new Response(sigenPage("Sigen authorization was not accepted."), { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  await env.TOKEN_VAULT.getByName("owner").importTokens("sigen", {
    accessToken: String(form.get("access_token")),
    refreshToken: String(form.get("refresh_token")),
    expiresIn: Number(form.get("expires_in") ?? 3600),
  });
  await audit(env.DB, "sigen_callback", "ok");
  return new Response(sigenPage("Sigen is connected. You can close this tab."), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function controlApi(request: Request, env: Env, path: string): Promise<Response> {
  const plug = env.PLUG_CHARGE.getByName("owner");
  if (request.method === "GET" && path === "/api/controls/state") return json(await controlState(env));
  if (request.method === "GET" && path === "/api/controls/plug-charge") return json(await plug.getState());
  if (request.method === "GET" && path === "/api/controls/map") {
    if (mocksEnabled(env)) {
      const stored = await privateLocation(env.DB);
      const point = stored ?? { ...SAMPLE_POINT, ts: Date.now() };
      return json({ lat: point.lat, lon: point.lon, asOf: new Date(point.ts).toISOString(), sample: !stored });
    }
    const point = await privateLocation(env.DB);
    if (!point) throw new AppError("no_location", 404);
    return json({ lat: point.lat, lon: point.lon, asOf: new Date(point.ts).toISOString(), sample: false });
  }
  const body = await readJson(request);
  requireConfirm(body);
  if (request.method === "POST" && path === "/api/controls/plug-charge") {
    const state = await plug.start();
    await audit(env.DB, "plug_and_charge", state.phase, state.message);
    return json(state);
  }
  if (request.method === "POST" && path === "/api/controls/plug-charge/cancel") {
    const state = await plug.cancel();
    await audit(env.DB, "plug_and_charge", "cancelled");
    return json(state);
  }
  if (request.method === "POST" && path === "/api/controls/charge/start") {
    await chargePower(env, "start");
    await audit(env.DB, "charge_start", "ok");
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/api/controls/charge/stop") {
    await chargePower(env, "stop");
    await audit(env.DB, "charge_stop", "ok");
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/api/controls/tesla/charge-limit") {
    const percent = integer(body.percent, 50, 100);
    if (!mocksEnabled(env)) await sendVehicleCommand(env, setChargeLimit(percent));
    await audit(env.DB, "set_charge_limit", "ok", `${percent}%`);
    return json({ ok: true, percent });
  }
  if (request.method === "POST" && path === "/api/controls/tesla/amps") {
    const amps = integer(body.amps, 1, 48);
    if (!mocksEnabled(env)) await sendVehicleCommand(env, setChargingAmps(amps));
    await audit(env.DB, "set_charging_amps", "ok", `${amps} A`);
    return json({ ok: true, amps });
  }
  if (request.method === "POST" && path === "/api/controls/sigen/charge-soc") {
    const chargeSoc = integer(body.chargeSoc, 0, 100);
    if (!mocksEnabled(env)) {
      const token = await env.TOKEN_VAULT.getByName("owner").accessToken("sigen");
      const current = parseSocSettings(await callSigenTool(env, token, "get_battery_soc_settings", { station_id: stationId(env) }));
      await confirmedSigenWrite(env, token, "set_battery_soc_settings", {
        station_id: stationId(env),
        battery_soc_settings: withChargeSoc(current, chargeSoc),
      });
    }
    await audit(env.DB, "set_charge_soc", "ok", `${chargeSoc.toFixed(1)}%`);
    return json({ ok: true, chargeSoc });
  }
  if (request.method === "POST" && path === "/api/controls/sigen/charger-mode") {
    const mode = body.mode === "fast" || body.mode === "pv_surplus" ? body.mode : null;
    if (!mode) throw new AppError("bad_value");
    if (!mocksEnabled(env)) await setChargerMode(env, mode);
    await audit(env.DB, "set_charger_mode", "ok", mode);
    return json({ ok: true, mode });
  }
  if (request.method === "POST" && path === "/api/controls/climate") {
    if (typeof body.on !== "boolean") throw new AppError("bad_value");
    if (!mocksEnabled(env)) await sendVehicleCommand(env, hvacAuto(body.on));
    await audit(env.DB, body.on ? "climate_on" : "climate_off", "ok");
    return json({ ok: true, on: body.on });
  }
  throw new AppError("not_found", 404);
}

async function controlState(env: Env): Promise<unknown> {
  const snap = await loadSnapshot(env);
  const vehicle = await latestVehicle(env.DB);
  const plug = await env.PLUG_CHARGE.getByName("owner").getState();
  const status = mocksEnabled(env)
    ? { tesla: true, sigen: true, vehicleName: env.VEHICLE_NAME, chargerKnown: true }
    : await env.TOKEN_VAULT.getByName("owner").connectionStatus();
  return {
    dashboard: toPublicDashboard(snap, Date.now()),
    plug,
    settings: {
      chargeLimit: vehicle?.chargeLimitPercent ?? snap.vehicle.chargeLimitPercent ?? 80,
      amps: vehicle?.chargingAmps ?? 32,
      chargeSoc: Number((await readPoll(env.DB, "sigen_charge_soc")) ?? 80),
      mode: (await readPoll(env.DB, "sigen_mode")) ?? "fast",
      climateOn: vehicle?.climateOn ?? false,
    },
    status,
    homeMasked: Boolean(homePoint(env)),
  };
}

async function chargePower(env: Env, action: "start" | "stop"): Promise<void> {
  if (mocksEnabled(env)) return;
  const vault = env.TOKEN_VAULT.getByName("owner");
  const status = await vault.connectionStatus();
  if (!status.tesla && !status.sigen) throw new AppError("not_connected", 409);
  if (status.sigen) {
    const charger = await vault.getCharger();
    const token = await vault.accessToken("sigen");
    await confirmedSigenWrite(env, token, "control_charger_charging", controlChargerArgs(stationId(env), action, charger?.sn));
  }
  if (status.tesla) await sendVehicleCommand(env, action === "start" ? chargeStart() : chargeStop());
}

async function setChargerMode(env: Env, mode: AcChargeMode): Promise<void> {
  const vault = env.TOKEN_VAULT.getByName("owner");
  const charger = await vault.getCharger();
  if (!charger?.sn) throw new AppError("charger_unknown", 409);
  const token = await vault.accessToken("sigen");
  await confirmedSigenWrite(env, token, "set_ac_charge_mode", acChargeModeArgs(stationId(env), charger.sn, mode));
}

async function sessionOrNull(request: Request, env: Env): Promise<{ csrf: string; hash: string } | null> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await readSession(env.DB, hash);
  if (!row || !sessionActive(row.expires_at, Date.now())) return null;
  return { csrf: row.csrf_token, hash };
}

async function requireSession(request: Request, env: Env): Promise<{ csrf: string; hash: string }> {
  const session = await sessionOrNull(request, env);
  if (!session) throw new AppError("unauthenticated", 401);
  return session;
}

async function requireCsrf(request: Request, expected: string): Promise<void> {
  const provided = request.headers.get("x-csrf-token") ?? "";
  if (!(await timingSafeEqualString(provided, expected))) throw new AppError("csrf", 403);
}

function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new AppError("confirmation_required", 400);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_000) throw new AppError("body_too_large", 413);
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError("bad_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("bad_json");
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16000) throw new AppError(code);
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new AppError("bad_value");
  return value;
}

async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const name = `${key}:${slot}`;
  const current = Number((await env.RATE_LIMIT.get(name)) ?? "0");
  if (current >= limit) return false;
  await env.RATE_LIMIT.put(name, String(current + 1), { expirationTtl: windowSec * 2 });
  return true;
}

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { status, headers });
}

function sigenPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sigen</title></head><body style="font-family:system-ui;margin:48px;background:#111;color:#f3ecdf"><h1>${message}</h1></body></html>`;
}
