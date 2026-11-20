import { handleRequest } from "./handler";
import { PlugCharge } from "./objects/plug-charge";
import { TokenVault } from "./objects/token-vault";
import { pollAll } from "./poll";

export { PlugCharge, TokenVault };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollAll(env));
  },
} satisfies ExportedHandler<Env>;
