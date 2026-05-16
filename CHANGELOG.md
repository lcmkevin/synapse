# Changelog

## [0.1.3] - 2026-05-16

- Extension: Optimizer/Detect now runs built-in local logic (no external `synapse` executable required).
- Extension: Control Center shows Init when not initialized and hides Best Practices UI once satisfied.
- Extension: Templates Gallery (selectable packs) installs optional rules into `.synapse/rules/` without overwriting.
- Website: Downloads page now includes a public Free dictionary JSON download.
- Rule Compressor: expanded Free built-in dictionary pairs.

## [0.1.1] - 2026-04-21

- Safer rule sync in CLI and VS Code extension (conflict prompts, dry-run, per-rule selection).
- Improved Pro license flow (Stripe Checkout, Supabase-backed validation, diagnostics command).
- IP protection rules/skills refined to reduce token overhead while keeping strong IP hygiene.
