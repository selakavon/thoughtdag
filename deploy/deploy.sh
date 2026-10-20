#!/usr/bin/env bash
# Deploy a change on the server: the one command. Run from anywhere: ~/x/thoughtdag/deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
git pull --ff-only
npm ci --no-audit --no-fund
npm run build
systemctl --user restart thoughtdag
sleep 3
curl -fs 127.0.0.1:9122/api/models >/dev/null && echo "thoughtdag answers on 127.0.0.1:9122"
