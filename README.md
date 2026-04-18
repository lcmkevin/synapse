# Synapse

Intelligent rule & skill orchestration for AI-powered development.

Synapse uses a project-local master folder:
- `.synapse/`
  - `rules/`
  - `skills/`
  - `config.json`

## How It Works

- Author rules in `.synapse/rules/*.synapse`
- Run `Synapse: Sync Rules` (VS Code) to compile to IDE formats:
  - Trae: `.trae/*.trae`
  - Cursor: `.cursor/rules/*.mdc`
- Use the dashboard for deploy/status/sync/preview workflows.

## Quick Start (CLI)

From this repo folder:

```powershell
node .\bin\synapse-unified.js --help
node .\bin\synapse-unified.js init
node .\bin\synapse-unified.js sync --all
```

## Quick Start (Dashboard)

```powershell
npm run dashboard
```

Then open:
- `http://localhost:3456/`

## VS Code Extension

- Build: `cd extension && npm install && npm run compile`
- Run: press `F5` to open the Extension Development Host
- Commands:
  - `Synapse: Initialize Project`
  - `Synapse: Sync Rules`
  - `Synapse: Add Target IDE`

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
