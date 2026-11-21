import { AppError } from "../lib/errors";
import { SIGEN_PUBLIC_AUTHORIZATION } from "./oauth";
import { assertToolAllowed, findConfirmToken, unwrapToolResult } from "./parse";

export async function refreshSigen(
  env: Env,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(env.SIGEN_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: SIGEN_PUBLIC_AUTHORIZATION,
      "content-type": "application/x-www-form-urlencoded",
      "sigen-region": env.SIGEN_REGION,
      "AUTH-CLIENT-ID": "sigen",
      "sg-pkg": "web",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const payload = (await response.json()) as { code?: number; data?: Record<string, unknown> } & Record<string, unknown>;
  const data = (payload.data ?? payload) as Record<string, unknown>;
  if (!response.ok || (payload.code !== undefined && payload.code !== 0) || typeof data.access_token !== "string") {
    throw new AppError("sigen_refresh_failed", 502);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : refreshToken,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
  };
}

async function mcpPost(env: Env, token: string, body: unknown, sessionId?: string, protocol?: string): Promise<{ message: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-sigen-region": env.SIGEN_REGION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocol) headers["mcp-protocol-version"] = protocol;
  const response = await fetch(env.SIGEN_MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (response.status === 401 || response.status === 403) throw new AppError("sigen_unauthorized", 401);
  const text = await response.text();
  if (!response.ok) throw new AppError(`sigen_${response.status}`, 502);
  const message = parseMcp(text, response.headers.get("content-type") ?? "");
  return { message, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

function parseMcp(text: string, contentType: string): unknown {
  if (!text) return null;
  if (contentType.includes("text/event-stream") || text.startsWith("event:")) {
    const blocks = text.split(/\r?\n\r?\n/);
    let last: unknown = null;
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        last = JSON.parse(data) as unknown;
      } catch {
        // Ignore non-JSON SSE events.
      }
    }
    return last;
  }
  return JSON.parse(text) as unknown;
}

export async function callSigenTool(env: Env, token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  assertToolAllowed(name);
  let id = 1;
  const initialized = await mcpPost(env, token, {
    jsonrpc: "2.0",
    id: id++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "white-lotus", version: "1.0.0" },
    },
  });
  const initMessage = initialized.message as { result?: { protocolVersion?: string }; error?: { message?: string } } | null;
  if (initMessage?.error) throw new AppError("sigen_initialize_failed", 502);
  const protocol = initMessage?.result?.protocolVersion ?? "2025-03-26";
  await mcpPost(env, token, { jsonrpc: "2.0", method: "notifications/initialized" }, initialized.sessionId, protocol);
  const called = await mcpPost(
    env,
    token,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    initialized.sessionId,
    protocol,
  );
  const message = called.message as { result?: unknown; error?: { message?: string } } | null;
  if (message?.error) throw new AppError("sigen_tool_failed", 502);
  return unwrapToolResult(message?.result ?? null);
}

export async function confirmedSigenWrite(
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if ("confirm_token" in args) throw new AppError("confirm_token_not_allowed");
  const preview = await callSigenTool(env, token, name, args);
  const confirmToken = findConfirmToken(preview);
  if (!confirmToken) throw new AppError("missing_confirm_token", 502);
  return callSigenTool(env, token, name, { ...args, confirm_token: confirmToken });
}
