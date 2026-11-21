import { handleRequest } from "./handler";
import { PlugCharge } from "./objects/plug-charge";
import { TokenVault } from "./objects/token-vault";
import { pollAll } from "./poll";
import { teslaSecretDiagnostic } from "./tesla/oauth";

export { PlugCharge, TokenVault };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollAll(env));
    if (await env.RATE_LIMIT.get("diag:tesla")) {
      await env.RATE_LIMIT.delete("diag:tesla");
      ctx.waitUntil(teslaSecretDiagnostic(env).catch((e) => console.error("tesla_secret_diag_failed", String(e))));
    }
  },
} satisfies ExportedHandler<Env>;
