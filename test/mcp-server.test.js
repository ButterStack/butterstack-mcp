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

test("tools/list enumerates all twelve tools", async () => {
  const home = mkHome();
  try {
    const response = await runMcpRequest(home, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(response.result.tools.length, 12);
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
