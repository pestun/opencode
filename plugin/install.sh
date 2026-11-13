#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
config_root=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode}
plugins_root="$config_root/plugins"
destination="$plugins_root/shared-history"

mkdir -p "$plugins_root"
staging=$(mktemp -d "$plugins_root/.shared-history.XXXXXX")
trap 'if [ -n "${staging:-}" ]; then rm -rf "$staging"; fi' EXIT

mkdir -p "$staging/node_modules/shared"
cp "$script_dir/package.json" "$staging/package.json"
cp -R "$script_dir/src" "$staging/src"
cp "$repo_root/shared/package.json" "$staging/node_modules/shared/package.json"
cp -R "$repo_root/shared/src" "$staging/node_modules/shared/src"
find "$staging/src" "$staging/node_modules/shared/src" -type f -name '*.test.ts' -delete

# OpenCode resolves a local package's conventional root server.ts before index.ts.
cat >"$staging/server.ts" <<'EOF'
export { default } from "./src/index"
EOF

rm -rf "$destination"
mv "$staging" "$destination"
staging=""

cat <<EOF
Installed shared-history to $destination

Add these exports to the environment used to launch opencode:
  export HISTORY_URL="http://history-host:8797"
  export HISTORY_TOKEN="replace-with-your-token"
  # Optional: defaults to the machine hostname.
  export HISTORY_HOST="host-a"

Restart opencode after setting the environment (for example, run
\`opencode service restart\`) before starting sessions.
EOF
