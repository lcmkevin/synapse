# Trae Rule Deployer

Quickly deploy Trae `.trae/` rules into any development project (copy or symlink), with status/sync support and a helper to add `.trae/` into `.gitignore`.

## Quick Start

From this repo folder (no install):

```powershell
node .\bin\trae-template.js help
```

Easiest workflow (dashboard-first):

```powershell
node .\bin\trae-template.js dashboard
```

Use the dashboard to:
- enter (or create) a new project folder path
- click Init (copy or symlink)
- optionally add `.trae/` to `.gitignore`

Then open that project folder in Trae.

Deploy to a target project:

```powershell
node .\bin\trae-template.js init C:\path\to\project --copy
```

Interactive mode:

```powershell
node .\bin\trae-template.js init --interactive
```

Optional: install a command name (`trae-rule`) for easier usage:

```powershell
npm link
trae-rule help
```

## Commands

### dashboard

Start the local dashboard UI.

```powershell
node .\bin\trae-template.js dashboard
node .\bin\trae-template.js dashboard --port=5178
```

Then open:
- `http://127.0.0.1:5177/` (or the port you selected)

### init

Deploy `Template/.trae/**` into `<projectPath>/.trae/**`.

```powershell
node .\bin\trae-template.js init C:\project --symlink
node .\bin\trae-template.js init C:\project --copy
node .\bin\trae-template.js init C:\project --copy --force --backup
node .\bin\trae-template.js init C:\project --copy --dry-run
```

Notes:
- `--symlink` is the default; if symlink fails on Windows, it falls back to `copy`.
- `--backup` keeps a copy of any file that will be overwritten by renaming it to `*.bak.YYYYMMDD_HHMMSS` first (use together with `--force`).
  - Example: `.trae/rules/tooling.md` becomes `.trae/rules/tooling.md.bak.20260412_080427`

### status

Compare target project `.trae/**` against the template.

```powershell
node .\bin\trae-template.js status C:\project
```

Exit code:
- `0` if everything matches
- `2` if there are `Different` or `Missing` files (useful for CI)

### sync

Sync only applies to projects deployed with `--copy` mode.

```powershell
node .\bin\trae-template.js sync C:\project
node .\bin\trae-template.js sync C:\project --force --backup
```

Exit code:
- `0` if no conflicts
- `2` if conflicts exist (local edits detected; use `--force --backup` if you want to overwrite)

### gitignore

Add `.trae/` to the target project's `.gitignore` (to avoid disclosing your rules).

```powershell
node .\bin\trae-template.js gitignore C:\project
node .\bin\trae-template.js gitignore C:\project --dry-run
```

## Common Flags

```text
-v, --verbose           Show per-file actions
-q, --quiet             Only show errors
--log-file=PATH         Append logs to a file
```

## Optional: install as a local command

This repo defines two command names: `trae-template` and `trae-rule`.

```powershell
npm link
trae-rule help
trae-rule init C:\project --copy
```

## Template source

Edit files under:
- `Template/.trae/`

They will be deployed into the target project's:
- `.trae/`

## Privacy note

If you don't want to disclose your rules, add `.trae/` to your project's `.gitignore` (or use the `gitignore` command above).

