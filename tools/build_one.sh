#!/usr/bin/env bash
# rebuild a single style quickly: tools/build_one.sh concierge
set -euo pipefail
cd "$(dirname "$0")/.."
s="${1:?style}"
"${PYTHON:-python3}" blender/build_robot.py --style "$s" --out "assets/models/robot_${s}.raw.glb" --blend "assets/models/robot_${s}.blend" --json "assets/models/robot_${s}.rig.json" | tail -1
npx --no-install gltf-transform meshopt "assets/models/robot_${s}.raw.glb" "public/models/robot_${s}.glb" --level high 2>&1 | tail -1
rm -f assets/models/*.blend1
