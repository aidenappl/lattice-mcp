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
    try {
        const res = await fetch(url.toString(), opts);
        return await res.json();
    } catch (err) {
        return { success: false, error: err.message, error_message: `API request failed: ${err.message}` };
    }
}

function text(data) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

// --- MCP Server ---

const server = new McpServer({
    name: "lattice",
    version: "1.0.0",
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
    stream: z.enum(["stdout", "stderr"]).optional().describe("Filter by stream"),
}, async ({ id, limit, stream }) => {
    const res = await api("GET", `/admin/containers/${id}/logs`, { limit, stream });
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
server.tool("lattice_get_audit_log", "Get recent audit log entries (who did what, when)", {
    limit: z.number().optional().describe("Number of entries (default 50)"),
}, async ({ limit }) => {
    const res = await api("GET", "/admin/audit-log", { limit });
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

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
