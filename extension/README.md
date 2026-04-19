# 🧠 Synapse Rules

One rulebase. Any IDE. Forever.

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/labs-synapse.synapse)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/labs-synapse.synapse)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/labs-synapse.synapse)](https://marketplace.visualstudio.com/items?itemName=labs-synapse.synapse)

## Write Rules Once. Use Everywhere.

Stop copying rules between IDEs. Synapse compiles a single `.synapse` format to:

- ✅ Trae (`.trae/`)
- ✅ Cursor (`.cursor/rules/`)
- 🧩 Windsurf (planned)
- 🧩 Cline (planned)

## Features

### 📊 Token Cost Analysis

See how many tokens each rule costs and which rules dominate spend.

### 🔄 Sync

Compile `.synapse/rules/*.synapse` into enabled IDE targets.

### 🧠 Cost Dashboard

A sidebar dashboard that highlights total tokens, top expensive rules, and recommendations.

### 👥 Team Sync (Pro)

Unlock Pro features via license key (MVP gate).

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

- Free: 2 IDE targets, basic token analysis
- Pro ($9/mo): Unlimited IDEs, auto-convert to skills, analytics
- Team ($49/mo): Team sync, audit logs, SSO

## Links

- https://labs-synapse.com
- https://github.com/labs-synapse/synapse
