# Synapse

Intelligent rule & skill orchestration for AI-powered development.

Synapse uses a project-local master folder:
- `.synapse/`
  - `rules/`
  - `skills/`
  - `config.json`

<!-- NEW: Competitive positioning (evidence-safe) -->
## Why Synapse is Different

Most rule tools only convert formats. Synapse gives you **safe sync, cost optimization, and zero lock-in**.

| Capability | Typical converters | Single-IDE rule systems | **Synapse** |
|------------|-------------------|--------------------------|-------------|
| Cross-IDE sync (Trae, Cursor, Windsurf, Cline, Zed) | ❌ | ❌ | ✅ |
| Safe rollback & restore | ❌ | ❌ | ✅ |
| Local token cost analysis | ❌ | ❌ | ✅ |
| Proactive optimization suggestions | ❌ | ❌ | ✅ |
| Conflict detection | ❌ | ❌ | ✅ |
| CLI + VS Code + MCP (3 interfaces) | ❌ | ❌ | ✅ |
| Import from existing IDEs (zero lock-in) | ❌ | ❌ | ✅ |

<!-- NEW: Claim 1 -->
## Safe Sync with Rollback

```bash
synapse backup list
synapse sync --all --conflict prompt --backup
synapse rollback --backup <name>
synapse backup restore --backup <name>
```

<!-- NEW: Claim 2 -->
## Token Cost Analysis (Local, No API)

```bash
synapse analyze
synapse optimize
synapse optimize --apply --backup
```

Notes:
- `synapse analyze` prints token totals + an estimated USD cost using `--usd-per-1m` (or `SYNAPSE_USD_PER_1M_TOKENS`)
- `synapse optimize` detects conflicts + suggests how to reduce always-on token spend; `--apply` is Pro

<!-- NEW: Claim 4 -->
## Three Interfaces, One Engine

| Interface | Command | Best For |
|-----------|---------|----------|
| CLI | `synapse sync --all` | CI/CD, automation |
| VS Code | Command Palette → "Synapse: Sync Rules" | Daily development |
| MCP Server | `synapse mcp` (or `synapse serve --mcp-only`) | AI agents |

<!-- NEW: Claim 5 -->
## Import from Existing IDEs (Zero Lock-in)

```bash
synapse importFromIDE
synapse sync --target trae
```

## How It Works

- Author rules in `.synapse/rules/*.synapse`
- Run `Synapse: Sync Rules` (VS Code) to compile to IDE formats:
  - Trae: `.trae/rules/*.md`
  - Cursor: `.cursor/rules/*.mdc`
  - Windsurf: `.windsurf/*.windsurfrules`
  - Cline: `.clinerules/*.md`
  - Zed: `.rules`
- Use the dashboard for deploy/status/sync/preview workflows.

## Quick Start (CLI)

From this repo folder:

```powershell
node .\bin\synapse-unified.js --help
node .\bin\synapse-unified.js init
node .\bin\synapse-unified.js sync --all --conflict prompt
node .\bin\synapse-unified.js analyze
node .\bin\synapse-unified.js diff
node .\bin\synapse-unified.js rollback --backup backup_2026-04-22T...
```

Note: `bin/synapse.js` is a deprecated shim that forwards to `bin/synapse-unified.js`.

## Quick Start (Dashboard)

```powershell
npm run dashboard
```

Then open:
- `http://localhost:3456/`

## VS Code Extension

- Build: `cd extension && npm install && npm run compile`
- Run: press `F5` to open the Extension Development Host
- UI:
  - Sidebar: **Synapse → Control Center**
  - Note: CLI-backed actions (Optimize/Detect) stream logs to the **“Synapse” Output** panel (no visible terminal).
- Commands:
  - `Synapse: Initialize Project`
  - `Synapse: Import Rules from IDE`
  - `Synapse: Sync Rules`
  - `Synapse: Add Target IDE`
  - `Synapse: Upgrade to Pro`
  - `Synapse: Enter License Key`
  - `Synapse: Resend License Key`
  - `Synapse: Forget License Key (This Machine)`
  - `Synapse: License Diagnostics`

- License storage:
  - Stored securely in VS Code SecretStorage (survives reinstall better than globalState)
  - Also synced to `~/.synapse/license.key` for CLI parity when needed (e.g. AutoFix)

## Universal IDE (Optional)

- MCP server (stdio): `cd standalone && npm install && npm run build && npm start`
- WebSocket server: `cd standalone && npm run start:ws`

### MCP Client Config Examples

- Cursor: [cursor-mcp-config.json](file:///c:/MyProgram/Trae/standalone/cursor-mcp-config.json)
- Windsurf: [windsurf-settings.json](file:///c:/MyProgram/Trae/standalone/windsurf-settings.json)
- Claude Desktop: [claude_desktop_config.json](file:///c:/MyProgram/Trae/standalone/claude_desktop_config.json)

### WebSocket API

- Connect: `ws://localhost:3457?ide=<name>&workspace=<abs path>`
- Health: `GET http://localhost:3457/health`
- HTTP sync: `POST http://localhost:3457/api/sync` with JSON body `{ "target": "all|trae|cursor", "workspace": "..." }`

## Commands (Quick Reference)

### Website (Local Preview)

- Original + chooser (root): 

```powershell
npm run website:dev
```

- Open:
  - `http://localhost:3000/` (chooser)
  - `http://localhost:3000/original/`
  - `http://localhost:3000/qwik/`

### Website (Vercel Deploy)

- Recommended: connect Vercel to GitHub and set Root Directory to `website/qwik` (Qwik-only) or `website` (chooser + both).
- CLI (don’t add Vercel CLI as a repo dependency):

```powershell
cd website/qwik
npx vercel@latest
npx vercel@latest --prod
```

### Dashboard (Local)

```powershell
npm run dashboard
```

- Open: `http://localhost:3456/`

### CLI (Repo)

```powershell
node .\bin\synapse-unified.js --help
node .\bin\synapse-unified.js init
node .\bin\synapse-unified.js sync --all --conflict prompt
node .\bin\synapse-unified.js sync --dry-run --list-changes
node .\bin\synapse-unified.js analyze --top 10 --threshold 2000
node .\bin\synapse-unified.js enter-license
node .\bin\synapse-unified.js resend-license you@example.com
```

### CLI (Native Binaries)

- Build locally (requires Node.js + pkg):

```powershell
npm install
npm run build:binary:win
```

- Outputs go to `dist/` (platform-specific names).
- Note: the standalone binary supports the core CLI workflows (init/sync/watch/status/target). Server commands (`serve`, `dashboard`) require the Node.js (npm) version.

### VS Code Extension (Build / Run / Package)

- Build:

```powershell
cd extension
npm install
npm run compile
```

- Run: press `F5` to open the Extension Development Host, then use:
  - `Synapse: Initialize Project`
  - `Synapse: Sync Rules`
  - `Synapse: Analyze Tokens`
  - `Synapse: Upgrade to Pro`

- Package (VSIX):

```powershell
cd extension
npx @vscode/vsce@2.26.0 package
```
