# Trae Rules & Skills Sync – Extension Dev Notes

## Quick test in Trae / VS Code

1. Open this `extension/` folder as a workspace.
2. Terminal → `npm install` (first time only).
3. Press `F5` – a new Extension Host window opens.
4. In that window open any project folder you want to receive rules/skills.
5. Command Palette (`Ctrl/Cmd+Shift+P`) → run:
   - `Trae: Sync Rules into Workspace`
   - `Trae: Sync Skills into Workspace`
   - `Trae: Publish Rules/Skills to Team Repo`
   - `Trae: Resolve Merge Conflict`

All commands show progress notifications and info/error messages.

## Build & package

```bash
npm run compile      # TypeScript → JavaScript
vsce package         # creates trae-rules-sync-0.1.0.vsix
```

Install the `.vsix` in Trae via Extensions view → “Install from VSIX…”