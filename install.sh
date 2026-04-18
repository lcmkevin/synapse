#!/bin/bash

set -euo pipefail

echo "🧠 Installing Synapse..."

npm install -g .

if [ -d "$HOME/.vscode/extensions" ]; then
  echo "📦 Linking VS Code extension..."
  ln -sf "$(pwd)/extension" "$HOME/.vscode/extensions/synapse"
fi

mkdir -p "$HOME/.local/share/applications" || true
cat > "$HOME/.local/share/applications/synapse-dashboard.desktop" << EOF
[Desktop Entry]
Name=Synapse Dashboard
Exec=synapse dashboard
Icon=synapse
Type=Application
Categories=Development;
EOF

echo ""
echo "✅ Synapse installed!"
echo ""
echo "Quick start:"
echo "  synapse init          # Initialize in current project"
echo "  synapse sync --all    # Compile rules for all IDEs"
echo "  synapse watch         # Auto-sync on changes"
echo "  synapse serve         # Start MCP/WebSocket servers"
echo "  synapse dashboard     # Start local dashboard"
echo ""
