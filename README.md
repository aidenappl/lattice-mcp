# lattice-mcp

Model Context Protocol server for [Lattice](https://github.com/aidenappl/lattice-api), the container orchestration platform that runs every `appleby.cloud` service. Gives Claude Code direct, typed access to workers, stacks, containers, deployments, databases, registries, networks, volumes and instance configuration.

> **appleby.cloud platform** · MCP server · published to npm as `lattice-mcp` · consumed via `npx -y lattice-mcp`

---

## Overview

`lattice-mcp` is a single-file Node ESM program (`index.js`) that speaks MCP over stdio and translates tool calls into HTTP requests against the `lattice-api` admin surface. It exposes **125 typed tools** and holds no business logic, caching or state of its own — every behaviour (pagination, validation, side effects) comes from `lattice-api`.

Once configured, ask Claude Code things like:

- "What's the status of all stacks?"
- "Show me logs for the forta-api container"
- "Which containers are unhealthy?" (`lattice_get_anomalies` is the best first call)
- "Deploy stack 5" / "Rollback the last deployment on stack 12"
- "What image tags can I deploy from the registry?"

## Role in the appleby.cloud ecosystem

| Repo | Relationship |
|------|--------------|
| [`lattice-api`](https://github.com/aidenappl/lattice-api) | The API this wraps — its route table is the source of truth for tool coverage. |
| [`lattice-web`](https://github.com/aidenappl/lattice-web) | Next.js dashboard over the same API. |
| [`lattice-runner`](https://github.com/aidenappl/lattice-runner) | Agent on each worker VM; WebSocket back to `lattice-api`. |
| `monitor-mcp` / `forta-mcp` / `keyring-mcp` / `openbucket-mcp` | Sibling MCP servers, same single-file structure. |

## Tech stack

- **Node ≥18** (needs global `fetch` and `AbortSignal.timeout`), ESM (`"type": "module"`).
- **`@modelcontextprotocol/sdk` ^1.29.0** — `McpServer` + `StdioServerTransport`.
- **`zod` ^4.4.3** for argument schemas (a declared dependency as of 1.1.1).
- No build step, no bundler. `node --check index.js` is the only static gate.

## Getting started

### Prerequisites

- Node ≥18.
- A Lattice API URL and API token. Generate a token from the Lattice web dashboard under **Settings > API Tokens**.

### Setup

Quickest — interactive setup writes the `lattice` block into `~/.mcp.json`:

```bash
npx lattice-mcp --setup
```

Or configure it manually in `~/.mcp.json`:

```json
{
  "mcpServers": {
    "lattice": {
      "command": "npx",
      "args": ["-y", "lattice-mcp"],
      "env": {
        "LATTICE_API_URL": "https://lattice-api.appleby.cloud",
        "LATTICE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Restart Claude Code after setup so the new server and tools are picked up.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LATTICE_API_URL` | Yes | Lattice API base URL |
| `LATTICE_API_TOKEN` | Yes | Bearer token for authentication (sent on every request) |

## Development

| Command | What it does |
|---------|--------------|
| `node index.js --setup` | Interactive setup — writes the `lattice` block into `~/.mcp.json` |
| `npm install` | Install dependencies (not vendored) |
| `node --check index.js` | Syntax gate — the only static check that exists |
| `LATTICE_API_URL=… LATTICE_API_TOKEN=… node index.js` | Run the server on stdio |
| `grep -c 'server.tool(' index.js` | Confirm the tool count (should be 125) |
| `npm publish` | Publish to npm — **this is deployment** (requires 2FA passkey from an interactive terminal) |

## Tools

All 125 tools, grouped as they appear in `index.js`. ⚠️ marks destructive tools; their descriptions state the blast radius.

### Overview & health
| Tool | Description |
|------|-------------|
| `lattice_overview` | Fleet overview — worker/stack/container counts, failed stacks, CPU/memory |
| `lattice_health` | API health and database connectivity |

### Workers
| Tool | Description |
|------|-------------|
| `lattice_list_workers` | List workers with status, IP, versions, heartbeat |
| `lattice_get_worker` | Detailed worker info including metrics |
| `lattice_get_worker_metrics` | CPU, memory, disk, network metrics |
| `lattice_reboot_worker` | Reboot a worker machine |
| `lattice_upgrade_worker` | Upgrade worker runner to latest |
| `lattice_stop_all_worker` | Stop all containers on a worker |
| `lattice_start_all_worker` | Start all containers on a worker |

### Stacks
| Tool | Description |
|------|-------------|
| `lattice_list_stacks` | List stacks with status and worker assignment |
| `lattice_get_stack` | Full stack details including compose YAML |
| `lattice_deploy_stack` | Deploy a stack (all or specific containers) |
| `lattice_restart_stack` | Restart all containers in a stack |
| `lattice_stop_stack` | Stop all containers in a stack |
| `lattice_start_stack` | Start all containers in a stack |
| `lattice_update_stack` | Update stack configuration |

### Containers
| Tool | Description |
|------|-------------|
| `lattice_list_containers` | List containers with status, image, ports, health |
| `lattice_get_container` | Full container details |
| `lattice_get_container_logs` | Recent container logs (stdout/stderr) |
| `lattice_get_container_lifecycle` | Lifecycle events (start, stop, health changes) |
| `lattice_start_container` | Start a stopped container |
| `lattice_stop_container` | Stop a running container |
| `lattice_restart_container` | Restart a container |
| `lattice_kill_container` | Force kill a container |
| `lattice_pause_container` | Pause a running container |
| `lattice_unpause_container` | Unpause a paused container |
| `lattice_remove_container` | Remove a container ⚠️ |
| `lattice_recreate_container` | Remove and recreate a container ⚠️ |

### Deployments
| Tool | Description |
|------|-------------|
| `lattice_list_deployments` | List deployments with status and timing |
| `lattice_get_deployment` | Deployment details with container-level status |
| `lattice_get_deployment_logs` | Pull, create, start, swap events with timing |
| `lattice_rollback_deployment` | Rollback to previous state ⚠️ |

### Instance self-update
| Tool | Description |
|------|-------------|
| `lattice_update_api` | Trigger the Lattice API container to self-update |
| `lattice_update_web` | Trigger the Lattice web container to update |

### Audit & API tokens
| Tool | Description |
|------|-------------|
| `lattice_get_audit_log` | Recent audit log entries (who did what, when) |
| `lattice_list_api_tokens` | List API tokens |
| `lattice_create_api_token` | Create a new API token |
| `lattice_delete_api_token` | Delete an API token ⚠️ |

### Database instances
| Tool | Description |
|------|-------------|
| `lattice_list_database_instances` | List managed databases (filter by worker, engine, status) |
| `lattice_get_database_instance` | Full instance config |
| `lattice_create_database_instance` | Provision mysql/mariadb/postgres on a worker |
| `lattice_update_database_instance` | Update config, limits, snapshot schedule |
| `lattice_delete_database_instance` | Delete an instance ⚠️ |
| `lattice_database_action` | start / stop / restart / remove ⚠️ |
| `lattice_get_database_credentials` | Connection credentials (returns secrets) |
| `lattice_list_database_snapshots` | Snapshots for an instance |
| `lattice_create_database_snapshot` | Take a snapshot now |
| `lattice_restore_database_snapshot` | Restore from a snapshot ⚠️ |
| `lattice_delete_database_snapshot` | Delete a snapshot ⚠️ |

### Backup destinations
| Tool | Description |
|------|-------------|
| `lattice_list_backup_destinations` | List backup destinations |
| `lattice_get_backup_destination` | One destination's configuration |
| `lattice_create_backup_destination` | Create a destination |
| `lattice_update_backup_destination` | Update a destination |
| `lattice_delete_backup_destination` | Delete a destination ⚠️ |
| `lattice_test_backup_destination` | Test connectivity without writing a backup (requires a connected `worker_id`) |

### Registries
| Tool | Description |
|------|-------------|
| `lattice_list_registries` | Configured container registries |
| `lattice_create_registry` | Add a registry |
| `lattice_update_registry` | Update a registry |
| `lattice_delete_registry` | Delete a registry ⚠️ |
| `lattice_test_registry` | Test a saved registry's stored credentials |
| `lattice_test_registry_inline` | Test registry credentials before saving |
| `lattice_list_registry_repositories` | What images exist |
| `lattice_list_registry_tags` | **What versions are deployable** |

### Discovery & diagnostics
| Tool | Description |
|------|-------------|
| `lattice_search` | Search workers, stacks and containers in one call |
| `lattice_get_anomalies` | **Restart loops, unhealthy containers, offline workers — best first call** |
| `lattice_get_fleet_metrics` | Aggregated fleet CPU/memory/disk/network |
| `lattice_get_versions` | Runner versions and what's outdated |
| `lattice_refresh_versions` | Re-poll every worker for its current runner version |
| `lattice_get_container_metrics` | Per-container metrics over time |
| `lattice_get_self` | Which user the token authenticates as |

### Stacks — lifecycle, compose & deploy tokens
| Tool | Description |
|------|-------------|
| `lattice_create_stack` | Create an empty stack |
| `lattice_delete_stack` | Delete a stack and all its containers ⚠️ |
| `lattice_get_stack_containers` | Containers in a stack |
| `lattice_update_stack_compose` | Replace a stack's compose YAML |
| `lattice_sync_stack_compose` | Reconcile container records against stored compose YAML |
| `lattice_import_compose` | Create a stack from compose YAML |
| `lattice_export_stack` | Export a stack's full definition as portable JSON |
| `lattice_import_stack_export` | Recreate a stack from an export document |
| `lattice_save_stack_as_template` | Save a stack as a reusable template |
| `lattice_list_deploy_tokens` | CI deploy tokens — `last_used_at` shows whether CI reaches Lattice |
| `lattice_create_deploy_token` | Create a CI deploy token |
| `lattice_delete_deploy_token` | Delete a CI deploy token ⚠️ |
| `lattice_approve_deployment` | Approve a deployment awaiting approval |

### Container definitions
| Tool | Description |
|------|-------------|
| `lattice_create_container` | Add a container definition to a stack |
| `lattice_update_container` | Update a container definition |
| `lattice_delete_container` | Delete definition and its running container ⚠️ |

### Workers — registration, tokens, volumes, networks
| Tool | Description |
|------|-------------|
| `lattice_create_worker` | Register a worker |
| `lattice_update_worker` | Update a worker's name, hostname, IP, status, labels |
| `lattice_delete_worker` | Delete a worker ⚠️ |
| `lattice_get_worker_container_stats` | Live per-container stats from one worker |
| `lattice_list_worker_tokens` | Worker registration tokens |
| `lattice_create_worker_token` | Create a registration token for a worker |
| `lattice_delete_worker_token` | Delete a worker token ⚠️ |
| `lattice_list_worker_volumes` | Docker volumes on a worker |
| `lattice_create_worker_volume` | Create a Docker volume on a worker |
| `lattice_delete_worker_volume` | Delete a Docker volume ⚠️ |
| `lattice_list_worker_networks` | Docker networks on a worker |
| `lattice_create_worker_network` | Create a Docker network on a worker |
| `lattice_delete_worker_network` | Delete a Docker network ⚠️ |
| `lattice_list_all_networks` | Every tracked network across the fleet |
| `lattice_delete_network` | Delete a tracked network by Lattice ID ⚠️ |
| `lattice_force_remove_container` | Force-remove a wedged container ⚠️ |

### Env vars, templates & webhooks
| Tool | Description |
|------|-------------|
| `lattice_list_env_vars` | Global `${VAR}` interpolation values (secrets masked) |
| `lattice_create_env_var` | Create a global environment variable |
| `lattice_update_env_var` | Update a global environment variable |
| `lattice_delete_env_var` | Delete a global environment variable ⚠️ |
| `lattice_list_templates` | Saved stack templates |
| `lattice_create_template` | Create a stack template |
| `lattice_delete_template` | Delete a stack template ⚠️ |
| `lattice_list_webhooks` | Outbound event webhooks |
| `lattice_create_webhook` | Create an outbound webhook |
| `lattice_update_webhook` | Update a webhook |
| `lattice_delete_webhook` | Delete a webhook ⚠️ |
| `lattice_test_webhook` | Send a test payload to a webhook |

### Users & instance configuration
| Tool | Description |
|------|-------------|
| `lattice_list_users` | List Lattice users with roles and status |
| `lattice_create_user` | Create a local Lattice user |
| `lattice_update_user` | Update a user's name, role or active flag ⚠️ |
| `lattice_delete_user` | Delete a Lattice user ⚠️ |
| `lattice_get_sso_config` | Get the Forta SSO configuration |
| `lattice_update_sso_config` | Update SSO config ⚠️ (can lock out SSO users) |
| `lattice_get_smtp_config` | Get the SMTP configuration |
| `lattice_update_smtp_config` | Update the SMTP configuration |
| `lattice_test_smtp` | Send a test email with the saved SMTP config |
| `lattice_get_notification_prefs` | Per-event notification preferences |
| `lattice_update_notification_prefs` | Update notification preferences |

## Project structure

Everything lives in one file:

| Path | Role |
|------|------|
| `index.js` | The whole server: `--setup` flow, config read, `api()` HTTP helper, `text()`/`body()` helpers, all 125 `server.tool(...)` registrations, transport connect. |
| `package.json` | npm metadata; `bin.lattice-mcp` → `index.js`. |
| `AGENTS.md` | Contributor/agent guide — conventions, handler contracts, verification. |
| `README.md` | This file. |

## Deployment

Published to npm as `lattice-mcp` (public). Consumers run `npx -y lattice-mcp`, which resolves the latest published version — so **publishing is deployment**, and a running MCP server must be restarted to pick up a new version. `npm publish` requires 2FA via passkey from an interactive terminal.

## Contributing & further reading

Read [`AGENTS.md`](./AGENTS.md) before changing code — it documents the one-shape tool pattern, the `body()`/`api()` helpers, the "read the handler before adding a tool" rule, and the verification steps. Related repos: [`lattice-api`](https://github.com/aidenappl/lattice-api), [`lattice-web`](https://github.com/aidenappl/lattice-web), [`lattice-runner`](https://github.com/aidenappl/lattice-runner).

## License

MIT
