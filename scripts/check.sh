#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -m json.tool "$root/metadata.json" >/dev/null
python3 -m json.tool "$root/settings-schema.json" >/dev/null

cjs -c "const GLib=imports.gi.GLib; const ByteArray=imports.byteArray; let [ok,b]=GLib.file_get_contents('$root/desklet.js'); new Function(ByteArray.toString(b)); print('syntax-ok');"

if rg -n 'spawn_sync|spawn_command_line_sync|GTop|get_file_contents_utf8_sync' "$root/desklet.js"; then
    echo "Cinnamon unsafe scanner strings were found." >&2
    exit 1
fi

for file in metadata.json settings-schema.json desklet.js stylesheet.css README.md LICENSE; do
    test -f "$root/$file"
done

echo "bynum-machine-status-grid sanity checks passed"
