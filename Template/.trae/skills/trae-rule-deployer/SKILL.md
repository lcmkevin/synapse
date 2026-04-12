---
name: "trae-rule-deployer"
description: "Deploys Trae Template (.trae) into a target project using trae-rule/trae-template CLI. Invoke when user asks to install, sync, check status, or hide .trae via .gitignore."
---

# Trae Rule Deployer

## What this does

This skill deploys the current repository's Trae Template folder into another project:
- Installs or updates `.trae/**` via `init` / `sync`
- Checks drift via `status`
- Optionally updates the target project's `.gitignore` to exclude `.trae/`

## When to invoke

Invoke when the user asks to:
- "deploy / install / init Trae rules into my project"
- "sync / update copied rules"
- "check status / compare template vs project"
- "hide rules / don’t disclose rules / add .gitignore for .trae"

## Workflow

1) Ask for:
- Target project path (default: current working directory)
- Mode: `symlink` (preferred) or `copy`
- Whether to add `.trae/` to the target `.gitignore`
- Whether to enable backups when overwriting (`--backup`)

2) Run commands

### Deploy rules

If the CLI is installed globally (after `npm link` or `npm i -g`):
- `trae-rule init "<projectPath>" --symlink`

If you are running from a cloned repo (no global install):
- `node "<path-to-repo>/bin/trae-template.js" init "<projectPath>" --symlink`

If the CLI is published to npm and you want "no install" usage:
- `npx --yes <npm-package-name> init "<projectPath>" --symlink`

If symlink fails or user prefers copies:
- `trae-rule init "<projectPath>" --copy`
- `node "<path-to-repo>/bin/trae-template.js" init "<projectPath>" --copy`

Use these safety options when overwriting:
- `--force --backup`

### Check drift

- `trae-rule status "<projectPath>"`
- `node "<path-to-repo>/bin/trae-template.js" status "<projectPath>"`

If it exits with non-zero code, show the "Different" and "Missing" lists to the user and suggest `sync` (copy-mode) or re-running `init`.

### Sync copied rules

Only for projects deployed with `--copy`:
- `trae-rule sync "<projectPath>"`
- `node "<path-to-repo>/bin/trae-template.js" sync "<projectPath>"`

If conflicts are reported, suggest either:
- Resolve manually (keep local edits), or
- `--force --backup` to overwrite while keeping backups.

### Hide `.trae/` from git

- `trae-rule gitignore "<projectPath>"`
- `node "<path-to-repo>/bin/trae-template.js" gitignore "<projectPath>"`

## Output expectations

- Prefer `--dry-run` if the user asks "what will this change?"
- Prefer `-v` when the user wants per-file details
- Use `--log-file=<path>` when the user wants persistent logs
