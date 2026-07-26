#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Interactive setup ---

if (process.argv.includes("--setup")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    console.log("\n  Lattice MCP Setup\n");

    const apiUrl = (await ask("  Lattice API URL (https://lattice-api.appleby.cloud): ")).trim() || "https://lattice-api.appleby.cloud";
    const apiToken = (await ask("  Lattice API Token: ")).trim();
    rl.close();

    if (!apiToken) {
        console.error("\n  Error: API token is required.\n");
        process.exit(1);
    }

    const mcpPath = join(homedir(), ".mcp.json");
    let config = { mcpServers: {} };
    if (existsSync(mcpPath)) {
        try { config = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch {}
        if (!config.mcpServers) config.mcpServers = {};
    }

    config.mcpServers.lattice = {
        command: "npx",
        args: ["-y", "lattice-mcp"],
        env: {
            LATTICE_API_URL: apiUrl,
            LATTICE_API_TOKEN: apiToken,
        },
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n  Written to ${mcpPath}`);
    console.log("  Restart Claude Code to load the Lattice MCP server.\n");
    process.exit(0);
}

// --- MCP Server ---

const API_URL = process.env.LATTICE_API_URL;
const API_TOKEN = process.env.LATTICE_API_TOKEN;

if (!API_URL || !API_TOKEN) {
    console.error("LATTICE_API_URL and LATTICE_API_TOKEN are required.");
    console.error("Run `npx lattice-mcp --setup` to configure.");
    process.exit(1);
}

// --- HTTP helper ---

async function api(method, path, params, body) {
    const url = new URL(path, API_URL);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
    }
    const opts = {
        method,
        headers: {
            Authorization: `Bearer ${API_TOKEN}`,
        },
        signal: AbortSignal.timeout(30000),
    };
    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(url.toString(), opts);
    } catch (err) {
        // Network-level failure (DNS, connection refused, timeout) — no response at all.
        return { success: false, error: err.message, error_message: `API request failed: ${err.message}` };
    }
    // Response arrived. Read the body once as text, then try to parse it as JSON.
    // On parse failure surface the HTTP status and a truncated text body rather than
    // an opaque parse error — a 502/504 HTML page from the TLS proxy lands here.
    // Never log bodies anywhere; responses can carry secrets.
    const raw = await res.text();
    try {
        return JSON.parse(raw);
    } catch {
        return {
            success: false,
            error_code: res.status,
            error_message: `API returned a non-JSON response (HTTP ${res.status})${raw ? `: ${raw.slice(0, 500)}` : ""}`,
        };
    }
}

function text(data) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

// Strips undefined keys so a PUT only sends the fields the caller supplied —
// the API treats a present-but-null field as an explicit clear.
function body(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// --- MCP Server ---

const server = new McpServer({
    name: "lattice",
    version: "1.1.2",
});

// Overview
server.tool("lattice_overview", "Get fleet overview: worker counts, stack counts, container counts, failed stacks, recent deployments, fleet CPU/memory averages", {}, async () => {
    const res = await api("GET", "/admin/overview");
    return { content: text(res) };
});

// Healthcheck
server.tool("lattice_health", "Check API health and database connectivity", {}, async () => {
    const res = await api("GET", "/healthcheck");
    return { content: text(res) };
});

// Version
server.tool("lattice_get_version", "Get the deployed lattice-api version string. Use to check deploy drift against GitHub tags/commits (e.g. for /howfarbehind).", {}, async () => {
    const res = await api("GET", "/version");
    return { content: text(res) };
});

// Workers
server.tool("lattice_list_workers", "List all workers with status, IP, Docker version, runner version, last heartbeat", {
    status: z.enum(["online", "offline", "disconnected"]).optional().describe("Filter by worker status"),
}, async ({ status }) => {
    const res = await api("GET", "/admin/workers", { status });
    return { content: text(res) };
});

server.tool("lattice_get_worker", "Get detailed worker info including metrics", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/workers/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_worker_metrics", "Get recent worker metrics (CPU, memory, disk, network)", {
    id: z.number().describe("Worker ID"),
    range: z.string().optional().describe("Time range (e.g. '1h', '6h', '24h')"),
}, async ({ id, range }) => {
    const res = await api("GET", `/admin/workers/${id}/metrics`, { range });
    return { content: text(res) };
});

// Stacks
server.tool("lattice_list_stacks", "List all stacks with status, worker assignment, and deployment strategy", {
    status: z.string().optional().describe("Filter by status (deployed, deploying, failed, error)"),
    worker_id: z.number().optional().describe("Filter by worker ID"),
}, async ({ status, worker_id }) => {
    const res = await api("GET", "/admin/stacks", { status, worker_id });
    return { content: text(res) };
});

server.tool("lattice_get_stack", "Get full stack details including compose YAML and env vars", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/stacks/${id}`);
    return { content: text(res) };
});

// Containers
server.tool("lattice_list_containers", "List containers with status, image, ports, health. Filter by stack or status", {
    stack_id: z.number().optional().describe("Filter by stack ID"),
    worker_id: z.number().optional().describe("Filter by worker ID"),
    status: z.string().optional().describe("Filter by status (running, stopped, pending, paused)"),
    name: z.string().optional().describe("Filter by container name"),
}, async ({ stack_id, worker_id, status, name }) => {
    const res = await api("GET", "/admin/containers", { stack_id, worker_id, status, name });
    return { content: text(res) };
});

server.tool("lattice_get_container", "Get full container details including config, health, env vars, ports", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/containers/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_container_logs", "Get recent container logs (stdout/stderr)", {
    id: z.number().describe("Container ID"),
    limit: z.number().optional().describe("Number of log lines (default 50)"),
    offset: z.number().optional().describe("Skip this many lines — paginate past the tail into older logs"),
    stream: z.enum(["stdout", "stderr"]).optional().describe("Filter by stream"),
    worker_id: z.number().optional().describe("Filter by worker ID"),
}, async ({ id, limit, offset, stream, worker_id }) => {
    const res = await api("GET", `/admin/containers/${id}/logs`, { limit, offset, stream, worker_id });
    return { content: text(res) };
});

server.tool("lattice_get_container_lifecycle", "Get container lifecycle events (start, stop, restart, health changes)", {
    id: z.number().describe("Container ID"),
    limit: z.number().optional().describe("Number of events (default 50)"),
}, async ({ id, limit }) => {
    const res = await api("GET", `/admin/containers/${id}/lifecycle`, { limit });
    return { content: text(res) };
});

// Deployments
server.tool("lattice_list_deployments", "List deployments with status, strategy, timing. Filter by stack or status", {
    stack_id: z.number().optional().describe("Filter by stack ID"),
    status: z.string().optional().describe("Filter by status (pending, deploying, deployed, failed, rolled_back)"),
    limit: z.number().optional().describe("Number of deployments (default 50)"),
}, async ({ stack_id, status, limit }) => {
    const res = await api("GET", "/admin/deployments", { stack_id, status, limit });
    return { content: text(res) };
});

server.tool("lattice_get_deployment", "Get deployment details including container-level status", {
    id: z.number().describe("Deployment ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/deployments/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_deployment_logs", "Get deployment logs: pull, create, start, swap, rollback events with timing", {
    id: z.number().describe("Deployment ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/deployments/${id}/logs`);
    return { content: text(res) };
});

// Audit log
server.tool("lattice_get_audit_log", "Get recent audit log entries (who did what, when). Filter by user, action, or resource type to answer 'who deleted X' without scanning.", {
    limit: z.number().optional().describe("Number of entries (default 50)"),
    offset: z.number().optional().describe("Skip this many entries for pagination"),
    user_id: z.number().optional().describe("Filter by the user who performed the action"),
    action: z.string().optional().describe("Filter by action (e.g. create, update, delete, deploy)"),
    resource_type: z.string().optional().describe("Filter by resource type (e.g. stack, container, worker, registry)"),
}, async ({ limit, offset, user_id, action, resource_type }) => {
    const res = await api("GET", "/admin/audit-log", { limit, offset, user_id, action, resource_type });
    return { content: text(res) };
});

// Stack actions
server.tool("lattice_deploy_stack", "Deploy a stack (all containers or specific ones)", {
    id: z.number().describe("Stack ID"),
    container_ids: z.array(z.number()).optional().describe("Specific container IDs to deploy (omit for all)"),
    force: z.boolean().optional().describe("Force redeploy — removes all containers and recreates from scratch"),
}, async ({ id, container_ids, force }) => {
    const body = {};
    if (container_ids?.length) body.container_ids = container_ids;
    if (force) body.force = true;
    const res = await api("POST", `/admin/stacks/${id}/deploy`, null, body);
    return { content: text(res) };
});

server.tool("lattice_restart_stack", "Restart all containers in a stack", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/stacks/${id}/restart-all`);
    return { content: text(res) };
});

server.tool("lattice_stop_stack", "Stop all containers in a stack", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/stacks/${id}/stop-all`);
    return { content: text(res) };
});

server.tool("lattice_start_stack", "Start all containers in a stack", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/stacks/${id}/start-all`);
    return { content: text(res) };
});

server.tool("lattice_update_stack", "Update stack configuration (name, description, strategy, worker, etc.)", {
    id: z.number().describe("Stack ID"),
    status: z.string().optional().describe("Stack status"),
    name: z.string().optional().describe("Stack name"),
    description: z.string().optional().describe("Stack description"),
    deployment_strategy: z.string().optional().describe("Deployment strategy"),
    worker_id: z.number().optional().describe("Assigned worker ID"),
    auto_deploy: z.boolean().optional().describe("Enable auto-deploy on image push"),
    active: z.boolean().optional().describe("Whether the stack is active"),
}, async ({ id, status, name, description, deployment_strategy, worker_id, auto_deploy, active }) => {
    const body = {};
    if (status !== undefined) body.status = status;
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (deployment_strategy !== undefined) body.deployment_strategy = deployment_strategy;
    if (worker_id !== undefined) body.worker_id = worker_id;
    if (auto_deploy !== undefined) body.auto_deploy = auto_deploy;
    if (active !== undefined) body.active = active;
    const res = await api("PUT", `/admin/stacks/${id}`, null, body);
    return { content: text(res) };
});

// Container actions
server.tool("lattice_start_container", "Start a stopped container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/start`);
    return { content: text(res) };
});

server.tool("lattice_stop_container", "Stop a running container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/stop`);
    return { content: text(res) };
});

server.tool("lattice_restart_container", "Restart a container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/restart`);
    return { content: text(res) };
});

server.tool("lattice_kill_container", "Force kill a container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/kill`);
    return { content: text(res) };
});

server.tool("lattice_pause_container", "Pause a running container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/pause`);
    return { content: text(res) };
});

server.tool("lattice_unpause_container", "Unpause a paused container", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/unpause`);
    return { content: text(res) };
});

server.tool("lattice_remove_container", "Remove a container entirely", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/remove`);
    return { content: text(res) };
});

server.tool("lattice_recreate_container", "Recreate a container (remove and create fresh)", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/containers/${id}/recreate`);
    return { content: text(res) };
});

// Worker actions
server.tool("lattice_reboot_worker", "Reboot a worker machine", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/workers/${id}/reboot`);
    return { content: text(res) };
});

server.tool("lattice_upgrade_worker", "Upgrade worker runner to latest version", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/workers/${id}/upgrade`);
    return { content: text(res) };
});

server.tool("lattice_stop_all_worker", "Stop all containers on a worker", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/workers/${id}/stop-all`);
    return { content: text(res) };
});

server.tool("lattice_start_all_worker", "Start all containers on a worker", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/workers/${id}/start-all`);
    return { content: text(res) };
});

// Dashboard controls
server.tool("lattice_update_api", "Trigger Lattice API self-update", {}, async () => {
    const res = await api("POST", "/admin/update/api");
    return { content: text(res) };
});

server.tool("lattice_update_web", "Trigger Lattice web container update", {}, async () => {
    const res = await api("POST", "/admin/update/web");
    return { content: text(res) };
});

server.tool("lattice_rollback_deployment", "Rollback a deployment to its previous state", {
    id: z.number().describe("Deployment ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/deployments/${id}/rollback`);
    return { content: text(res) };
});

// API token management
server.tool("lattice_list_api_tokens", "List all API tokens", {}, async () => {
    const res = await api("GET", "/admin/api-tokens");
    return { content: text(res) };
});

server.tool("lattice_create_api_token", "Create a new API token for AI tools or automation", {
    name: z.string().describe("Token name"),
    expires_in: z.string().optional().describe("Expiration: '30d', '90d', '365d', or 'never'. Defaults to 90d"),
}, async ({ name, expires_in }) => {
    const body = { name };
    if (expires_in) body.expires_in = expires_in;
    const res = await api("POST", "/admin/api-tokens", null, body);
    return { content: text(res) };
});

server.tool("lattice_delete_api_token", "Delete an API token", {
    id: z.number().describe("API token ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/api-tokens/${id}`);
    return { content: text(res) };
});


// ─────────────────────────────────────────────────────────────────────────────
// Database instances
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_list_database_instances", "List managed database instances with engine, version, status, worker and health. Filter by worker, engine or status", {
    worker_id: z.number().optional().describe("Filter by worker ID"),
    engine: z.enum(["mysql", "mariadb", "postgres"]).optional().describe("Filter by engine"),
    status: z.string().optional().describe("Filter by status (running, stopped, creating, error)"),
    limit: z.number().optional().describe("Max instances to return"),
    offset: z.number().optional().describe("Pagination offset"),
}, async (args) => {
    const res = await api("GET", "/admin/database-instances", args);
    return { content: text(res) };
});

server.tool("lattice_get_database_instance", "Get one database instance: engine, port, limits, snapshot schedule, retention and backup destination", {
    id: z.number().describe("Database instance ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/database-instances/${id}`);
    return { content: text(res) };
});

server.tool("lattice_create_database_instance", "Provision a database instance on a worker. Creates a real container — pick a port that is free on that worker", {
    name: z.string().describe("Instance name (must be unique)"),
    engine: z.enum(["mysql", "mariadb", "postgres"]).describe("Database engine"),
    worker_id: z.number().describe("Worker to provision on"),
    engine_version: z.string().optional().describe("Engine version tag; the API picks a default when omitted"),
    port: z.number().optional().describe("Host port to expose"),
    root_password: z.string().optional().describe("Root/superuser password"),
    database_name: z.string().optional().describe("Initial database to create"),
    username: z.string().optional().describe("Application user to create"),
    password: z.string().optional().describe("Application user's password"),
    cpu_limit: z.number().optional().describe("CPU limit in cores"),
    memory_limit: z.number().optional().describe("Memory limit in bytes"),
    snapshot_schedule: z.string().optional().describe("Cron expression for automatic snapshots"),
    retention_count: z.number().optional().describe("How many automatic snapshots to keep"),
    backup_destination_id: z.number().optional().describe("Backup destination for snapshots"),
}, async (args) => {
    const res = await api("POST", "/admin/database-instances", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_database_instance", "Update a database instance's configuration. Only the fields you pass are changed", {
    id: z.number().describe("Database instance ID"),
    name: z.string().optional(),
    status: z.string().optional(),
    port: z.number().optional(),
    root_password: z.string().optional().describe("New root password"),
    password: z.string().optional().describe("New application user password"),
    cpu_limit: z.number().optional(),
    memory_limit: z.number().optional(),
    health_status: z.string().optional(),
    snapshot_schedule: z.string().optional().describe("Cron expression for automatic snapshots"),
    retention_count: z.number().optional(),
    backup_destination_id: z.number().optional(),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/database-instances/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_database_instance", "Delete a database instance record. Destructive — data is lost unless a snapshot exists. Check lattice_list_database_snapshots first", {
    id: z.number().describe("Database instance ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/database-instances/${id}`);
    return { content: text(res) };
});

server.tool("lattice_database_action", "Start, stop, restart or remove a database instance's container. 'remove' destroys the container — data survives only if the volume or a snapshot does", {
    id: z.number().describe("Database instance ID"),
    action: z.enum(["start", "stop", "restart", "remove"]).describe("Action to perform"),
}, async ({ id, action }) => {
    const res = await api("POST", `/admin/database-instances/${id}/${action}`);
    return { content: text(res) };
});

server.tool("lattice_get_database_credentials", "Get a database instance's connection credentials. Returns secret values — avoid unless the credentials are actually needed", {
    id: z.number().describe("Database instance ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/database-instances/${id}/credentials`);
    return { content: text(res) };
});

server.tool("lattice_list_database_snapshots", "List snapshots for a database instance, with size and creation time. Check this before deleting or restoring an instance", {
    id: z.number().describe("Database instance ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/database-instances/${id}/snapshots`);
    return { content: text(res) };
});

server.tool("lattice_create_database_snapshot", "Take a snapshot of a database instance now, outside its schedule", {
    id: z.number().describe("Database instance ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/database-instances/${id}/snapshots`);
    return { content: text(res) };
});

server.tool("lattice_restore_database_snapshot", "Restore a database instance from one of its snapshots. Overwrites current data irreversibly — take a fresh snapshot first if the present state matters", {
    id: z.number().describe("Database instance ID"),
    snapshot_id: z.number().describe("Snapshot ID to restore from (see lattice_list_database_snapshots)"),
}, async ({ id, snapshot_id }) => {
    const res = await api("POST", `/admin/database-instances/${id}/restore`, null, { snapshot_id });
    return { content: text(res) };
});

server.tool("lattice_delete_database_snapshot", "Delete a database snapshot. Destructive — that restore point is gone", {
    snapshot_id: z.number().describe("Snapshot ID"),
}, async ({ snapshot_id }) => {
    const res = await api("DELETE", `/admin/database-snapshots/${snapshot_id}`);
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Backup destinations
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_list_backup_destinations", "List configured backup destinations that database snapshots can be shipped to", {}, async () => {
    const res = await api("GET", "/admin/backup-destinations");
    return { content: text(res) };
});

server.tool("lattice_get_backup_destination", "Get one backup destination's configuration", {
    id: z.number().describe("Backup destination ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/backup-destinations/${id}`);
    return { content: text(res) };
});

server.tool("lattice_create_backup_destination", "Create a backup destination. config is a free-form object whose shape depends on type (e.g. an S3 destination takes bucket, region, endpoint and credentials)", {
    name: z.string().describe("Destination name"),
    type: z.string().describe("Destination type, e.g. 's3'"),
    config: z.record(z.any()).describe("Type-specific configuration object"),
}, async (args) => {
    const res = await api("POST", "/admin/backup-destinations", null, args);
    return { content: text(res) };
});

server.tool("lattice_update_backup_destination", "Update a backup destination. Passing config replaces the whole object, it does not merge", {
    id: z.number().describe("Backup destination ID"),
    name: z.string().optional(),
    type: z.string().optional(),
    config: z.record(z.any()).optional().describe("Replacement configuration object"),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/backup-destinations/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_backup_destination", "Delete a backup destination. Instances pointing at it lose their backup target. Destructive", {
    id: z.number().describe("Backup destination ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/backup-destinations/${id}`);
    return { content: text(res) };
});

server.tool("lattice_test_backup_destination", "Test connectivity and credentials for a backup destination without writing a real backup. The test is dispatched over the worker's WebSocket, so worker_id is required and that worker must be connected", {
    id: z.number().describe("Backup destination ID"),
    worker_id: z.number().describe("Worker to run the test from — required; the test runs on this worker over its WebSocket, so it must be connected"),
}, async ({ id, worker_id }) => {
    const res = await api("POST", `/admin/backup-destinations/${id}/test`, { worker_id });
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Registries
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_list_registries", "List configured container registries", {}, async () => {
    const res = await api("GET", "/admin/registries");
    return { content: text(res) };
});

server.tool("lattice_create_registry", "Add a container registry", {
    name: z.string().describe("Registry name"),
    url: z.string().describe("Registry URL, e.g. registry.appleby.cloud"),
    type: z.string().describe("Registry type, e.g. 'generic', 'dockerhub', 'ghcr'"),
    username: z.string().optional().describe("Registry username"),
    password: z.string().optional().describe("Registry password or access token"),
}, async (args) => {
    const res = await api("POST", "/admin/registries", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_registry", "Update a registry's URL, type, credentials or active flag", {
    id: z.number().describe("Registry ID"),
    name: z.string().optional(),
    url: z.string().optional(),
    type: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/registries/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_registry", "Delete a registry. Containers pulling from it fail on their next deploy. Destructive", {
    id: z.number().describe("Registry ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/registries/${id}`);
    return { content: text(res) };
});

server.tool("lattice_test_registry", "Test a saved registry's stored credentials", {
    id: z.number().describe("Registry ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/registries/${id}/test`);
    return { content: text(res) };
});

server.tool("lattice_test_registry_inline", "Test registry credentials before saving them", {
    url: z.string().describe("Registry URL"),
    username: z.string().describe("Registry username"),
    password: z.string().describe("Registry password or access token"),
}, async (args) => {
    const res = await api("POST", "/admin/registries/test", null, args);
    return { content: text(res) };
});

server.tool("lattice_list_registry_repositories", "List repositories available in a registry — what images exist to deploy", {
    id: z.number().describe("Registry ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/registries/${id}/repositories`);
    return { content: text(res) };
});

server.tool("lattice_list_registry_tags", "List the tags published for one repository. Use this to answer 'what version can I deploy' or 'is the image my CI just built actually in the registry'", {
    id: z.number().describe("Registry ID"),
    repo: z.string().describe("Repository name, e.g. 'openbucket-api'"),
}, async ({ id, repo }) => {
    const res = await api("GET", `/admin/registries/${id}/tags`, { repo });
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery & diagnostics
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_search", "Search across workers, stacks and containers by name in one call. Faster than listing each type and filtering when you only have a partial name", {
    q: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results"),
}, async ({ q, limit }) => {
    const res = await api("GET", "/admin/search", { q, limit });
    return { content: text(res) };
});

server.tool("lattice_get_anomalies", "Get detected fleet anomalies — restart loops, unhealthy containers, resource spikes, offline workers. The best first call when asked whether anything is wrong", {}, async () => {
    const res = await api("GET", "/admin/anomalies");
    return { content: text(res) };
});

server.tool("lattice_get_fleet_metrics", "Get aggregated fleet-wide CPU, memory, disk and network metrics over a time range", {
    range: z.string().optional().describe("Time range, e.g. '1h', '6h', '24h'"),
}, async ({ range }) => {
    const res = await api("GET", "/admin/fleet-metrics", { range });
    return { content: text(res) };
});

server.tool("lattice_get_versions", "Get runner versions across workers and which are outdated. Use before lattice_upgrade_worker to see what actually needs upgrading", {}, async () => {
    const res = await api("GET", "/admin/versions");
    return { content: text(res) };
});

server.tool("lattice_refresh_versions", "Re-poll every worker for its current runner version, refreshing what lattice_get_versions reports", {}, async () => {
    const res = await api("POST", "/admin/versions/refresh");
    return { content: text(res) };
});

server.tool("lattice_get_container_metrics", "Get a single container's CPU, memory and network metrics over time", {
    id: z.number().describe("Container ID"),
    limit: z.number().optional().describe("Max data points"),
    range: z.string().optional().describe("Time range, e.g. '1h', '6h', '24h'"),
}, async ({ id, limit, range }) => {
    const res = await api("GET", `/admin/containers/${id}/metrics`, { limit, range });
    return { content: text(res) };
});

server.tool("lattice_get_self", "Get the user this API token authenticates as, including role", {}, async () => {
    const res = await api("GET", "/auth/self");
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Stacks — lifecycle, compose and deploy tokens
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_create_stack", "Create an empty stack. Add containers with lattice_create_container, or use lattice_import_compose to create one from compose YAML", {
    name: z.string().describe("Stack name"),
    description: z.string().optional().describe("Description"),
    worker_id: z.number().optional().describe("Worker to pin the stack to"),
    deployment_strategy: z.string().optional().describe("Deployment strategy, e.g. 'rolling', 'recreate'"),
    auto_deploy: z.boolean().optional().describe("Redeploy automatically when a new image is pushed"),
    env_vars: z.string().optional().describe("Stack-level env vars as a JSON object string"),
}, async (args) => {
    const res = await api("POST", "/admin/stacks", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_delete_stack", "Delete a stack and every container in it. Destructive and not recoverable — export it first with lattice_export_stack if you might want it back", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/stacks/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_stack_containers", "List the containers belonging to one stack", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/stacks/${id}/containers`);
    return { content: text(res) };
});

server.tool("lattice_update_stack_compose", "Replace a stack's compose YAML. This rewrites the stored definition but does not deploy — call lattice_deploy_stack afterwards", {
    id: z.number().describe("Stack ID"),
    compose_yaml: z.string().describe("Full compose YAML document"),
}, async ({ id, compose_yaml }) => {
    const res = await api("PUT", `/admin/stacks/${id}/compose`, null, { compose_yaml });
    return { content: text(res) };
});

server.tool("lattice_sync_stack_compose", "Reconcile a stack's container records against its stored compose YAML, reporting which containers changed and why", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/stacks/${id}/sync-compose`);
    return { content: text(res) };
});

server.tool("lattice_import_compose", "Create a new stack from a docker-compose YAML document", {
    name: z.string().describe("Stack name"),
    compose_yaml: z.string().describe("Full compose YAML document"),
    description: z.string().optional().describe("Description"),
    worker_id: z.number().optional().describe("Worker to pin the stack to"),
    deployment_strategy: z.string().optional().describe("Deployment strategy"),
}, async (args) => {
    const res = await api("POST", "/admin/stacks/import", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_export_stack", "Export a stack's full definition — stack settings plus every container config — as a portable JSON document. Take one before any destructive stack change", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/stacks/${id}/export`);
    return { content: text(res) };
});

server.tool("lattice_import_stack_export", "Recreate a stack from a document produced by lattice_export_stack", {
    version: z.string().describe("Export format version, from the exported document"),
    stack: z.record(z.any()).describe("Stack object from the exported document"),
    containers: z.array(z.record(z.any())).describe("Container array from the exported document"),
}, async (args) => {
    const res = await api("POST", "/admin/stacks/import-export", null, args);
    return { content: text(res) };
});

server.tool("lattice_save_stack_as_template", "Save an existing stack's configuration as a reusable template", {
    id: z.number().describe("Stack ID to snapshot"),
    name: z.string().describe("Template name"),
    description: z.string().optional().describe("Description"),
}, async ({ id, name, description }) => {
    const res = await api("POST", `/admin/stacks/${id}/save-template`, null, body({ name, description }));
    return { content: text(res) };
});

server.tool("lattice_list_deploy_tokens", "List a stack's deploy tokens — the credentials CI uses to trigger deployments. Token values are never returned; last_used_at reveals whether CI is actually reaching Lattice", {
    id: z.number().describe("Stack ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/stacks/${id}/deploy-tokens`);
    return { content: text(res) };
});

server.tool("lattice_create_deploy_token", "Create a deploy token for a stack. The plaintext is returned once; use it as https://<lattice>/api/deploy/<token>?container=<name>", {
    id: z.number().describe("Stack ID"),
    name: z.string().describe("Token name, e.g. 'github-actions'"),
}, async ({ id, name }) => {
    const res = await api("POST", `/admin/stacks/${id}/deploy-tokens`, null, { name });
    return { content: text(res) };
});

server.tool("lattice_delete_deploy_token", "Delete a deploy token. Any CI pipeline using it stops being able to deploy. Destructive", {
    token_id: z.number().describe("Deploy token ID"),
}, async ({ token_id }) => {
    const res = await api("DELETE", `/admin/deploy-tokens/${token_id}`);
    return { content: text(res) };
});

server.tool("lattice_approve_deployment", "Approve a deployment that is waiting on manual approval", {
    id: z.number().describe("Deployment ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/deployments/${id}/approve`);
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Containers — definition CRUD
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_create_container", "Add a container definition to a stack. Creates the record only — deploy the stack to actually start it. JSON-shaped fields are passed as strings, matching the API", {
    stack_id: z.number().describe("Stack to add the container to"),
    name: z.string().describe("Container name"),
    image: z.string().describe("Image, e.g. registry.appleby.cloud/openbucket-api"),
    tag: z.string().describe("Image tag, e.g. 'latest'"),
    port_mappings: z.string().optional().describe("JSON array string, e.g. '[{\"container_port\":\"8000\",\"host_port\":\"8080\",\"protocol\":\"tcp\"}]'"),
    env_vars: z.string().optional().describe("JSON object string of environment variables"),
    volumes: z.string().optional().describe("JSON object string of host:container volume mappings"),
    cpu_limit: z.number().optional().describe("CPU limit in cores"),
    memory_limit: z.number().optional().describe("Memory limit in bytes"),
    replicas: z.number().optional().describe("Replica count"),
    restart_policy: z.string().optional().describe("e.g. 'unless-stopped', 'always'"),
    command: z.string().optional().describe("Override the image command"),
    entrypoint: z.string().optional().describe("Override the image entrypoint"),
    health_check: z.string().optional().describe("JSON object string describing the healthcheck"),
}, async ({ stack_id, ...fields }) => {
    const res = await api("POST", `/admin/stacks/${stack_id}/containers`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_update_container", "Update a container definition. Changes the stored record — redeploy or recreate the container for them to take effect", {
    id: z.number().describe("Container ID"),
    name: z.string().optional(),
    image: z.string().optional(),
    tag: z.string().optional(),
    status: z.string().optional(),
    port_mappings: z.string().optional().describe("JSON array string"),
    env_vars: z.string().optional().describe("JSON object string"),
    volumes: z.string().optional().describe("JSON object string"),
    cpu_limit: z.number().optional(),
    memory_limit: z.number().optional(),
    replicas: z.number().optional(),
    restart_policy: z.string().optional(),
    command: z.string().optional(),
    entrypoint: z.string().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/containers/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_container", "Delete a container definition and its running container. Destructive — lattice_stop_container only stops it", {
    id: z.number().describe("Container ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/containers/${id}`);
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Workers — registration, tokens, volumes, networks
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_create_worker", "Register a worker. The machine still needs the runner installed and a worker token before it connects", {
    name: z.string().describe("Worker name"),
    hostname: z.string().describe("Hostname"),
    ip_address: z.string().optional().describe("IP address"),
    labels: z.string().optional().describe("JSON object string of labels used by placement constraints"),
}, async (args) => {
    const res = await api("POST", "/admin/workers", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_worker", "Update a worker's name, hostname, IP, status, labels or active flag", {
    id: z.number().describe("Worker ID"),
    name: z.string().optional(),
    hostname: z.string().optional(),
    ip_address: z.string().optional(),
    status: z.string().optional(),
    labels: z.string().optional().describe("JSON object string of labels"),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/workers/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_worker", "Delete a worker. Every stack pinned to it becomes undeployable. Destructive", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/workers/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_worker_container_stats", "Get live per-container resource stats from one worker", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/workers/${id}/container-stats`);
    return { content: text(res) };
});

server.tool("lattice_list_worker_tokens", "List a worker's registration tokens. Values are never returned", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/workers/${id}/tokens`);
    return { content: text(res) };
});

server.tool("lattice_create_worker_token", "Create a registration token for a worker, used by the runner to connect. Plaintext is returned once", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Token name"),
}, async ({ id, name }) => {
    const res = await api("POST", `/admin/workers/${id}/tokens`, null, { name });
    return { content: text(res) };
});

server.tool("lattice_delete_worker_token", "Delete a worker token. If the runner is using it, it cannot reconnect after a restart. Destructive", {
    token_id: z.number().describe("Worker token ID"),
}, async ({ token_id }) => {
    const res = await api("DELETE", `/admin/worker-tokens/${token_id}`);
    return { content: text(res) };
});

server.tool("lattice_list_worker_volumes", "List Docker volumes on a worker", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/workers/${id}/volumes`);
    return { content: text(res) };
});

server.tool("lattice_create_worker_volume", "Create a Docker volume on a worker", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Volume name"),
    driver: z.string().optional().describe("Volume driver (defaults to 'local')"),
}, async ({ id, name, driver }) => {
    const res = await api("POST", `/admin/workers/${id}/volumes`, null, body({ name, driver }));
    return { content: text(res) };
});

server.tool("lattice_delete_worker_volume", "Delete a Docker volume on a worker. Any data stored in it is destroyed. Destructive", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Volume name"),
}, async ({ id, name }) => {
    const res = await api("DELETE", `/admin/workers/${id}/volumes/${encodeURIComponent(name)}`);
    return { content: text(res) };
});

server.tool("lattice_list_worker_networks", "List Docker networks on a worker", {
    id: z.number().describe("Worker ID"),
}, async ({ id }) => {
    const res = await api("GET", `/admin/workers/${id}/networks`);
    return { content: text(res) };
});

server.tool("lattice_create_worker_network", "Create a Docker network on a worker", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Network name"),
    driver: z.string().optional().describe("Network driver (defaults to 'bridge')"),
}, async ({ id, name, driver }) => {
    const res = await api("POST", `/admin/workers/${id}/networks`, null, body({ name, driver }));
    return { content: text(res) };
});

server.tool("lattice_delete_worker_network", "Delete a Docker network on a worker. Containers attached to it lose connectivity. Destructive", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Network name"),
}, async ({ id, name }) => {
    const res = await api("DELETE", `/admin/workers/${id}/networks/${encodeURIComponent(name)}`);
    return { content: text(res) };
});

server.tool("lattice_list_all_networks", "List every tracked Docker network across the fleet", {}, async () => {
    const res = await api("GET", "/admin/networks");
    return { content: text(res) };
});

server.tool("lattice_delete_network", "Delete a tracked network by its Lattice ID. Destructive", {
    id: z.number().describe("Network ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/networks/${id}`);
    return { content: text(res) };
});

server.tool("lattice_force_remove_container", "Force-remove a container on a worker by name, bypassing the normal lifecycle. For clearing a wedged container that ordinary remove will not shift. Destructive", {
    id: z.number().describe("Worker ID"),
    name: z.string().describe("Container name to force-remove"),
}, async ({ id, name }) => {
    const res = await api("POST", `/admin/workers/${id}/force-remove`, null, { container_name: name });
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Global env vars, templates, webhooks
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_list_env_vars", "List global environment variables available for interpolation into stack and container configs as ${NAME}. Values marked is_secret are masked", {}, async () => {
    const res = await api("GET", "/admin/env-vars");
    return { content: text(res) };
});

server.tool("lattice_create_env_var", "Create a global environment variable", {
    key: z.string().describe("Variable name, referenced as ${KEY}"),
    value: z.string().describe("Value"),
    is_secret: z.boolean().optional().describe("Mask the value in listings"),
}, async (args) => {
    const res = await api("POST", "/admin/env-vars", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_env_var", "Update a global environment variable's value or secret flag. Containers pick it up on their next deploy", {
    id: z.number().describe("Env var ID"),
    value: z.string().optional().describe("New value"),
    is_secret: z.boolean().optional().describe("Mask the value in listings"),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/env-vars/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_env_var", "Delete a global environment variable. Any config referencing ${KEY} fails to interpolate on next deploy. Destructive", {
    id: z.number().describe("Env var ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/env-vars/${id}`);
    return { content: text(res) };
});

server.tool("lattice_list_templates", "List saved stack templates", {}, async () => {
    const res = await api("GET", "/admin/templates");
    return { content: text(res) };
});

server.tool("lattice_create_template", "Create a stack template from a config document", {
    name: z.string().describe("Template name"),
    config: z.string().describe("Template configuration as a JSON string"),
    description: z.string().optional().describe("Description"),
}, async (args) => {
    const res = await api("POST", "/admin/templates", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_delete_template", "Delete a stack template. Destructive", {
    id: z.number().describe("Template ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/templates/${id}`);
    return { content: text(res) };
});

server.tool("lattice_list_webhooks", "List outbound webhooks that fire on fleet events", {}, async () => {
    const res = await api("GET", "/admin/webhooks");
    return { content: text(res) };
});

server.tool("lattice_create_webhook", "Create an outbound webhook. events is a JSON array string, e.g. '[\"container.status\"]' or '[\"*\"]' for everything", {
    name: z.string().describe("Webhook name"),
    url: z.string().describe("Destination URL"),
    events: z.string().describe("JSON array string of event types, or '[\"*\"]' for all"),
    secret: z.string().optional().describe("Shared secret used to sign deliveries"),
}, async (args) => {
    const res = await api("POST", "/admin/webhooks", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_webhook", "Update a webhook's URL, event list, secret or active flag", {
    id: z.number().describe("Webhook ID"),
    name: z.string().optional(),
    url: z.string().optional(),
    events: z.string().optional().describe("JSON array string of event types"),
    secret: z.string().optional(),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/webhooks/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_webhook", "Delete a webhook. Destructive", {
    id: z.number().describe("Webhook ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/webhooks/${id}`);
    return { content: text(res) };
});

server.tool("lattice_test_webhook", "Send a test payload to a webhook to verify the endpoint accepts it", {
    id: z.number().describe("Webhook ID"),
}, async ({ id }) => {
    const res = await api("POST", `/admin/webhooks/${id}/test`);
    return { content: text(res) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Users & instance configuration
// ─────────────────────────────────────────────────────────────────────────────

server.tool("lattice_list_users", "List Lattice users with roles and status", {}, async () => {
    const res = await api("GET", "/admin/users");
    return { content: text(res) };
});

server.tool("lattice_create_user", "Create a local Lattice user", {
    email: z.string().describe("Email address"),
    password: z.string().describe("Initial password"),
    role: z.string().describe("Role, e.g. 'admin', 'editor', 'viewer'"),
    name: z.string().optional().describe("Display name"),
}, async (args) => {
    const res = await api("POST", "/admin/users", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_update_user", "Update a user's name, role or active flag. Setting active=false blocks their access immediately", {
    id: z.number().describe("User ID"),
    name: z.string().optional(),
    role: z.string().optional(),
    active: z.boolean().optional(),
}, async ({ id, ...fields }) => {
    const res = await api("PUT", `/admin/users/${id}`, null, body(fields));
    return { content: text(res) };
});

server.tool("lattice_delete_user", "Delete a Lattice user. Destructive", {
    id: z.number().describe("User ID"),
}, async ({ id }) => {
    const res = await api("DELETE", `/admin/users/${id}`);
    return { content: text(res) };
});

server.tool("lattice_get_sso_config", "Get the Forta SSO configuration", {}, async () => {
    const res = await api("GET", "/admin/sso-config");
    return { content: text(res) };
});

server.tool("lattice_update_sso_config", "Update the SSO configuration. Misconfiguring this can lock every SSO user out of Lattice — verify local admin access first", {
    enabled: z.boolean().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    authorize_url: z.string().optional(),
    token_url: z.string().optional(),
    userinfo_url: z.string().optional(),
    redirect_url: z.string().optional(),
    logout_url: z.string().optional(),
    scopes: z.string().optional(),
    user_identifier: z.string().optional().describe("Claim used to identify the user, e.g. 'email' or 'sub'"),
    button_label: z.string().optional(),
    auto_provision: z.boolean().optional().describe("Create a local user on first SSO login"),
    post_login_url: z.string().optional(),
}, async (args) => {
    const res = await api("PUT", "/admin/sso-config", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_get_smtp_config", "Get the SMTP configuration used for alert emails", {}, async () => {
    const res = await api("GET", "/admin/smtp-config");
    return { content: text(res) };
});

server.tool("lattice_update_smtp_config", "Update the SMTP configuration", {
    enabled: z.boolean().optional(),
    host: z.string().optional(),
    port: z.string().optional().describe("Port as a string, matching the API"),
    username: z.string().optional(),
    password: z.string().optional(),
    from_email: z.string().optional(),
    from_name: z.string().optional(),
    recipients: z.string().optional().describe("Comma-separated recipient list"),
}, async (args) => {
    const res = await api("PUT", "/admin/smtp-config", null, body(args));
    return { content: text(res) };
});

server.tool("lattice_test_smtp", "Send a test email using the saved SMTP configuration", {}, async () => {
    const res = await api("POST", "/admin/smtp-config/test");
    return { content: text(res) };
});

server.tool("lattice_get_notification_prefs", "Get per-event notification preferences", {}, async () => {
    const res = await api("GET", "/admin/notification-prefs");
    return { content: text(res) };
});

server.tool("lattice_update_notification_prefs", "Update notification preferences. Merges into existing prefs; unknown event types are ignored rather than rejected, so verify with lattice_get_notification_prefs afterwards", {
    preferences: z.record(z.any()).describe("Object keyed by event type, e.g. {\"container.status\":{\"email\":true}}"),
}, async ({ preferences }) => {
    const res = await api("PUT", "/admin/notification-prefs", null, preferences);
    return { content: text(res) };
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
