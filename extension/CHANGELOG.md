# Changelog

## [Unreleased]

### Added

- `synapse.proPriceLabel` and `synapse.proTermsLabel` settings to avoid hard-coded pricing copy.
- Cleanup/Uninstall flow to remove local Synapse data (home dir, workspace, extension storage).
- `synapse.compressionMetrics` opt-in setting (off/local/upload) for anonymized compression metrics.
- Control Center: dictionary sync status (last sync time + entry count).

### Changed

- Pro checkout requests now send `plan: "pro_lifetime"` (no client Stripe Price IDs).
- Pro messaging updated to “one-time payment • no recurring fees”.
- Control Center: auto-refresh token totals when rules change.
- Rule Compressor: Unicode-safe preprocessing (NFC normalization + smart quote normalization + Unicode-aware regexes).

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
