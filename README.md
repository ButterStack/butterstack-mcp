# butterstack-mcp

A Model Context Protocol (MCP) server for [ButterStack](https://www.butterstack.com): give an AI assistant read/write access to your game dev pipeline, tasks, builds, and asset approvals.

Zero runtime dependencies. Node builtins only.

## Install

Add this to your MCP client's config. No global install needed, `npx` fetches it on demand:

```json
{
  "mcpServers": {
    "butterstack": {
      "command": "npx",
      "args": ["-y", "butterstack-mcp"]
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings -> Developer -> Edit Config) and add the block above under `mcpServers`, then restart Claude Desktop.

### Cursor

Add the same block to `.cursor/mcp.json` in your project, or to your global Cursor MCP settings, under `mcpServers`.

### Antigravity

Add the same block to your Antigravity MCP configuration under `mcpServers`.

## Authentication

Set `BUTTERSTACK_API_TOKEN` in your client's MCP server environment. This is the primary and recommended way to authenticate: it works standalone, with nothing else installed.

```json
{
  "mcpServers": {
    "butterstack": {
      "command": "npx",
      "args": ["-y", "butterstack-mcp"],
      "env": {
        "BUTTERSTACK_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

Generate a token from your ButterStack account settings.

If you separately have the [ButterStack CLI](https://github.com/ButterStack/butterstack-cli) installed and have already run `butter auth login`, this server will also pick up the credential it stored on disk (`~/.config/butterstack/credentials.json`), so you don't have to configure a token twice. But the CLI is not a dependency of this package and installing it is not required: `BUTTERSTACK_API_TOKEN` alone is enough.

### Host

By default the server talks to `https://www.butterstack.com`. To point it at a self-hosted or local instance, set `BUTTERSTACK_HOST`:

```json
{
  "env": {
    "BUTTERSTACK_API_TOKEN": "your-token-here",
    "BUTTERSTACK_HOST": "http://localhost:3000"
  }
}
```

The server refuses to send a stored credential to a host other than the one it was issued for. If you see a "Refusing to send the stored credential" error, either set `BUTTERSTACK_HOST` to match the host your credential was minted for, or generate a new credential for the host you're pointing at.

## Tools

| Tool | Description |
|---|---|
| `projects_list` | List all accessible game projects and repositories. |
| `projects_get` | Get status, pipeline configuration, and pending asset counts for a project. |
| `tasks_list` | List tasks, bugs, art backlog, and balance tickets for a project, with filters. |
| `tasks_create` | Create a new bug, feature, or art task card. |
| `tasks_update` | Update status, priority, description, or assignee of an existing task. |
| `builds_list` | List recent CI/CD engine build runs and cook statuses. |
| `builds_get` | Get step timings, exit codes, and commit metadata for a build run. |
| `builds_investigate_failure` | Trigger or fetch AI failure investigation for a failed build, with root cause and blame attribution. |
| `assets_list_pending` | List game assets awaiting producer or art lead approval. |
| `assets_get_details` | Inspect an asset's polygon count, texture resolution, preview links, and approval history. |
| `assets_approve` | Approve a submitted game asset version. |
| `assets_deny` | Deny a submitted game asset version with constructive feedback. |

Every tool takes a `project_id` (except `projects_list`), which accepts either a numeric project ID or a project name.

## Prompts

| Prompt | Description |
|---|---|
| `triage_broken_build` | Diagnose why the latest build for a project failed and file an attributed task for the author. |
| `batch_asset_review` | Review all pending art submissions for a project against budget constraints. |

## Resources

| Resource | Description |
|---|---|
| `butterstack://projects` | Live list of all game projects accessible with the current credentials. |

## Requirements

Node 18 or later. That's a supported-versions policy, not a hard technical floor: the server only uses builtins compatible back to Node 10.9.0, but 18 is the oldest version this package is actually tested against.

## License

MIT
