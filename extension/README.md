# 🧠 Synapse Rules

One rulebase. Any IDE. Forever.

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/labs-synapse.synapse-rules)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse-rules)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/labs-synapse.synapse-rules)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse-rules)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/labs-synapse.synapse-rules)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse-rules)

## Write Rules Once. Use Everywhere.

Stop copying rules between IDEs. Synapse compiles a single `.synapse` format to:

- ✅ Trae (`.trae/`)
- ✅ Cursor (`.cursor/rules/`)
- ✅ Windsurf (`.windsurf/`)
- ✅ Cline (`.clinerules/`)
- ✅ Zed (`.rules`)

## Features

### 📊 Token Cost Analysis

See how many tokens each rule costs and which rules dominate spend.

### 🔄 Sync

Compile `.synapse/rules/*.synapse` into enabled IDE targets.

### 🧠 Cost Dashboard

A sidebar dashboard that highlights total tokens, top expensive rules, and recommendations.

### 👥 Team Sync (Coming soon)

Reserved for a future release.

## Quick Start

1. Command Palette → Synapse: Initialize Project
2. Add rules under `.synapse/rules/`
3. Command Palette → Synapse: Sync Rules

## Commands

| Command | Description |
|---------|-------------|
| Synapse: Initialize Project | Creates `.synapse/` folder |
| Synapse: Sync Rules | Compiles to enabled IDEs |
| Synapse: Analyze Tokens | Shows token usage and cost |
| Synapse: Convert Large Rules to Skills | Converts large rules (Pro) |

## Pricing

- Free: manual downloads for 5 IDE adapters
- Pro ($9 one-time): One-click adapter updates, rollback, and future IDE adapters
- Team: Coming soon

## Links

- https://labs-synapse.com
- https://github.com/lcmkevin/synapse
