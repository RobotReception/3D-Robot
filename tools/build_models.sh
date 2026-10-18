#!/usr/bin/env bash
# Rebuild all robot models:
#   1. Blender (bpy) builds the mesh, rig, materials, shape keys -> assets/models/robot_<style>.raw.glb (+ .blend, rig.json)
#   2. gltf-transform compresses with Meshopt (EXT_meshopt_compression + quantization) -> public/models/robot_<style>.glb
# Requirements: `pip install bpy numpy` (Python 3.11-3.13) and `npm install`.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
mkdir -p public/models assets/models
for style in friendly futuristic premium; do
  "$PY" blender/build_robot.py --style "$style" \
    --out "assets/models/robot_${style}.raw.glb" \
    --blend "assets/models/robot_${style}.blend" \
    --json "assets/models/robot_${style}.rig.json"
  npx --no-install gltf-transform meshopt "assets/models/robot_${style}.raw.glb" "public/models/robot_${style}.glb" --level high
done
rm -f assets/models/*.blend1
ls -la public/models
