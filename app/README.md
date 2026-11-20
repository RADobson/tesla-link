# White Lotus

A Cloudflare Worker for the house at tesla.dobson.website: Sigenergy solar, home battery, and AC charger, plus Richard's Tesla Model 3, White Lotus.

The GitHub Pages files at the repository root are unchanged. They still host the Tesla Fleet API public key and the OAuth landing page. This Worker can serve those same bytes when the hostname moves off GitHub Pages.

## Architecture

```
browser ──► Worker (app/src/index.ts)
              ├─ /.well-known/.../public-key.pem   exact Pages file
              ├─ /callback                         exact Pages file, no trailing slash
              ├─ /  /login  /controls              dashboard and command centre
              ├─ D1  white-lotus                   history, passkeys, sessions, audit
              ├─ KV  RATE_LIMIT                    login and control rate limits
              ├─ Durable Object TokenVault         refresh tokens, VIN, charger identity, command session
              └─ Durable Object PlugCharge         plug-and-charge listener, alarm every 5s
           cron */5 * * * *
              ├─ Sigen MCP reads
              └─ Tesla vehicle_data only when GET /vehicles/{id} says online
```

Public pages call `GET /api/public/dashboard`. Authenticated pages call `/api/controls/*` and `/api/owner/*`. Integrations are skipped when `MOCK_INTEGRATIONS=true`, which is what `npm run dev` sets. The committed Wrangler config leaves mocks off, so a deploy does not serve the sample house.

### Tesla commands

Charge port, charge start/stop, charge limit, charging amps, and climate are sent as signed Vehicle Command Protocol messages to `POST /api/1/vehicles/{vin}/signed_command`.

Signing is done in the Worker with WebCrypto, not by running Tesla's Go proxy in a container. A container would be a second deployable, would hold the private key outside the isolate, and would not run under `wrangler dev`. The maintained Node clients (Teslemetry's `node-tesla-fleet-api` and `@teslemetry/tesla-protocol`) target Node crypto and a much wider command surface than this house needs. The implementation here follows `teslamotors/vehicle-command` `pkg/protocol/protocol.md`:

- P-256 ECDH, then `K = SHA-1(x)[:16]`
- session-info HMAC over the TLV metadata
- detached AES-GCM when the car sets `SESSION_INFO_FLAG_SUPPORTS_DETACHED_ENCRYPTION`, otherwise HMAC-SHA256
- the command protobuf field numbers from `car_server.proto`

`test/protocol.test.ts` checks the published test vectors: the shared key `1b2fce…`, the session-info tag, the HVAC AES-GCM ciphertext, and the bytes for HVAC, charge start/stop, charge limit, charging amps, and charge-port open. The long-term key is used for ECDH. The car already has the matching public key from the Pages site. Commands wake the car only because a person asked for them. `wake_up` is `POST` with `Content-Type: application/json` and body `{}`.

Polling never calls `wake_up`. It calls `GET /vehicles/{id}` and, only when `state` is `online`, `vehicle_data?endpoints=charge_state;drive_state;location_data;climate_state;vehicle_state`. Asleep cars back off from 10 minutes up to an hour.

Tesla refresh tokens are single-use. `TokenVault` keeps one in-flight refresh per provider and writes the replacement with a compare-and-swap on a version counter. Two overlapping callers share that refresh. A second writer that lost the swap reads the winner instead of spending the token again.

The app has its own OAuth client flow so its refresh token is not shared with any other client. The registered redirect stays `https://tesla.dobson.website/callback` with no trailing slash. That URL still returns the original landing page, which does not send the code anywhere. The owner pastes the callback URL into the command centre, and the Worker exchanges it. That works from workers.dev before DNS moves, because the token request uses the registered redirect, not the Worker's hostname.

### Sigen

Reads and writes go to the official owner MCP at `https://api-aus.sigencloud.com/sigen-mcp/mcp`, station `2610281435597087`. The client speaks Streamable HTTP: `initialize`, `notifications/initialized`, then `tools/call`, and keeps the `mcp-session-id`. `login_with_password` and `api_call` are refused in code.

The catalog checked for this build is `0.1.4-31d58862bc860a90`. Write tools are preview then execute: the same arguments plus `confirm_token`. The UI confirm is required before that round trip. The owner's confirm is what authorises the Worker to complete both phases.

`control_charger_charging` is called as the catalog defines it: `kind: "ac"` and `action: "start" | "stop"`. The tool's own description says the app semantic underneath is `enable=0` to start and `enable=1` to stop. The published schema rejects unknown fields, so the Worker sends `action`, not `enable`. `start` is enable 0. `stop` is enable 1.

`set_ac_charge_mode` uses `pv_surplus` (solar only) or `fast`. It needs the AC charger's serial number, which is read from `get_charger_info` and stored in the token vault. It is never returned by a public API. `set_battery_soc_settings` reads the current settings and changes only `chargeSOC`, formatted like `80.0`.

The public catalog and the portal bundle were fetched while building this. The portal's redirect behaviour is still a hypothesis. The official client posts the result to a loopback URL placed in the fragment (`#redirect_uri=`). The minified portal script does not show an allowlist that would prove an https Worker URL is accepted. The Worker therefore does both:

- `POST /sigen/callback` accepts `type=sigen.authorization.success` when `state` matches a pending owner login
- `POST /api/owner/sigen/import` stores an access token and refresh token the owner pastes, which is the path that does not depend on the portal accepting this host

Sigen's refresh may reuse the same refresh token. Tesla's must rotate. Both go through the same lock.

### Solar score

Kilometres are the sum of positive odometer steps for the calendar week in `Australia/Sydney`. Tesla reports miles; they are converted to kilometres. Charging energy is estimated from successive samples: live solar left after the rest of the house is counted as solar, and the rest of the charger draw is counted as grid only up to the measured grid import. Battery energy is neither. Dollars saved are solar kilowatt-hours times `GRID_PRICE_PER_KWH` (default 0.35 AUD). It is an estimate of avoided grid purchases, not a tariff bill.

### Map

Public responses snap the car to the centre of a 0.2° cell and draw a 20 km radius. If that centre would sit on the raw point, or within 500 m of the configured home, it is shifted by one cell. A delayed trail drops anything newer than 24 hours and anything within 2 km of home. Exact `lat`/`lon` exist only on `GET /api/controls/map`, which requires a session. The preview route that shows a sample coordinate exists only while mocks are on.

## Security model

- One owner. The first passkey may be created only when the credentials table is empty. If `SETUP_CODE` is set, that first registration must present it. After one passkey exists, registration returns `registration_locked` even with the setup code.
- Sessions last two hours. The cookie is `wl_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. The database stores a SHA-256 of the cookie value. A separate CSRF token is returned to the page and required as `X-CSRF-Token` on every authenticated POST. Comparison hashes both strings and then compares the digests.
- Every control POST also requires `confirm: true`. The buttons open a confirm dialog before they send that flag.
- Login attempts are limited to 20 per five minutes per IP. Control and owner writes are limited to 40 per five minutes per session. Counters live in KV.
- Every control is appended to `audit_log` with the action and outcome. Tokens, the VIN, and the charger serial are not written there.
- Public JSON is built by copying named fields. A key scan rejects `vin`, tokens, latitude, longitude, and serial-number names before the response is sent. Query strings are redacted in Workers logs because `/callback` carries an OAuth code.
- The private key, Tesla client secret, setup code, and home coordinates are Worker secrets. They are not in this repository.

`/preview/controls` renders the command centre with sample data and does not call the car. It returns 404 unless `MOCK_INTEGRATIONS` is `true`. Do not deploy the dev override.

## Local mock

```bash
cd app
npm install
npm test
npm run dev
```

Open http://localhost:8787 for the public dashboard and http://localhost:8787/preview/controls for the command centre. Passkeys use `localhost` as the relying party, so use that host rather than `127.0.0.1`. The dev script applies the local D1 migration and turns mocks on. No Cloudflare resources are created.

`npm test` covers registration lock and session cookies, refresh-token single flight and compare-and-swap, the plug-and-charge state machine, location fuzzing, the Tesla protocol vectors, and the solar-score and Sigen argument builders.

## Resources to create

Do this in the Cloudflare account before the first real deploy. The ids below in `wrangler.jsonc` are placeholders so a deploy cannot silently provision them.

| Binding | Kind | Name to create |
| --- | --- | --- |
| `DB` | D1 | `white-lotus` |
| `RATE_LIMIT` | KV namespace | `white-lotus-rate-limit` |
| `TOKEN_VAULT` | Durable Object class `TokenVault` | SQLite-backed, migration tag `v1` |
| `PLUG_CHARGE` | Durable Object class `PlugCharge` | SQLite-backed, same migration |

```bash
cd app
npx wrangler d1 create white-lotus
npx wrangler kv namespace create white-lotus-rate-limit
```

Put the printed D1 `database_id` and KV `id` into `app/wrangler.jsonc`. The Durable Object classes do not need a separate id. The `migrations` entry in the config creates the SQLite classes on first deploy. Then apply the schema to the remote database:

```bash
npx wrangler d1 migrations apply DB --remote
```

### Secrets

Set each one with `npx wrangler secret put NAME`. Do not pass the value on the command line if it would land in shell history. Wrangler can read stdin.

| Secret | What it is |
| --- | --- |
| `TESLA_CLIENT_SECRET` | Fleet API client secret for client id `1b46453e-986c-4013-aa41-22caa1c5ee6c` |
| `TESLA_PRIVATE_KEY` | P-256 PEM matching the public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. `BEGIN EC PRIVATE KEY` or `BEGIN PRIVATE KEY` |
| `SETUP_CODE` | One-time code required for the first passkey. After that passkey exists, registration stays locked |
| `HOME_LATITUDE` | Decimal degrees, used only to mask the public map. Leave unset to skip the home mask |
| `HOME_LONGITUDE` | Decimal degrees, same purpose |

Non-secret vars are already in `wrangler.jsonc`: Tesla and Sigen URLs, the station id, the vehicle display name, the 0.35 AUD/kWh price, `Australia/Sydney`, and the registered redirect `https://tesla.dobson.website/callback`.

## Deploy

### 1. workers.dev

From `app/`, after the ids and secrets above exist:

```bash
npx wrangler deploy
```

Wrangler prints `https://white-lotus.<account>.workers.dev`. Mocks are off. The public dashboard is empty until the cron has stored samples and Sigen is connected. Tesla sign-in still redirects to `https://tesla.dobson.website/callback` on GitHub Pages. Paste that callback URL into the workers.dev command centre. The token exchange uses the registered redirect, so this works before DNS changes.

The workers.dev hostname is not the passkey relying party in the committed config (`RP_ID` is `tesla.dobson.website`). Create the passkey after the custom domain is live, or temporarily set `RP_ID` and `APP_ORIGIN` to the workers.dev host for a trial and then register again on the real domain.

### 2. tesla.dobson.website

DNS for dobson.website is at Namecheap (`registrar-servers.com`). `tesla` is a CNAME to `radobson.github.io`, which is what serves the public key and `/callback` today.

A Worker custom domain needs the zone on the same Cloudflare account. The practical order:

1. Add `dobson.website` to Cloudflare and, at Namecheap, point the domain's nameservers at the two Cloudflare nameservers. Keep the existing records, including the `tesla` CNAME, until the Worker is ready.
2. In `app/wrangler.jsonc`, add a route only when you are ready to cut over:

   ```jsonc
   "routes": [{ "pattern": "tesla.dobson.website", "custom_domain": true }]
   ```

3. `npx wrangler deploy`. Cloudflare will serve `tesla.dobson.website` from the Worker. Remove or stop using the GitHub Pages CNAME at that point. The Worker answers `/.well-known/appspecific/com.tesla.3p.public-key.pem` with the same bytes, and `/callback` with the same HTML and a 200 (no redirect that would add a slash).
4. Register the passkey on `https://tesla.dobson.website/login`, then connect Tesla and Sigen from the command centre.

Until that cutover, leave the CNAME pointed at GitHub Pages. The public key must stay where Tesla fetches it.

## Pages files

These stay at the repository root and are what GitHub Pages serves now:

- `.well-known/appspecific/com.tesla.3p.public-key.pem`
- `callback/index.html` at `https://tesla.dobson.website/callback`
- `index.html`, `CNAME`, `.nojekyll`

The Worker imports the key and the callback page. A local check during development compared the responses to those files byte for byte.
