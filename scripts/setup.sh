set -euo pipefail
if ! command -v brew >/dev/null 2>&1; then /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; fi
brew list nvm >/dev/null 2>&1 || brew install nvm
mkdir -p ~/.nvm
export NVM_DIR="$HOME/.nvm"
source "$(brew --prefix nvm)/nvm.sh"
nvm install --lts
corepack enable
corepack prepare pnpm@latest --activate
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init
grep -RIl --exclude-dir=node_modules --exclude-dir=.git '@bowdoin/' . | xargs sed -i '' 's/@bowdoin-marketplace\//@bowdoin\//g' || true
rm -rf node_modules pnpm-lock.yaml ~/.pnpm-store
pnpm install -r
pnpm --filter @bowdoin/db exec prisma generate
pnpm --filter @bowdoin/db exec prisma migrate deploy
pnpm dlx husky install || true
chmod +x .husky/* || true
pnpm -r build
