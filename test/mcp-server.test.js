"use strict";

// Regression coverage for the MCP server's host/credential-binding guard and
// its JSON-RPC initialize handshake.
//
// The host-binding test is ported from the ButterStack monorepo's
// test/lib/butter_cli_test.rb (the "F1: the MCP server enforces the same
// host-binding refusal as bin/butter" case). It drives the real server
// process over real stdio and a real raw TCP listener, the same way the
// original did, rather than asserting on unit state.
//
// IMPORTANT: the core assertion below matches the fix's exact wording,
// /Refusing to send the stored credential/, not a loose /refus/i. Node's own
// connection-refused error is "connect ECONNREFUSED ...", which itself
// contains the substring "REFUS" -- a loose match would false-pass against a
// server that dropped the guard and simply failed to connect for an
// unrelated reason. Do not loosen this regex. See the porting trap recorded
// against PR #1379 in the ButterStack monorepo for the false-pass this
// guards against.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MCP_BIN = path.join(__dirname, "..", "index.js");

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butterstack-mcp-test-"));
}

function writeCredentials(home, { host, token = "test-token" }) {
  const configDir = path.join(home, ".config", "butterstack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "credentials.json"),
    JSON.stringify({ token, host, scopes: ["ping"], actor: { email: "test@test.com" } })
  );
}

function writeConfig(home, { host }) {
  const configDir = path.join(home, ".config", "butterstack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ host }));
}

// A minimal raw-socket HTTP server: binds an ephemeral port on 127.0.0.1,
// records each connection, and replies 200 with a canned JSON body. Used as
// a real listener on the "correct-looking" resolved host, so a regression
// that silently sends the request instead of refusing would be caught by an
// actual captured connection, not merely inferred from a refused connection
// (which, like Node's own ECONNREFUSED, would also contain "refus").
function startCaptureServer() {
  return new Promise((resolve) => {
    const connections = [];
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        if (buf.includes("\r\n\r\n")) {
          connections.push(buf);
          const body = '{"projects":[]}';
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
          );
          socket.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, connections });
    });
  });
}

function stopCaptureServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runMcpRequest(home, request) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MCP_BIN], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server produced no JSON-RPC response within timeout (stdout=${stdout} stderr=${stderr})`));
    }, 5000);

    // Resolve as soon as we have one full response line.
    const check = () => {
      const line = stdout.split("\n").find((l) => l.trim().length > 0);
      if (line) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`Could not parse MCP response line: ${line}`));
        }
      }
    };
    child.stdout.on("data", check);

    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

test("initialize handshake reports the unscoped package name", async () => {
  const home = mkHome();
  try {
    const response = await runMcpRequest(home, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(response.result.serverInfo.name, "butterstack-mcp");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("tools/list enumerates all fourteen tools", async () => {
  const home = mkHome();
  try {
    const response = await runMcpRequest(home, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(response.result.tools.length, 14);
    const names = response.result.tools.map((t) => t.name);
    assert.deepEqual(
      names,
      [
        "projects_list",
        "projects_get",
        "tasks_list",
        "tasks_create",
        "tasks_update",
        "builds_list",
        "builds_get",
        "builds_investigate_failure",
        "changes_list",
        "changes_get",
        "assets_list_pending",
        "assets_get_details",
        "assets_approve",
        "assets_deny"
      ]
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refuses to send a stored credential to a host different from the one it was minted for, and never contacts it", async () => {
  const { server, port, connections } = await startCaptureServer();
  const home = mkHome();
  try {
    // The stored credential was minted for a host nothing is listening on.
    writeCredentials(home, { host: "http://127.0.0.1:9999", token: "super-secret-prod-token" });
    // config.json resolves getHost() to the real listener above -- this is
    // the "correct-looking" target the guard must still refuse to contact.
    writeConfig(home, { host: `http://127.0.0.1:${port}` });

    const response = await runMcpRequest(home, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "projects_list", arguments: {} }
    });

    const resultText = response?.result?.content?.[0]?.text ?? "";
    assert.match(
      resultText,
      /Refusing to send the stored credential/,
      `expected an explicit refusal message explaining the host mismatch, got: ${JSON.stringify(response)}`
    );
    assert.doesNotMatch(JSON.stringify(response), /super-secret-prod-token/);

    // Give any errant connection attempt a moment to land before asserting
    // none did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(connections.length, 0, "the mismatched host must never receive a connection at all");
  } finally {
    await stopCaptureServer(server);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// -- changes_list / changes_get ---------------------------------------------
//
// The changes API had no MCP tool. These drive the real server over stdio
// against a routed HTTP listener, and assert on the requests it sent as well
// as what it returned.

const http = require("node:http");

function startApiServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const route = routes[`${req.method} ${req.url.split("?")[0]}`];
    const status = route ? route.status || 200 : 404;
    const body = JSON.stringify(route ? route.body : { error: "not_found" });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

async function callTool(routes, name, args) {
  const { server, port, requests } = await startApiServer(routes);
  const home = mkHome();
  try {
    writeCredentials(home, { host: `http://127.0.0.1:${port}` });
    const response = await runMcpRequest(home, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    });
    return { result: response.result, requests };
  } finally {
    await stopCaptureServer(server);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CHANGES = [
  { id: 456, identifier: "207", source_type: "Changelist" },
  { id: 457, identifier: "lore-12", source_type: "Changelist" }
];
const CHANGE_DETAIL = { id: 456, identifier: "207", source_type: "Changelist", build_runs: [{ id: "b-1", commit_hash: "p4-207" }] };

test("changes_list returns a project's changes and maps its arguments onto the API", async () => {
  const { result, requests } = await callTool(
    { "GET /api/v1/projects/108/changes": { body: { changes: CHANGES, pagination: { has_more: false } } } },
    "changes_list",
    { project_id: "108", updated_since: "2026-09-01", limit: 5, orphaned: true, cursor: "abc" }
  );
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text).changes, CHANGES);
  const params = new URL(requests[0].url, "http://x").searchParams;
  assert.equal(params.get("updated_since"), "2026-09-01");
  assert.equal(params.get("limit"), "5");
  assert.equal(params.get("orphaned"), "true");
  assert.equal(params.get("cursor"), "abc");
});

test("changes_list source=lore keeps only Lore changelists", async () => {
  const { result, requests } = await callTool(
    { "GET /api/v1/projects/108/changes": { body: { changes: CHANGES, pagination: { has_more: false } } } },
    "changes_list",
    { project_id: "108", source: "lore" }
  );
  assert.deepEqual(JSON.parse(result.content[0].text).changes.map((c) => c.id), [457]);
  assert.equal(new URL(requests[0].url, "http://x").searchParams.get("source_type"), "Changelist");
});

test("changes_get with a numeric id fetches that change directly", async () => {
  const { result, requests } = await callTool(
    { "GET /api/v1/projects/108/changes/456": { body: CHANGE_DETAIL } },
    "changes_get",
    { project_id: "108", change_id: "456" }
  );
  assert.deepEqual(JSON.parse(result.content[0].text), CHANGE_DETAIL);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/projects/108/changes/456");
});

test("changes_get resolves a Perforce build's p4-<n> commit to its change", async () => {
  const { result, requests } = await callTool(
    {
      "GET /api/v1/projects/108/changes": { body: { changes: [CHANGES[0]], pagination: { has_more: false } } },
      "GET /api/v1/projects/108/changes/456": { body: CHANGE_DETAIL }
    },
    "changes_get",
    { project_id: "108", change_id: "p4-207" }
  );
  assert.deepEqual(JSON.parse(result.content[0].text), CHANGE_DETAIL);
  const params = new URL(requests[0].url, "http://x").searchParams;
  assert.equal(params.get("identifier"), "207", "the change stores the bare number, not p4-207");
  assert.equal(params.get("source_type"), "Changelist");
  assert.equal(requests[1].url, "/api/v1/projects/108/changes/456");
});

test("changes_get with an unknown commit is an error, not an empty result", async () => {
  const { result } = await callTool(
    { "GET /api/v1/projects/108/changes": { body: { changes: [], pagination: { has_more: false } } } },
    "changes_get",
    { project_id: "108", change_id: "deadbeef" }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No change with identifier "deadbeef"/);
});

test("a token without read:changes is told to log in again", async () => {
  const { result } = await callTool(
    {
      "GET /api/v1/projects/108/changes": {
        status: 403,
        body: { error: "insufficient_scope", required_scope: "read:changes", token_scopes: ["read:builds"] }
      }
    },
    "changes_list",
    { project_id: "108" }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read:changes/);
  assert.match(result.content[0].text, /butter auth login/);
});
