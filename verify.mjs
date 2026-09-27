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
import vm from "node:vm";

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

// Automation responses carry two credentials the generic field list did not
// cover when automations were added: the webhook token (and the path that
// embeds it), and http_request step configs, whose secrets sit in header values,
// the body and the URL path. Dropping either rule leaks a working credential.
for (const field of ["webhook_token", "webhook_path"]) {
    if (!new RegExp(`const SECRET_FIELDS = new Set\\(\\[[^\\]]*"${field}"`, "s").test(source)) {
        fail(`"${field}" is no longer in SECRET_FIELDS — automation webhook credentials would reach the transcript`);
    }
}
if (!/k === "config" && node\.type === "http_request"[\s\S]{0,80}maskHttpRequestConfig\(v\)/.test(source)) {
    fail("sanitise() no longer routes http_request step configs through maskHttpRequestConfig() — header values, bodies and webhook URL paths would leak");
}

// ── Masking behaviour ────────────────────────────────────────────────────────
// The checks above prove sanitise() is wired in; these prove it masks. The
// masking section is lifted out of index.js and run in a sandbox, since the
// module itself cannot be imported. Every case here is a leak that happened:
// OPENAI_KEY slipped the name rule, and ROOTED_DB/CORE_DB carried passwords
// inside connection strings under names that say nothing about a secret.
// Test values are assembled at runtime so no literal looks like a real key.
const maskingStart = source.indexOf("// --- Sensitive value masking ---");
const maskingEnd = source.indexOf("// --- HTTP helper ---");
let masking = null;
if (maskingStart === -1 || maskingEnd === -1) {
    fail("could not find the masking section markers in index.js");
} else {
    const sandbox = { process: { env: {} } };
    vm.createContext(sandbox);
    vm.runInContext(`${source.slice(maskingStart, maskingEnd)}\nthis.sanitise = sanitise;`, sandbox);
    masking = sandbox;
}

let maskingCases = 0;
if (masking) {
    const fakeOpenAI = "sk-" + "proj-" + "x".repeat(40);
    const fakeGitHub = "ghp" + "_" + "y".repeat(36);
    const env = (vars) => JSON.parse(masking.sanitise({ env_vars: JSON.stringify(vars) }).env_vars);
    const expect = (label, got, want) => {
        maskingCases++;
        if (got !== want) fail(`masking: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };

    const e = env({
        OPENAI_KEY: fakeOpenAI,
        STRIPE_KEY: "abc123",
        UNNAMED: fakeOpenAI,
        SOME_TOKENISH: fakeGitHub,
        ROOTED_DB: "postgres://postgres:hunter2@db.example:5432/rooted?sslmode=disable",
        CORE_DB: "user:hunter2@tcp(db.example:3306)/core",
        PUBLIC_URL: "https://user:hunter2@example.com/path",
        HEALTH_CHECK_URL: "https://hc-ping.com/abc",
        MONKEY: "banana",
        PORT: "8001",
        REPLICAS: 3,
    });
    expect("bare _KEY suffix is a secret name", e.OPENAI_KEY, "sk**********");
    expect("short _KEY value is masked", e.STRIPE_KEY, "ab**********");
    expect("provider key prefix is masked under any name", e.UNNAMED, "sk**********");
    expect("GitHub token prefix is masked", e.SOME_TOKENISH, "gh**********");
    expect("password inside a postgres URL", e.ROOTED_DB, "postgres://postgres:hu**********@db.example:5432/rooted?sslmode=disable");
    expect("password inside a Go MySQL DSN", e.CORE_DB, "user:hu**********@tcp(db.example:3306)/core");
    expect("URL userinfo password even under an _URL name", e.PUBLIC_URL, "https://user:hu**********@example.com/path");
    expect("plain URL stays readable", e.HEALTH_CHECK_URL, "https://hc-ping.com/abc");
    expect("KEY inside a word is not a secret name", e.MONKEY, "banana");
    expect("ordinary value stays readable", e.PORT, "8001");
    expect("non-string value passes through", e.REPLICAS, 3);

    const compose = masking.sanitise({
        compose_yaml: [
            "    environment:",
            "      - OPENAI_KEY=" + fakeOpenAI,
            `      UNNAMED: "${fakeOpenAI}"`,
            "      - ROOTED_DB=postgres://u:hunter2@db/x",
            "      - PORT=8001",
        ].join("\n"),
    }).compose_yaml.split("\n");
    expect("compose: _KEY assignment", compose[1], "      - OPENAI_KEY=sk**********");
    expect("compose: quoted provider key keeps its quotes", compose[2], `      UNNAMED: "sk**********"`);
    expect("compose: connection string password", compose[3], "      - ROOTED_DB=postgres://u:hu**********@db/x");
    expect("compose: ordinary line untouched", compose[4], "      - PORT=8001");

    const globals = masking.sanitise([
        { key: "OPENAI_KEY", value: fakeOpenAI, is_secret: false },
        { key: "ANYTHING", value: fakeOpenAI, is_secret: false },
        { key: "IMAGE_TAG", value: "v1.4.0", is_secret: false },
        { key: "FLAGGED", value: "v1.4.0", is_secret: true },
    ]);
    expect("unflagged global: secret name", globals[0].value, "sk**********");
    expect("unflagged global: provider key", globals[1].value, "sk**********");
    expect("unflagged global: ordinary value", globals[2].value, "v1.4.0");
    expect("flagged global: always masked", globals[3].value, "v1**********");
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
console.log(`✓ automation webhook tokens and http_request configs are masked`);
console.log(`✓ ${maskingCases} masking behaviour cases pass (names, provider keys, connection strings)`);
