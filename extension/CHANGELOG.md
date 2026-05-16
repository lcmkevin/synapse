# Changelog

## [0.1.6] - 2026-05-16

### Added

- Control Center: Templates Gallery with selectable packs (installs into `.synapse/rules/`, no overwrites).
- Control Center: Init vs Sync button state based on workspace initialization/rules detection.
- Init: auto-adds missing best-practice rules to `.synapse/rules/` (never modifies existing IDE rule files).
- Website: exposed Free dictionary JSON download via `/api/dictionary?public=1&tier=free`.

### Changed

- Optimizer/Detect: now runs built-in local optimizer in the extension (no external CLI required).
- License badge: Pro status is read from the machine-based license manager (consistent across workspaces).
- Rule Compressor: expanded Free built-in replacement pairs.

## [0.1.1] - 2026-04-21

### Added

- Safer `Synapse: Sync Rules` with overwrite prompts and optional rule selection.
- `Synapse: License Diagnostics` command for checking `/api/validate` status and reasons.
- Pro license activation wired to server-side validation (HMAC + Supabase status/expiry).

### Changed

- IP protection rules integrated with workspace settings to reduce prompt token usage.

## [0.1.0] - 2026-04-19

### Added

- Initial release
- Synapse rule format (`.synapse/`)
- Adapters for Trae and Cursor
- Token analysis with tiktoken
- Cost dashboard
- Pro license system (MVP)

### Coming Soon

- Windsurf adapter
- Cline adapter
- Team sync
- Cloud dashboard
