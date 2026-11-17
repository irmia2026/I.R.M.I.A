#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )) || [[ "${2:-}" != '' && "${2:-}" != '--desktop' ]]; then
  echo 'Usage: bash scripts/package-linux.sh OUTPUT_DIR [--desktop]' >&2
  exit 2
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
mkdir -p -- "$1"
output="$(cd -- "$1" && pwd -P)"
if [[ "$output/" == "$root/dist/"* ]]; then
  echo 'Use an output directory outside dist/.' >&2
  exit 2
fi
cd -- "$root"
if [[ ! -f dist/main.js || ! -f dist/media/pillow-worker.py || ! -f dist/plugin/runners/node-runner.mjs ]]; then
  echo 'Run npm run build before packaging.' >&2
  exit 1
fi
desktop=false
name="irmia-linux-$(uname -m)-$(node -p "require('./package.json').version")"
if [[ "${2:-}" == '--desktop' ]]; then
  desktop=true
  name="$name-desktop"
  gui_bundle="$root/gui/build/linux/x64/release/bundle"
  if [[ ! -x "$gui_bundle/irmia_gui" ]]; then
    echo 'Build the x64 Flutter Linux release bundle first.' >&2
    exit 1
  fi
fi
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
bundle="$stage/$name"
mkdir -p -- "$bundle/scripts" "$bundle/docs"
cp -R -- dist skills "$bundle/"
cp -- README.md LICENSE config.example.json "$bundle/"
cp -- docs/linux-compatibility.md "$bundle/docs/"
cp -- scripts/irmia-agent.service "$bundle/scripts/"
if "$desktop"; then
  cp -R -- "$gui_bundle" "$bundle/gui"
  install -m 0755 scripts/start-linux-desktop.sh "$bundle/scripts/"
fi
tar -czf "$stage/$name.tar.gz" -C "$stage" "$name"
mv -- "$stage/$name.tar.gz" "$output/"
(cd -- "$output" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
printf '%s\n' "$output/$name.tar.gz"
