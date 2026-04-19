# Contributing to Labs Synapse

Thank you for your interest! Here’s how to help.

## Development Setup

```bash
git clone https://github.com/lcmkevin/synapse
cd synapse
npm install
npm run build
```

## Project Structure

```text
bin/         # CLI entrypoints
src/         # core logic + dashboard server
public/      # dashboard UI
extension/   # VS Code extension
standalone/  # MCP + WebSocket servers
website/     # marketing site (original + qwik)
```

## Adding a New IDE Adapter

1. Implement a new adapter in `extension/src/compiler/adapters/`
2. Register it in `extension/src/compiler/adapter-manager.ts`
3. Test by running “Synapse: Sync Rules” in the Extension Development Host
4. Submit a PR

## Running CI Locally

```bash
npm run build
npm test --if-present
```

## Pull Request Process

1. Fork the repo
2. Create a feature branch
3. Run `npm run build`
4. Submit PR with a clear description

## License

MIT
