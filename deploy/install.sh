#!/usr/bin/env bash
# First-time install on sixkiller-server. Run from the checkout: deploy/install.sh
# Builds the app, writes ~/.config/thoughtdag/env once, installs and starts the user unit (no sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
NODE_BIN="$(dirname "$(command -v node)")"

npm ci --no-audit --no-fund
npm run build

mkdir -p ~/.config/thoughtdag
ENV="$HOME/.config/thoughtdag/env"
if [ ! -f "$ENV" ]; then
  umask 077
  cp deploy/env.example "$ENV"
  chmod 600 "$ENV"
  echo "wrote $ENV"
fi

mkdir -p ~/.config/systemd/user
sed "s|@NODE_BIN@|$NODE_BIN|g" deploy/thoughtdag.service > ~/.config/systemd/user/thoughtdag.service
systemctl --user daemon-reload
systemctl --user enable --now thoughtdag
sleep 3
curl -fs 127.0.0.1:9122/api/models >/dev/null && echo "thoughtdag answers on 127.0.0.1:9122"
