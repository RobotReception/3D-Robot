#!/usr/bin/env bash
# Rebuild all robot GLBs (+ .blend sources and rig metadata) with Blender's Python API.
#   pip install bpy numpy   (Blender as a Python module, Python 3.11-3.13)
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
for style in friendly futuristic premium; do
  "$PY" blender/build_robot.py --style "$style" \
    --out "public/models/robot_${style}.glb" \
    --blend "assets/models/robot_${style}.blend" \
    --json "assets/models/robot_${style}.rig.json"
done
