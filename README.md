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
