# Languages (Local)

## Shell Scripts (bash)

- Use `#!/usr/bin/env bash` or `#!/bin/bash` consistently.
- Prefer `set -euo pipefail` for new scripts; handle expected failures explicitly.
- Quote variables: `"$var"`; avoid word-splitting and glob surprises.
- Use shellcheck guidance where practical.

## PHP

- Use strict types when possible: `declare(strict_types=1);`.
- Validate and sanitize all external input.
- Never log secrets (passwords, tokens, private keys).

## TypeScript / Node

- Prefer strict TS settings when available.
- Avoid `any` unless unavoidable; keep types narrow.
- Never commit `.env` files with real secrets.

## General

- Keep per-project, notable commands in `commands.md`.
- Keep security notes in `security.md`.
