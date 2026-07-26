# AGENTS.md — lattice-mcp

> `lattice-mcp` is the **Model Context Protocol server for Lattice**, the container
> orchestration platform that runs every `appleby.cloud` service. It exposes the
> `lattice-api` admin surface to Claude Code as **126 typed tools** — workers, stacks,
> containers, deployments, databases, registries, networks, volumes and instance config.
> This file orients any agent/worker before touching code in this repo.
>
> **⚠️ Golden rule — keep this file current:** any change that adds, removes or retypes a
> tool, changes the auth model, or drifts from `lattice-api`'s route surface MUST update this
> AGENTS.md in the SAME change. Stale context here misleads every future agent. If you finish
> work and haven't touched AGENTS.md, confirm that's actually correct.

---

## What this repo is

A single-file Node ESM program (`index.js`, ~1,180 lines) that speaks MCP over stdio and
translates tool calls into HTTP requests against `lattice-api`. It is published to npm as
`lattice-mcp` and consumed via `npx -y lattice-mcp` from `~/.mcp.json`.

It owns **only the translation layer**: tool names, argument schemas, descriptions, and URL
construction. It holds no business logic, no caching, and no state. Every behaviour an agent
observes — pagination limits, validation messages, side effects — comes from `lattice-api`.

It does **not** own: the Lattice data model, deployment mechanics, or the worker protocol.
Those live in [`lattice-api`](https://github.com/aidenappl/lattice-api) and
[`lattice-runner`](https://github.com/aidenappl/lattice-runner).

## Stack & dependencies

- **Runtime:** Node ≥18 (needs global `fetch` and `AbortSignal.timeout`). `"type": "module"` —
  ESM only, top-level `await` is used at the bottom of `index.js`.
- **`@modelcontextprotocol/sdk` ^1.29.0** — `McpServer` + `StdioServerTransport`.
- **`zod` ^4.4.3** — argument schemas. Declared explicitly as of **1.1.1** (it was previously
  only resolved transitively through the MCP SDK, a latent fragility); the range matches the
  version the SDK resolves.
- No build step, no bundler, no tests, no lint config. `node --check index.js` is the only
  static gate.

## Project structure

| Path | Role |
|------|------|
| `index.js` | Everything: `--setup` flow, config read, `api()` HTTP helper, `text()`/`body()` helpers, all 126 `server.tool(...)` registrations, transport connect. |
| `package.json` | npm metadata. `bin.lattice-mcp` → `index.js`, so `npx lattice-mcp` works. |
| `README.md` | User-facing setup + full tool table. |
| `AGENTS.md` | This file. |

`index.js` is organised top-to-bottom as: setup block → config/guard → helpers → tools grouped
by domain under `// ───` banner comments → transport. **Keep new tools inside the matching
banner group**; do not append to the bottom.

## Running, building & testing

There is no `Devfile.yaml` and no `dev` CLI wiring here — it is a single script.

```bash
node --check index.js          # syntax gate — the only static check that exists
npm install                    # needed before running locally (deps are not vendored)
node index.js --setup          # interactive: writes the lattice block into ~/.mcp.json
LATTICE_API_URL=... LATTICE_API_TOKEN=... node index.js   # run the server on stdio
```

**Smoke-testing without an MCP client.** The server speaks JSON-RPC over stdio, so you can
drive it with a shell pipeline. This is the standard way to verify a change registers cleanly:

```bash
{ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
  sleep 2
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 2; } | LATTICE_API_URL=x LATTICE_API_TOKEN=x node index.js
```

The `sleep`s matter — without them the requests race the handshake and you get nothing back.
For a live call, swap `tools/list` for
`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lattice_get_anomalies","arguments":{}}}`
and supply the real token.

## How code is written here

- **Every tool follows one shape.** Deviating makes the file harder to scan:
  ```js
  server.tool("lattice_<verb>_<noun>", "<description>", { /* zod schema */ }, async (args) => {
      const res = await api("<METHOD>", `/admin/<path>`, params, body);
      return { content: text(res) };
  });
  ```
- **Naming:** `lattice_` prefix on every tool, then `list|get|create|update|delete|<verb>` then
  the noun (`lattice_list_database_instances`). The prefix is what disambiguates these from
  `monitor_*` and `forta_*` tools in a shared client.
- **`api(method, path, params, body)`** — `params` become query string entries (undefined/null
  are dropped), `body` is JSON-encoded. Failures are returned as tool output, never thrown, so
  they surface to the agent rather than crashing the transport. A network-level failure returns
  `{success:false, error_message: "API request failed: …"}`; a response that arrives but is not
  JSON (e.g. a 502/504 HTML page from the TLS proxy) returns
  `{success:false, error_code: <http status>, error_message: "API returned a non-JSON response …"}`
  with a truncated body — bodies are never logged, only returned, since they can carry secrets.
- **`body(obj)`** strips `undefined` keys. **Always use it on PUT/PATCH tools.** The API treats
  a present-but-null field as an explicit clear, so forwarding raw `{...fields}` on an update
  would wipe every field the caller didn't pass.
- **Path params are template literals**, query params go through the `params` argument. Never
  hand-concatenate a query string.
- **Descriptions are the contract.** An agent picks tools from the description alone, so it
  must state what the tool does, when to reach for it, and — for anything destructive — the
  blast radius. Compare `lattice_stop_container` ("stops it") with `lattice_delete_container`
  ("Destructive — lattice_stop_container only stops it").
- **Read the handler before adding a tool.** Struct field names are not the request contract;
  handlers frequently override or ignore them. Two live examples from `lattice-api`:
  `HandleUpdateCompose` has a `containerConfigFingerprint` helper with short JSON keys
  (`i`, `t`, `pm`) that is **not** the request body — the body is just `{compose_yaml}`; and
  `HandleDatabaseAction` derives its action from the **last URL path segment**, not from a body
  field.

## Domain & architecture

**Auth.** A single long-lived bearer token (`LATTICE_API_TOKEN`) from
`lattice-api`'s `/admin/api-tokens`, sent on every request. There is no refresh, no expiry
handling, and no login flow. A 401 means the token was revoked or expired — the fix is a new
token via `--setup`, not a code change.

**Config.** Read once at startup from `LATTICE_API_URL` and `LATTICE_API_TOKEN`; the process
exits immediately if either is missing. In practice these come from the `env` block of the
`lattice` entry in `~/.mcp.json`.

**Tool groups**, in file order:

The counts below sum to **126**, matching the header and `grep -c 'server.tool(' index.js`. The
first rows are the original, pre-`1.1.0` tools (registered top-of-file with no banner comment);
every bolded row corresponds to a `// ───` banner group and matches its exact in-file name.

| Group | Tools | Notes |
|-------|-------|-------|
| Overview & health | 3 | `lattice_overview`, `lattice_health`, `lattice_get_version` |
| Workers | 3 + 4 actions | list/get/metrics; reboot, upgrade, stop-all, start-all |
| Stacks | 2 + 5 actions | list/get; deploy, restart, stop, start, update |
| Containers | 4 + 8 actions | list/get/logs/lifecycle; start, stop, restart, kill, pause, unpause, remove, recreate. (`lattice_get_container_metrics` is *not* here — it lives under **Discovery & diagnostics**.) |
| Deployments | 4 | list/get/logs, rollback. (`lattice_approve_deployment` is *not* here — it lives under **Stacks — lifecycle, compose & deploy tokens**.) |
| Instance self-update | 2 | `lattice_update_api`, `lattice_update_web` — tell the API/web container to pull its latest image and redeploy itself |
| Audit & API tokens | 4 | `lattice_get_audit_log`; API token list/create/delete |
| **Database instances** | **11** | CRUD, `lattice_database_action` (start/stop/restart/remove enum), `lattice_get_database_credentials`, snapshot list/create/restore/delete |
| **Backup destinations** | **6** | list/get/create/update/delete + `lattice_test_backup_destination` |
| **Registries** | **8** | list/create/update/delete, `lattice_test_registry`, `lattice_test_registry_inline`, `lattice_list_registry_repositories`, `lattice_list_registry_tags` |
| **Discovery & diagnostics** | **7** | `lattice_search`, `lattice_get_anomalies`, `lattice_get_fleet_metrics`, `lattice_get_versions`, `lattice_refresh_versions`, `lattice_get_container_metrics`, `lattice_get_self` |
| **Stacks — lifecycle, compose & deploy tokens** | **13** | create/delete, `lattice_get_stack_containers`, compose update/sync/import, export/import, `lattice_save_stack_as_template`, deploy-token list/create/delete, `lattice_approve_deployment` |
| **Containers — definition CRUD** | **3** | `lattice_create_container`, `lattice_update_container`, `lattice_delete_container` |
| **Workers — registration, tokens, volumes, networks** | **16** | worker create/update/delete, `lattice_get_worker_container_stats`, worker-token ×3, volume ×3, worker-network ×3, `lattice_list_all_networks`, `lattice_delete_network`, `lattice_force_remove_container` |
| **Global env vars, templates, webhooks** | **12** | env-var CRUD (4), template list/create/delete (3), webhook list/create/update/delete/test (5) |
| **Users & instance configuration** | **11** | user CRUD (4); SSO get/update (2); SMTP get/update/test (3); notification-prefs get/update (2) |

Bolded groups were added in **1.1.0**, closing a gap where the MCP had drifted roughly two
months behind `lattice-api` — database instances shipped in the API in May 2026 and were
entirely unreachable from the MCP until then.

**1.1.1** is a bug-fix release (no tool count change). It corrects three request-shape/route bugs
verified against `lattice-api` handlers: `lattice_get_self` now calls `GET /auth/self` (the old
`GET /admin/self` route never existed and always 404'd — the endpoint is `HandleAuthSelf` on the
bearer-authed `/auth` subrouter); `lattice_force_remove_container` now sends `{container_name}` in
the JSON body (`HandleForceRemoveContainer` reads it there, not from query params, so the old call
always 400'd); and `lattice_test_backup_destination` now marks `worker_id` as **required** (a query
param the handler 400s without — the test dispatches over the worker's WebSocket). It also hardens
`api()` against non-JSON responses (see *How code is written here*) and declares `zod` explicitly.

**1.1.2** adds `lattice_get_version` (`GET /version`, so agents can read the deployed API version
for deploy-drift checks without shelling out to `curl`), and widens two read tools to pass filter
params the handlers already accept but the tools were dropping: `lattice_get_audit_log` gains
`user_id` / `action` / `resource_type` / `offset` (answer "who deleted stack X" server-side instead
of scanning 50 rows), and `lattice_get_container_logs` gains `offset` / `worker_id`. Tool count 125 → 126.

**Consolidations.** Where `lattice-api` exposes several paths served by one handler, this repo
exposes one tool with an enum rather than N tools. `lattice_database_action` covers
`/start`, `/stop`, `/restart` and `/remove`. Worker actions are the historical exception — they
predate this convention and remain separate tools.

## Ecosystem & related repos

| Repo | Relationship |
|------|--------------|
| [`lattice-api`](https://github.com/aidenappl/lattice-api) | The API this wraps. Its `main.go` route table is the source of truth for coverage. |
| [`lattice-web`](https://github.com/aidenappl/lattice-web) | Next.js dashboard over the same API. |
| [`lattice-runner`](https://github.com/aidenappl/lattice-runner) | Agent on each worker VM; WebSocket back to `lattice-api`. |
| [`monitor-mcp`](https://github.com/aidenappl/monitor-mcp) | Sibling MCP, same single-file structure — keep them stylistically aligned. |
| `forta-mcp` / `keyring-mcp` / `openbucket-mcp` | Newer siblings; they carry a `body()` helper and destructive-blast-radius descriptions that originated here. |

## Operations

- **Published to npm** as `lattice-mcp` (public). Consumers run `npx -y lattice-mcp`, which
  resolves the latest published version — so **publishing is deployment**. A bug shipped to npm
  reaches every user on their next MCP server start.
- **Publishing requires 2FA via passkey.** `npm publish` must run from an interactive terminal:
  npm's web auth flow needs to open a browser, and from a non-TTY subprocess it degrades to
  demanding an OTP that a passkey-only account cannot produce.
- **In-session staleness:** a running MCP server process does not pick up a new npm version.
  After publishing, the client must be restarted before the new tools/schemas appear.
- **Common failure modes:**
  - *All tools return `API request failed: fetch failed`* — `LATTICE_API_URL` is wrong or the
    TLS proxy in front of Lattice has an expired cert.
  - *All tools return 401* — token revoked or expired; re-run `--setup`.
  - *One tool 404s while others work* — the MCP is ahead of the deployed `lattice-api`, or the
    route moved.

## Rules & guardrails

- **Never hardcode a token, URL or hostname.** Everything comes from env.
- **Never log request or response bodies.** Responses routinely contain env vars, registry
  credentials and database passwords. `lattice_get_database_credentials` returns live secrets
  by design — do not add convenience logging anywhere in `api()`.
- **Never add a tool without reading its handler in `lattice-api`.** Inferring a request shape
  from a struct has produced real, shipped bugs across this family of servers.
- **Do not break tool names.** They are a public contract: renaming one silently breaks any
  saved workflow or prompt that referenced it. Add a new tool and deprecate in the description
  instead.
- **`zod` is declared explicitly** in `package.json` (`^4.4.3`) as of **1.1.1**. It used to
  resolve only transitively through the MCP SDK, which meant a SDK change that dropped or hoisted
  it differently would break every tool schema at startup. Keep the declared range aligned with
  the version the SDK actually resolves (check `package-lock.json`).
- **Keep destructive descriptions honest.** If a tool destroys data, the description must say so
  and name the safer alternative.
- Publishing is outward-facing and effectively irreversible (npm unpublish is restricted after
  72 hours) — do not publish without explicit instruction.

## Verification — always before "done"

```bash
node --check index.js                      # must pass
grep -c 'server.tool(' index.js            # tool count matches what you expect
```

Then the stdio handshake from *Running, building & testing* above, asserting:
- the server registers **without stderr output**,
- the tool count is what you expect,
- **no duplicate tool names** (`server.tool` silently accepts a duplicate; the last registration
  wins and the earlier tool disappears — this will not error).

For any tool you added or changed, make **one real call against the live API** and confirm the
response shape. Schema-only verification is not enough: it catches typos, not wrong units,
wrong enum values, or parameters the handler ignores.

**Never report work complete on the strength of `tools/list` alone.**

## Keeping this file updated

Update this AGENTS.md in the same change when you:
- **Add/remove/rename a tool** → update the tool-group table and the count in the header.
- **Change the auth model or config vars** → update *Domain & architecture*.
- **Change the `api()`/`body()`/`text()` helpers** → update *How code is written here*.
- **Bump the version or publish** → note behavioural changes under the relevant group.
- **Notice `lattice-api` has gained routes** → either add the tools or record the gap here
  explicitly, so the next agent knows it was a decision and not an oversight.
- Also keep `README.md`'s tool tables in sync — it is the user-facing surface and drifts fastest.
