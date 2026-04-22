# Changelog

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
