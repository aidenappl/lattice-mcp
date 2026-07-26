#!/usr/bin/env node
/**
 * Static verification for lattice-mcp.
 *
 * index.js cannot simply be imported to check it: it ends in a top-level await
 * that connects the stdio transport, so importing would hang waiting for a
 * client. Everything here is therefore checked by parsing the source.
 *
 * What this catches:
 *
 *  - Duplicate tool names. `server.tool()` silently accepts a duplicate — the
 *    last registration wins and the earlier tool disappears with no error. That
 *    is invisible until an agent calls the vanished tool.
 *  - Tool counts in README.md and AGENTS.md drifting from the code. This repo
 *    already shipped a release where the MCP lagged the API by two months; the
 *    documented count is the cheapest tripwire for that.
 *  - Tools not following the lattice_ prefix, which the client relies on.
 *  - sanitise() being unwired from api(). Masking is applied in exactly one
 *    place; removing that call leaves every tool working and every response
 *    leaking, which no other check would notice.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const failures = [];
const fail = (msg) => failures.push(msg);

const source = readFileSync("index.js", "utf8");

// ── Syntax ───────────────────────────────────────────────────────────────────
try {
    execFileSync(process.execPath, ["--check", "index.js"], { stdio: "pipe" });
} catch (err) {
    fail(`index.js failed to parse:\n${err.stderr?.toString() ?? err.message}`);
}

// ── Tool registrations ───────────────────────────────────────────────────────
const names = [...source.matchAll(/server\.tool\(\s*"([^"]+)"/g)].map((m) => m[1]);

if (names.length === 0) {
    fail("no server.tool() registrations found — did the call shape change?");
}

const seen = new Set();
const duplicates = new Set();
for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
}
if (duplicates.size > 0) {
    fail(
        `duplicate tool names (the later registration silently replaces the earlier): ${[...duplicates].join(", ")}`,
    );
}

const misnamed = names.filter((n) => !n.startsWith("lattice_"));
if (misnamed.length > 0) {
    fail(`tools not prefixed with lattice_: ${misnamed.join(", ")}`);
}

// ── Documented counts must match the code ────────────────────────────────────
const toolCount = names.length;

for (const file of ["README.md", "AGENTS.md"]) {
    const doc = readFileSync(file, "utf8");
    const match = doc.match(/\*\*(\d+) typed tools\*\*/);
    if (!match) {
        fail(`${file}: could not find a "**N typed tools**" figure to check against`);
        continue;
    }
    const documented = Number(match[1]);
    if (documented !== toolCount) {
        fail(
            `${file} documents ${documented} tools but index.js registers ${toolCount} — ` +
                `update the docs in the same change (see "Keeping this file updated")`,
        );
    }
}

// README lists every tool in a table; make sure the listing is complete too.
const readme = readFileSync("README.md", "utf8");
const undocumented = names.filter((n) => !readme.includes(`\`${n}\``));
if (undocumented.length > 0) {
    fail(`tools missing from the README tool tables: ${undocumented.join(", ")}`);
}

// ── Version consistency ──────────────────────────────────────────────────────
// The version lives in two places: package.json and the McpServer declaration.
// They drift silently — nothing reads both — and the failure surfaces only at
// `npm publish`, as "cannot publish over the previously published versions",
// after the release has already been tagged and pushed.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const serverVersion = source.match(/new McpServer\(\{[^}]*version:\s*"([^"]+)"/s)?.[1];

if (!serverVersion) {
    fail("could not find the McpServer version declaration in index.js");
} else if (serverVersion !== pkg.version) {
    fail(
        `version mismatch: package.json is ${pkg.version} but index.js declares ${serverVersion} — ` +
            `bump both`,
    );
}

// AGENTS.md documents each release; a bump with no matching entry means the
// release notes are already behind.
const agents = readFileSync("AGENTS.md", "utf8");
if (pkg.version && !agents.includes(`**${pkg.version}**`)) {
    fail(`AGENTS.md has no "**${pkg.version}**" release entry — document the release in the same change`);
}

// ── Secret masking ───────────────────────────────────────────────────────────
// sanitise() is the only thing keeping env vars, database passwords and freshly
// minted tokens out of a transcript, and it works by being applied centrally in
// api(). Unwiring that one call is a silent, total regression — every tool keeps
// working and every response starts leaking. This is the tripwire for it.
if (!/return sanitise\(JSON\.parse\(raw\)\)/.test(source)) {
    fail("api() no longer passes its parsed response through sanitise() — every tool now leaks secrets");
}
if (!/function sanitise\(/.test(source) || !/function mask\(/.test(source)) {
    fail("sanitise()/mask() are missing from index.js");
}
// The masking must default to on; only an explicit opt-in env var disables it.
if (!/const ALLOW_SECRETS = process\.env\.LATTICE_ALLOW_SECRET_VALUES === "1"/.test(source)) {
    fail("the masking opt-out is not the expected LATTICE_ALLOW_SECRET_VALUES === \"1\" check — masking may no longer default to on");
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
    console.error("verification failed:\n");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}

console.log(`✓ index.js parses`);
console.log(`✓ version ${pkg.version} consistent across package.json, index.js and AGENTS.md`);
console.log(`✓ ${toolCount} tools registered, no duplicates, all lattice_-prefixed`);
console.log(`✓ README.md and AGENTS.md agree on the tool count`);
console.log(`✓ every tool appears in the README tool tables`);
console.log(`✓ sanitise() is wired into api() and masking defaults to on`);
