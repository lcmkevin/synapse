# Synapse Launch Checklist

This checklist is for manual/off-IDE launch execution.

## Pre-Launch (3 Days Before)

- [ ] Run `npm run build` in repo root and verify no errors
- [ ] Validate Pro path with `SYNAPSE_DEV=true`
- [ ] Validate free-tier path (no license): confirm 2 target limit
- [ ] Record a 30-60 second demo video
- [ ] Draft launch blog post
- [ ] Prepare Product Hunt listing draft
- [ ] Prepare Show HN post draft
- [ ] Deployment note: avoid installing Vercel CLI as a repo dependency; use `npx vercel@latest` when deploying

## Launch Day

### Product Hunt (Tuesday 12:01 AM PST)

1. Open `https://www.producthunt.com/products/new`
2. Use:
   - Title: `Synapse - One rulebase for Cursor, Trae, and Windsurf`
   - Tagline: `Write rules once. Deploy to any IDE automatically`
   - Topic: `Developer Tools`
3. Upload demo video
4. Publish and monitor comments

### Product Hunt Listing Template

- **Name:** Synapse
- **Tagline:** Write rules once. Deploy to any IDE automatically.
- **Description (short):** One rulebase. Any IDE. Forever.
- **Description (long):**
  - Synapse lets teams author rules once in `.synapse` format.
  - Compile to Trae and Cursor today, with more adapters over time.
  - Analyze token cost, gate Pro features with license keys, and integrate via MCP + WebSocket.
  - Free tier supports 2 IDE targets; Pro unlocks unlimited targets and lazy skill conversion.
- **Website:** `https://labs-synapse.com`
- **GitHub:** `https://github.com/lcmkevin/synapse`

### Show HN (Early Morning PST)

- **Title:** `Show HN: Synapse – One rule format for Cursor, Trae, Windsurf, and VS Code`
- **Post template:**

```text
I got tired of rewriting rules every time I switch IDEs (Cursor for
coding, Trae for PR reviews, Windsurf for debugging).

Synapse lets you write rules once in .synapse format, then
automatically compiles to each IDE's native format.

Free for 5 IDE adapters, $9 one-time for Pro (no recurring fees).

Tech: TypeScript, tiktoken for token counting, MCP server.

Would love feedback!
```

### Reddit Post Templates

#### r/vscode

**Title:** `Synapse: one rulebase for VS Code + Cursor + Trae`

**Body:**

```text
I built Synapse to avoid rewriting AI rules across tools.
You write rules once in .synapse, then sync to IDE-specific formats.

Current highlights:
- Trae + Cursor adapters
- token/cost analysis
- Pro license gating + lazy skill conversion
- MCP/WebSocket for universal integrations

Would appreciate feedback from VS Code users.
```

#### r/programming

**Title:** `Built an open-core rule orchestration tool for AI IDE workflows`

**Body:**

```text
I kept switching IDEs and duplicating rule files, so I built Synapse.
Core idea: keep one source of truth in .synapse and compile outputs for each tool.

Repo: https://github.com/lcmkevin/synapse
Site: https://labs-synapse.com

Would love technical feedback on architecture and roadmap.
```

#### r/cursor

**Title:** `Synapse now compiles shared rules into Cursor format`

**Body:**

```text
If you use Cursor plus other IDEs, Synapse can reduce duplicate rule maintenance.
Write once in .synapse and sync to .cursor/rules/*.mdc plus other targets.

Looking for feedback from Cursor-heavy workflows.
```

#### r/trae

**Title:** `Synapse workflow for Trae users: shared rulebase + sync`

**Body:**

```text
Synapse compiles .synapse rules to .trae outputs and helps keep rule management centralized.
Also includes token analysis and launch-stage Pro gating.

Would love to hear how Trae users currently manage cross-IDE rule drift.
```

### Twitter/X Thread Template

1. `🚀 Launching Synapse: One rulebase. Any IDE. Forever.`
2. `Problem: rewriting AI rules every time you switch tools wastes time + tokens.`
3. `Solution: write once in .synapse, sync to Trae + Cursor (more adapters coming).`
4. `Includes token cost analysis + Pro license gating + lazy skill conversion.`
5. `Universal integration: MCP + WebSocket server support.`
6. `Try it: https://labs-synapse.com`
7. `GitHub: https://github.com/lcmkevin/synapse`
8. `Would love feedback from builders and power users.`

## Post-Launch (Week 1)

- [ ] Respond to all comments within 24 hours
- [ ] Track GitHub stars (goal: 100 in week 1)
- [ ] Track VS Code installs (goal: 500 in week 1)
- [ ] Monitor Discord for support questions
- [ ] Fix critical bugs within 48 hours

## Post-Launch Tracking Guide

### What to track daily

- Product Hunt rank and upvotes
- Show HN rank and comment sentiment
- GitHub stars, watchers, and traffic
- VS Code installs and ratings
- Discord joins and support ticket volume
- Conversion signals: Pro inquiries / activations

### Logging format (simple)

- Date
- Channel (PH, HN, Reddit, X, GitHub, VS Code, Discord)
- Metric
- Value
- Notes / action needed

### Weekly review prompts

- Which channel brought the highest quality users?
- What questions repeated most in comments/support?
- Which onboarding step caused the most drop-off?
- What bugfixes or docs updates are highest leverage?
