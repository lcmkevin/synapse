<!-- NEW: User guide created to document competitive advantages -->
# Synapse User Guide

## Installation

- VS Code: install the "Synapse Rules" extension
- CLI (repo): `node .\bin\synapse-unified.js --help`
- CLI (global install): use `synapse --help`

## Why Synapse? (Competitive Advantages)

### 1. Safe Sync with Rollback

Synapse supports safe recovery by backing up your `.synapse/` rule source before you change it, and by letting you rollback + re-sync outputs.

```bash
synapse backup list
synapse sync --all --conflict prompt --backup
synapse rollback --backup <name>
synapse backup restore --backup <name>
```

### 2. Proactive Cost Optimization

Synapse doesn’t just count tokens — it flags expensive always-on rules and suggests ways to reduce spend (for example, splitting large rules or moving long content into skills).

```bash
synapse analyze
synapse optimize
```

Pro users can auto-fix eligible issues:

```bash
synapse optimize --apply --backup
```

### 3. Conflict Detection

Synapse detects contradictory rule patterns before they get shipped to IDE outputs.

- Example: "never use X" vs "always use X" → potential conflict

```bash
synapse optimize
```

### 4. Multiple Interfaces

- CLI: best for automation (`synapse sync --all`)
- VS Code Extension: best for daily use (Command Palette → "Synapse: Sync Rules")
- MCP Server: best for agent integrations

```bash
synapse mcp
```

### 5. Zero Lock-In

Import existing rules from supported IDE folders into Synapse format, then sync to any target.

```bash
synapse importFromIDE
synapse sync --target cursor
```
