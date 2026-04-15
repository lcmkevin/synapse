# Trae Rule Deployer

Deploy and manage Trae `.trae/` rules/skills for any project.

This repo is structured as:
- CLI + local dashboard (safe to publish)
- VS Code / Trae extension (kept separate for prototyping and future paid features)

## Repo Structure

- CLI: [trae-template.js](file:///C:/MyProgram/Trae/bin/trae-template.js)
- Shared core: [core.js](file:///C:/MyProgram/Trae/src/core.js)
- Dashboard server: [server.js](file:///C:/MyProgram/Trae/src/server.js)
- Dashboard UI: [public](file:///C:/MyProgram/Trae/public)
- Template source: [Template](file:///C:/MyProgram/Trae/Template)
- Extension (prototype): [extension](file:///C:/MyProgram/Trae/extension)

## Quick Start (CLI)

From this repo folder (no install):

```powershell
node .\bin\trae-template.js help
```

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

## Quick Start (Dashboard)

```powershell
node .\bin\trae-template.js dashboard
```

Then open:
- `http://127.0.0.1:5177/`

Use the dashboard to:
- set Project Path (destination project folder)
- Init / Status / Sync / Add .gitignore
- Sync/Publish rules/skills from local folder or Git repo
- Preview preset sync changes and apply selectively
- Merge conflicts (git conflict or three-way merge)

## Commands

### dashboard

Start the local dashboard UI.

```powershell
node .\bin\trae-template.js dashboard
node .\bin\trae-template.js dashboard --port=5178
```

Then open:
- `http://127.0.0.1:5177/` (or the port you selected)

Dashboard usage (high level):
- Project Path: the destination project folder that will receive `.trae/`
- Template Root: usually leave empty (auto-filled); override only if you want a different Template folder
- Init/Status/Sync/Add .gitignore: same behavior as the CLI commands below
- Merge: uses either Git conflict stages (recommended when you have a real `git` conflict) or a three-way merge with base/ours/theirs files
- Sync/Publish: lets you import/export `.trae/rules` and `.trae/skills` using local folders or Git repos
- Preset Sync Preview: run Preview, then use Select Conflicts / Select Clean/Auto, and Apply Selected

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

### sync-rules

Copy rules into the target project's `.trae/rules`.

From a local folder:

```powershell
node .\bin\trae-template.js sync-rules C:\project --from C:\sourceProject --overwrite
```

From a team Git repo:

```powershell
node .\bin\trae-template.js sync-rules C:\project --repo git@github.com:org\trae-rules.git --branch main --overwrite
```

Notes:
- The source can be either a folder that contains `.trae/rules`, or a folder that contains `.trae/` (the tool will find the right subfolder).
- If you omit `--overwrite`, existing files are kept.
- Git usage requires `git` installed and authenticated (SSH recommended).

### sync-skills

Copy skills into the target project's `.trae/skills`.

```powershell
node .\bin\trae-template.js sync-skills C:\project --from C:\sourceProject --overwrite
node .\bin\trae-template.js sync-skills C:\project --repo git@github.com:org\trae-rules.git --branch main --overwrite
```

### publish

Publish the target project's `.trae/rules` and `.trae/skills` into a shared Git repository by cloning it, copying files, committing, and pushing.

```powershell
node .\bin\trae-template.js publish C:\project --repo git@github.com:org\trae-rules.git --branch main --message "Update rules"
```

Notes:
- Git usage requires `git` installed and authenticated (SSH recommended).
- If there are no file changes, publish is skipped.

### merge

Three-way merge using explicit file paths (base/ours/theirs). This uses `git merge-file` under the hood.

Print merged output to stdout:

```powershell
node .\bin\trae-template.js merge --base C:\tmp\base.md --ours C:\tmp\ours.md --theirs C:\tmp\theirs.md --diff3
```

Write merged output:

```powershell
node .\bin\trae-template.js merge --base C:\tmp\base.md --ours C:\tmp\ours.md --theirs C:\tmp\theirs.md --out C:\tmp\merged.md --apply --diff3
```

Exit code:
- `0` if merged cleanly
- `2` if conflict markers remain in the output

### merge-git

Merge a real Git conflict using the Git index stages `:1/:2/:3` (base/ours/theirs).

```powershell
node .\bin\trae-template.js merge-git .trae\rules\project_rules.md --repo C:\project --apply --diff3
```

Notes:
- Run this inside a repo that currently has that file conflicted, or pass `--repo`.
- If `--apply` is enabled and `--out` is not provided, it overwrites the conflicted working-tree file with the merged output.

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

## Basic Extension (Prototype)

The extension lives under [extension](file:///C:/MyProgram/Trae/extension) and is treated as a separate package during prototyping.

Basic commands it provides:
- Trae Rule: Setup (Init) Rules
- Trae Rule: Status
- Trae Rule: Sync (Copy Mode)
- Trae Rule: Add .trae/ to .gitignore
- Trae Rule: Open Dashboard
- Trae Rule: Doctor

