#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
gui="$root/gui/irmia_gui"
if [[ ! -x "$gui" ]]; then
  gui="$root/gui/build/linux/x64/release/bundle/irmia_gui"
fi
if [[ ! -x "$gui" ]]; then
  echo 'Linux desktop bundle is missing. Run flutter build linux --release in gui/.' >&2
  exit 1
fi

node="${IRMIA_NODE:-node}"
port="${IRMIA_WEB_PORT:-7788}"
if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo 'IRMIA_WEB_PORT must be a port number between 1 and 65535.' >&2
  exit 1
fi
port="$((10#$port))"
export IRMIA_WEB_PORT="$port"
export IRMIA_DESKTOP_PORT="$port"

if [[ "${IRMIA_CONNECT_ONLY:-0}" == 1 ]]; then
  exec "$gui" "$@"
fi

if [[ ! -f "$root/dist/main.js" ]] || ! "$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'A built backend and Node.js 22 or later are required.' >&2
  exit 1
fi

probe() {
  "$node" --input-type=module - "$port" <<'JS'
const port = Number(process.argv[2]);
const base = 'http://127.0.0.1:' + port;
try {
  const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(750) });
  const health = await response.json();
  if (!['ready', 'starting', 'starting-timeout'].includes(health.status) ||
      typeof health.phase !== 'string' || health.port !== port) process.exit(2);
  if (health.status === 'ready') {
    const response = await fetch(base + '/api/instance', { signal: AbortSignal.timeout(750) });
    if (!response.ok || typeof (await response.json()).id !== 'string') process.exit(2);
  }
  process.exit(0);
} catch (error) {
  process.exit(error.cause?.code === 'ECONNREFUSED' ? 1 : 2);
}
JS
}

probe_status=0
probe || probe_status=$?
if (( probe_status == 2 )); then
  echo "Port $port is occupied or didn't answer as IRMIA. Choose another IRMIA_WEB_PORT." >&2
  exit 1
fi

if (( probe_status == 1 )); then
  config="${XDG_CONFIG_HOME:-$HOME/.config}"
  state="${XDG_STATE_HOME:-$HOME/.local/state}"
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  [[ "$config" == /* ]] || config="$HOME/.config"
  [[ "$state" == /* ]] || state="$HOME/.local/state"
  [[ "$data_home" == /* ]] || data_home="$HOME/.local/share"
  config="$config/irmia"
  state="$state/irmia"
  data="${IRMIA_DATA_DIR:-$data_home/irmia/data}"
  if [[ "$data" != /* ]]; then
    echo 'IRMIA_DATA_DIR must be absolute for the desktop launcher.' >&2
    exit 1
  fi
  mkdir -p -- "$config" "$state" "$data"
  export IRMIA_DESKTOP_DEFAULT_DATA_DIR="$data"
  (
    cd -- "$data"
    export IRMIA_SKILLS_SEED_DIR="$root/skills"
    exec nohup "$node" "$root/dist/main.js" --config "$config" --data-dir "$data" --port "$port"
  ) >>"$state/backend.log" 2>&1 </dev/null &
fi

exec "$gui" "$@"
