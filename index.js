#!/usr/bin/env node

/**
 * ButterStack Model Context Protocol (MCP) Server
 * Exposes ButterStack game dev pipelines, tasks, builds, and asset approvals to AI assistants.
 */

const readline = require("readline");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const pkg = require("./package.json");

const CONFIG_DIR = path.join(os.homedir(), ".config", "butterstack");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Host resolution order: env override, then config.json (`butter auth login
// --host ...`), then the host recorded in credentials.json at login. Both
// this server and the ButterStack CLI must resolve to the same host given
// the same on-disk state, so a request never silently goes somewhere the
// stored credential wasn't issued for.
function getHost() {
  return (process.env.BUTTERSTACK_HOST || loadStoredHost() || "https://www.butterstack.com").replace(/\/$/, "");
}

function loadStoredHost() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (cfg.host) return cfg.host;
    } catch {}
  }
  const creds = loadStoredCredentials();
  return creds ? creds.host : null;
}

function loadStoredCredentials() {
  if (fs.existsSync(CREDS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
    } catch {}
  }
  return null;
}

function getToken() {
  if (process.env.BUTTERSTACK_API_TOKEN) {
    return process.env.BUTTERSTACK_API_TOKEN;
  }
  const data = loadStoredCredentials();
  return data ? data.token : null;
}

function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const host = getHost();

    if (!token) {
      return reject(new Error("ButterStack API token not found. Set BUTTERSTACK_API_TOKEN, or run 'butter auth login' first if you have the ButterStack CLI installed."));
    }

    // Refuse to send the stored credential to a host different from the one
    // it was minted for. Skipped when the token came from
    // BUTTERSTACK_API_TOKEN (an explicit env override, not the file) since
    // there's no stored host to compare against in that case.
    if (!process.env.BUTTERSTACK_API_TOKEN) {
      const stored = loadStoredCredentials();
      if (stored && stored.host) {
        const credHost = String(stored.host).replace(/\/$/, "");
        if (credHost !== host) {
          return reject(
            new Error(
              `Refusing to send the stored credential (minted for ${credHost}) to ${host}. ` +
                `Set BUTTERSTACK_HOST=${credHost} to match it, or re-authenticate for this host.`
            )
          );
        }
      }
    }

    const url = new URL(`${host}${endpoint}`);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": `butterstack-mcp/${pkg.version} (${os.platform()}; ${os.arch()})`
    };

    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = client.request(
      url,
      {
        method,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.statusCode}`;
            const err = new Error(msg);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Tool Definitions
const TOOLS = [
  {
    name: "projects_list",
    description: "List all accessible game projects and repositories in ButterStack.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "projects_get",
    description: "Get detailed status, pipeline configuration, and pending asset counts for a specific project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name (e.g. '1' or 'Personal Project')" }
      },
      required: ["project_id"]
    }
  },
  {
    name: "tasks_list",
    description: "List tasks, bugs, art backlog, and balance tickets for a project with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        state: { type: "string", enum: ["to_do", "in_progress", "blocked", "completed"], description: "Task state filter" },
        task_type: { type: "string", enum: ["bug", "feature", "chore", "art", "content", "balance"], description: "Task category" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Priority level" },
        assignee: { type: "string", description: "Assignee handle e.g. 'handle:kevin' or 'user:1'" }
      },
      required: ["project_id"]
    }
  },
  {
    name: "tasks_create",
    description: "Create a new bug, feature, or art task card in ButterStack.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        title: { type: "string", description: "Task title" },
        task_type: { type: "string", enum: ["bug", "feature", "chore", "art", "content", "balance"], default: "chore" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
        state: { type: "string", enum: ["to_do", "in_progress", "blocked", "completed"], default: "to_do" },
        description: { type: "string", description: "Detailed description / reproduction steps" },
        assignee_handle: { type: "string", description: "Assignee handle (lowercase alphanumeric)" }
      },
      required: ["project_id", "title"]
    }
  },
  {
    name: "tasks_update",
    description: "Update status, priority, description, or assignee of an existing task.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        task_id: { type: "number", description: "Task ID" },
        state: { type: "string", enum: ["to_do", "in_progress", "blocked", "completed"] },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        description: { type: "string", description: "Updated description" },
        description_append: { type: "string", description: "Append text to existing description" },
        assignee_handle: { type: "string", description: "Assignee handle" }
      },
      required: ["project_id", "task_id"]
    }
  },
  {
    name: "builds_list",
    description: "List recent CI/CD engine build runs and cook statuses.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        status: { type: "string", enum: ["queued", "preparing", "building", "completed", "failed", "cancelled"] },
        build_type: { type: "string", enum: ["unreal", "unity", "custom"] },
        target_type: { type: "string", enum: ["shipping", "development", "test", "debug"] },
        limit: { type: "number", default: 10 }
      },
      required: ["project_id"]
    }
  },
  {
    name: "builds_get",
    description: "Get detailed step timings, exit codes, and commit metadata for a specific build run.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        build_id: { type: "number", description: "Build run ID" }
      },
      required: ["project_id", "build_id"]
    }
  },
  {
    name: "builds_investigate_failure",
    description: "Trigger or fetch AI failure investigation for a failed build run, identifying root cause and blame attribution.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        build_id: { type: "number", description: "Failed build run ID" }
      },
      required: ["project_id", "build_id"]
    }
  },
  {
    name: "assets_list_pending",
    description: "List game assets (textures, meshes, audio, shaders) awaiting producer or art lead approval.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        asset_type: { type: "string", enum: ["texture", "model", "audio", "material", "shader", "animation", "level"] },
        limit: { type: "number", default: 20 }
      },
      required: ["project_id"]
    }
  },
  {
    name: "assets_get_details",
    description: "Inspect asset polygon count, texture resolution, preview links, and approval history.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        asset_id: { type: "string", description: "Asset UUID or ID" }
      },
      required: ["project_id", "asset_id"]
    }
  },
  {
    name: "assets_approve",
    description: "Approve a submitted game asset version.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        asset_id: { type: "string", description: "Asset UUID or ID" },
        comments: { type: "string", description: "Approval feedback note" },
        stage: { type: "string", default: "art_review" }
      },
      required: ["project_id", "asset_id"]
    }
  },
  {
    name: "assets_deny",
    description: "Deny a submitted game asset version with constructive feedback.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or name" },
        asset_id: { type: "string", description: "Asset UUID or ID" },
        reason: { type: "string", description: "Reason for denial / budget violation details" },
        stage: { type: "string", default: "art_review" }
      },
      required: ["project_id", "asset_id", "reason"]
    }
  }
];

// Resources Definitions
const RESOURCES = [
  {
    uri: "butterstack://projects",
    name: "Accessible Projects",
    description: "Live list of all game projects accessible with current credentials.",
    mimeType: "application/json"
  }
];

// Prompts Definitions
const PROMPTS = [
  {
    name: "triage_broken_build",
    description: "Diagnose why the latest build failed and file an attributed ticket.",
    arguments: [
      { name: "project_id", description: "Project ID or name", required: true }
    ]
  },
  {
    name: "batch_asset_review",
    description: "Review pending art submissions against project budget constraints.",
    arguments: [
      { name: "project_id", description: "Project ID or name", required: true }
    ]
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "projects_list": {
      const res = await apiRequest("GET", "/api/v1/projects");
      return res;
    }
    case "projects_get": {
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}`);
      return res;
    }
    case "tasks_list": {
      const query = new URLSearchParams();
      if (args.state) query.set("state", args.state);
      if (args.task_type) query.set("task_type", args.task_type);
      if (args.priority) query.set("priority", args.priority);
      if (args.assignee) query.set("assignee", args.assignee);
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}/tasks?${query.toString()}`);
      return res;
    }
    case "tasks_create": {
      const { project_id, ...taskData } = args;
      const res = await apiRequest("POST", `/api/v1/projects/${project_id}/tasks`, { task: taskData });
      return res;
    }
    case "tasks_update": {
      const { project_id, task_id, ...taskData } = args;
      const res = await apiRequest("PATCH", `/api/v1/projects/${project_id}/tasks/${task_id}`, { task: taskData });
      return res;
    }
    case "builds_list": {
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.build_type) query.set("build_type", args.build_type);
      if (args.target_type) query.set("target_type", args.target_type);
      if (args.limit) query.set("limit", args.limit.toString());
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}/build_runs?${query.toString()}`);
      return res;
    }
    case "builds_get": {
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}/build_runs/${args.build_id}`);
      return res;
    }
    case "builds_investigate_failure": {
      const res = await apiRequest("POST", `/api/v1/projects/${args.project_id}/build_runs/${args.build_id}/investigate`);
      return res;
    }
    case "assets_list_pending": {
      const query = new URLSearchParams({ pending_approval: "true" });
      if (args.asset_type) query.set("asset_type", args.asset_type);
      if (args.limit) query.set("limit", args.limit.toString());
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}/assets?${query.toString()}`);
      return res;
    }
    case "assets_get_details": {
      const res = await apiRequest("GET", `/api/v1/projects/${args.project_id}/assets/${args.asset_id}`);
      return res;
    }
    case "assets_approve": {
      const res = await apiRequest("POST", `/api/v1/projects/${args.project_id}/assets/${args.asset_id}/approvals`, {
        status: "approved",
        comments: args.comments || "Approved via AI Agent (MCP)",
        stage: args.stage || "art_review"
      });
      return res;
    }
    case "assets_deny": {
      const res = await apiRequest("POST", `/api/v1/projects/${args.project_id}/assets/${args.asset_id}/approvals`, {
        status: "denied",
        comments: args.reason,
        stage: args.stage || "art_review"
      });
      return res;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC stdio Message Processor
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result, error = null) {
  const msg = { jsonrpc: "2.0", id };
  if (error) {
    msg.error = error;
  } else {
    msg.result = result;
  }
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    sendResponse(null, null, { code: -32700, message: "Parse error" });
    return;
  }

  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "butterstack-mcp",
            version: pkg.version
          },
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          }
        });
        break;

      case "notifications/initialized":
        // Client ack, no response needed
        break;

      case "ping":
        sendResponse(id, {});
        break;

      case "tools/list":
        sendResponse(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const { name, arguments: args } = params;
        try {
          const result = await handleToolCall(name, args || {});
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          });
        } catch (toolErr) {
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error executing ${name}: ${toolErr.message}`
              }
            ],
            isError: true
          });
        }
        break;
      }

      case "resources/list":
        sendResponse(id, { resources: RESOURCES });
        break;

      case "resources/read": {
        const { uri } = params;
        if (uri === "butterstack://projects") {
          const projects = await apiRequest("GET", "/api/v1/projects");
          sendResponse(id, {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(projects, null, 2)
              }
            ]
          });
        } else {
          sendResponse(id, null, { code: -32602, message: `Resource not found: ${uri}` });
        }
        break;
      }

      case "prompts/list":
        sendResponse(id, { prompts: PROMPTS });
        break;

      case "prompts/get": {
        const { name, arguments: promptArgs } = params;
        if (name === "triage_broken_build") {
          const pid = promptArgs && promptArgs.project_id ? promptArgs.project_id : "1";
          sendResponse(id, {
            description: "Diagnose why the latest build failed and file an attributed ticket.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please check the latest build for project '${pid}'. If it failed, use builds_investigate_failure to find the root cause and offending changelist, then create a critical task for the author.`
                }
              }
            ]
          });
        } else if (name === "batch_asset_review") {
          const pid = promptArgs && promptArgs.project_id ? promptArgs.project_id : "1";
          sendResponse(id, {
            description: "Review pending art submissions against project budget constraints.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please list all pending assets for project '${pid}' using assets_list_pending. Check each asset's budget compliance and recommend whether to approve or deny them.`
                }
              }
            ]
          });
        } else {
          sendResponse(id, null, { code: -32602, message: `Prompt not found: ${name}` });
        }
        break;
      }

      default:
        sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
        break;
    }
  } catch (err) {
    sendResponse(id, null, { code: -32603, message: `Internal server error: ${err.message}` });
  }
});

process.stderr.write("ButterStack MCP Server initialized and listening on stdio\n");
