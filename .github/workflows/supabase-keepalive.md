# Supabase Keepalive (GitHub Actions)

This repo includes a scheduled GitHub Actions workflow that pings your Supabase project daily to avoid free-tier inactivity pauses.

## What It Does

- Workflow file: `.github/workflows/supabase-keepalive.yml`
- Schedule: daily (see the `cron` in the workflow)
- Calls Supabase health endpoints using your project URL + anon key:
  - `${SUPABASE_URL}/auth/v1/health`
  - `${SUPABASE_URL}/realtime/v1/health`
  - `${SUPABASE_URL}/storage/v1/health`

## Where To Find The Keys In Supabase

In Supabase Dashboard:

- Select your project
- Project Settings (gear icon) → API
- Copy:
  - Project URL → set as `SUPABASE_URL`
  - Project API keys → `anon public` → set as `SUPABASE_ANON_KEY`

Do not use `service_role` for this keepalive job.

## How To Configure GitHub Secrets

In GitHub (for the same repo that contains the workflow file):

- Settings → Secrets and variables → Actions → New repository secret
- Add:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`

## How To Test In GitHub

GitHub Actions only runs workflows that exist on GitHub, so the workflow must be committed and pushed.

1. Commit and push `.github/workflows/supabase-keepalive.yml` (and this doc).
2. Go to GitHub → Actions → “Supabase Keepalive”.
3. Click “Run workflow” (manual trigger is enabled by `workflow_dispatch`).
4. Open the run logs:
   - Success looks like `OK: <service> (HTTP 200)`
   - Failures show which endpoint failed, its HTTP status, and the first part of the response body (no secrets are printed)

## Notes / Troubleshooting

- If you see “Missing secret: SUPABASE_URL” or “Missing secret: SUPABASE_ANON_KEY”, re-check repo secrets spelling.
- If requests fail with 401/403:
  - verify you used the `anon public` key (not service_role, not a JWT access token)
  - verify `SUPABASE_URL` is the project URL (no trailing spaces)
- If requests fail with 404:
  - verify `SUPABASE_URL` looks like `https://<project-ref>.supabase.co`
- If requests fail with 5xx:
  - the project may be paused or unhealthy; restore it in the Supabase dashboard first, then re-run the workflow
