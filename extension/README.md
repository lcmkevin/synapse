# Trae Rules & Skills Sync

## Features

- Conflict Detection (scan + click-to-locate + resolve-in-UI)
- Token Analysis (cl100k_base tokens + cost estimation + suggestions)
- Cross-platform export/import (Trae/Cursor/Cline/Windsurf/Copilot)
- Cost control quick copy + onboarding tour

## Screenshots

![Token Analysis](media/tour-token.svg)

![Conflict Detection](media/tour-conflict.svg)

![Cross-Platform Export](media/tour-compile.svg)

## Install (prototype)

- Run in Extension Host: press `F5` from the main repo workspace.
- Install VSIX (optional): `npm run package` then “Install from VSIX…” in Trae/VS Code.

## Quick test in Trae / VS Code

- Terminal (in `extension/`): `npm install`
- Press `F5` (Extension Host)
- Command Palette → try:
  - `Trae: Scan Conflicts`
  - `Trae: Analyze Tokens`
  - `Trae: Export Rules to...`
  - `Trae: Import Rules from...`
  - `Trae: Sync All`
  - `Trae: Copy Cost Control Rules`

## Build & package

```bash
npm run compile
npm run package
```

## Dependency notes

- `tiktoken` is used for token counting (cl100k_base).
