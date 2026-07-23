# lattice-mcp

MCP server for the [Lattice](https://github.com/aidenappl/lattice-api) container orchestration platform. Gives Claude Code direct access to manage workers, stacks, containers, and deployments.

## Quick Start

```bash
npx lattice-mcp --setup
```

This prompts for your Lattice API URL and API token, writes the config to `~/.mcp.json`, and you're ready to go. Restart Claude Code after setup.

## Manual Setup

Add to `~/.mcp.json`:

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

Generate an API token from the Lattice web dashboard under **Settings > API Tokens**.

## Tools

### Overview & Health
| Tool | Description |
|------|-------------|
| `lattice_overview` | Fleet overview — worker counts, stack counts, failed stacks, CPU/memory |
| `lattice_health` | API health and database connectivity |

### Workers
| Tool | Description |
|------|-------------|
| `lattice_list_workers` | List workers with status, IP, versions |
| `lattice_get_worker` | Detailed worker info |
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
| `lattice_update_stack` | Update stack configuration |
| `lattice_deploy_stack` | Deploy a stack (all or specific containers) |
| `lattice_restart_stack` | Restart all containers in a stack |
| `lattice_stop_stack` | Stop all containers in a stack |
| `lattice_start_stack` | Start all containers in a stack |

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
| `lattice_remove_container` | Remove a container |
| `lattice_recreate_container` | Remove and recreate a container |

### Deployments
| Tool | Description |
|------|-------------|
| `lattice_list_deployments` | List deployments with status and timing |
| `lattice_get_deployment` | Deployment details with container-level status |
| `lattice_get_deployment_logs` | Pull, create, start, swap events with timing |
| `lattice_rollback_deployment` | Rollback to previous state |

### System
| Tool | Description |
|------|-------------|
| `lattice_get_audit_log` | Recent audit log entries |
| `lattice_update_api` | Trigger API self-update |
| `lattice_update_web` | Trigger web container update |
| `lattice_list_api_tokens` | List API tokens |
| `lattice_create_api_token` | Create a new API token |
| `lattice_delete_api_token` | Delete an API token |

## Example Prompts

- "What's the status of all stacks?"
- "Show me logs for the forta-api container"
- "Deploy stack 5"
- "Which containers are unhealthy?"
- "Rollback the last deployment on stack 12"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LATTICE_API_URL` | Yes | Lattice API base URL |
| `LATTICE_API_TOKEN` | Yes | API token for authentication |

## License

MIT

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
| `lattice_list_backup_destinations` / `lattice_get_backup_destination` | Inventory |
| `lattice_create_backup_destination` / `lattice_update_backup_destination` | Manage destinations |
| `lattice_delete_backup_destination` | Delete ⚠️ |
| `lattice_test_backup_destination` | Test connectivity without writing a backup |

### Registries
| Tool | Description |
|------|-------------|
| `lattice_list_registries` | Configured registries |
| `lattice_create_registry` / `lattice_update_registry` | Manage registries |
| `lattice_delete_registry` | Delete ⚠️ |
| `lattice_test_registry` / `lattice_test_registry_inline` | Test stored or unsaved credentials |
| `lattice_list_registry_repositories` | What images exist |
| `lattice_list_registry_tags` | **What versions are deployable** |

### Discovery & diagnostics
| Tool | Description |
|------|-------------|
| `lattice_search` | Search workers, stacks and containers in one call |
| `lattice_get_anomalies` | **Restart loops, unhealthy containers, offline workers — best first call** |
| `lattice_get_fleet_metrics` | Aggregated fleet CPU/memory/disk/network |
| `lattice_get_versions` / `lattice_refresh_versions` | Runner versions and what's outdated |
| `lattice_get_container_metrics` | Per-container metrics over time |
| `lattice_get_self` | Which user the token authenticates as |

### Stacks — compose, export & deploy tokens
| Tool | Description |
|------|-------------|
| `lattice_create_stack` / `lattice_delete_stack` | Stack lifecycle ⚠️ |
| `lattice_get_stack_containers` | Containers in a stack |
| `lattice_update_stack_compose` / `lattice_sync_stack_compose` | Compose YAML management |
| `lattice_import_compose` | Create a stack from compose YAML |
| `lattice_export_stack` / `lattice_import_stack_export` | Portable stack backup/restore |
| `lattice_save_stack_as_template` | Save a stack as a reusable template |
| `lattice_list_deploy_tokens` | CI deploy tokens — `last_used_at` shows whether CI reaches Lattice |
| `lattice_create_deploy_token` / `lattice_delete_deploy_token` | Manage CI deploy tokens ⚠️ |
| `lattice_approve_deployment` | Approve a deployment awaiting approval |

### Container definitions
| Tool | Description |
|------|-------------|
| `lattice_create_container` / `lattice_update_container` | Manage container definitions |
| `lattice_delete_container` | Delete definition and container ⚠️ |

### Workers — resources
| Tool | Description |
|------|-------------|
| `lattice_create_worker` / `lattice_update_worker` / `lattice_delete_worker` | Worker registration ⚠️ |
| `lattice_get_worker_container_stats` | Live per-container stats |
| `lattice_list_worker_tokens` / `lattice_create_worker_token` / `lattice_delete_worker_token` | Runner registration tokens ⚠️ |
| `lattice_list_worker_volumes` / `lattice_create_worker_volume` / `lattice_delete_worker_volume` | Docker volumes ⚠️ |
| `lattice_list_worker_networks` / `lattice_create_worker_network` / `lattice_delete_worker_network` | Docker networks ⚠️ |
| `lattice_list_all_networks` / `lattice_delete_network` | Fleet-wide networks ⚠️ |
| `lattice_force_remove_container` | Force-remove a wedged container ⚠️ |

### Env vars, templates & webhooks
| Tool | Description |
|------|-------------|
| `lattice_list_env_vars` / `lattice_create_env_var` / `lattice_update_env_var` / `lattice_delete_env_var` | Global `${VAR}` interpolation values ⚠️ |
| `lattice_list_templates` / `lattice_create_template` / `lattice_delete_template` | Stack templates ⚠️ |
| `lattice_list_webhooks` / `lattice_create_webhook` / `lattice_update_webhook` / `lattice_delete_webhook` / `lattice_test_webhook` | Outbound event webhooks ⚠️ |

### Users & instance configuration
| Tool | Description |
|------|-------------|
| `lattice_list_users` / `lattice_create_user` / `lattice_update_user` / `lattice_delete_user` | User management ⚠️ |
| `lattice_get_sso_config` / `lattice_update_sso_config` | Forta SSO ⚠️ |
| `lattice_get_smtp_config` / `lattice_update_smtp_config` / `lattice_test_smtp` | Alert email |
| `lattice_get_notification_prefs` / `lattice_update_notification_prefs` | Per-event notification prefs |

⚠️ = destructive. Tool descriptions state the blast radius.
