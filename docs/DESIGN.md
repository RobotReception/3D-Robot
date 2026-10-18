# Character design: three directions, comparison, decision

All three are **original** designs produced by the same generator (`blender/build_robot.py --style <name>`) on the **same skeleton and morph targets**, so any of them can be driven by the same code. Renders below come from the real GLBs in the real engine (`docs/screenshots/design-directions.png`).

![Design directions](screenshots/design-directions.png)

| | Friendly Robot | Futuristic Robot | Premium AI Assistant (**chosen**) |
|---|---|---|---|
| Idea | Warm, approachable personal helper | Sleek, tall, technical | Calm, minimal, product-grade |
| Proportions | Largest head (r 0.255 m), short thick limbs, 1.52 m | Smallest head, long slim limbs, boxier shell (superellipsoid exponent 0.5), 1.55 m | Balanced head (r 0.215 m), slender limbs, 1.57 m |
| Materials | Ivory glossy shell, orange accents, low metalness | Gunmetal metallic shell, violet accents, high metalness | Pearl-white clear-coated shell, champagne accents, graphite joints |
| Light | Cyan LED face | Violet LED face | Soft blue LED face |
| Strengths | Highest "cute" factor, face reads at small sizes | Distinctive silhouette, strong on dark UIs | Neutral enough for enterprise yet friendly; best contrast of face on any background; ages well |
| Weaknesses | Can feel childish for B2B | Less approachable, metal needs good lighting/env map | Least distinctive silhouette; differs from "friendly" mostly by finish |
| Fit | Consumer assistants, kids/education | Gaming, tech demos | Platforms, enterprise products, kiosks |

## Decision

**Premium AI Assistant** is the default (`/models/robot_premium.glb`): its pearl shell + dark visor gives the highest contrast for the expressive LED face (the part users watch most), it reads as friendly *and* professional, and the champagne/graphite palette can be rebranded by changing four colours in `STYLES["premium"]` and rebuilding. The other two ship as selectable variants (Studio → Style) and prove the rig is style-independent. The visual identity can evolve later (colours, antenna/ears, chest emblem) without touching the engine.

## Anatomy (requirements → implementation)

- **Head**: superellipsoid shell, dark glass *visor*, side ear discs with glowing rings, antenna with glowing tip. Rotates on `neck`/`head` bones.
- **Eyes**: two flat emissive 3D meshes on the visor with 8 shape keys each (blink, squint, wide, happy ^_^, sad, angry, surprised, curious); gaze = translation of `eye_L/R` bones inside the visor.
- **Mouth**: one emissive mesh with 19 shape keys (15 visemes + open, smile, frown, surprise). **Brows**: two bar meshes × 4 shape keys.
- **Torso**: chest shell with accent plate and glowing core, back unit, dark waist joint, pelvis shell.
- **Arms/hands**: clavicle, upper arm, forearm, wrist band, palm and **4 digits × 2 phalanges** per hand (individually controllable).
- **Legs**: hip ball joint, thigh, knee, shin, ankle, shoe with toe cap and sole (toe bone).
- **Materials**: PBR metal/roughness with clear-coat (`KHR_materials_clearcoat`), emissive glow (`Mat_Glow`, `Mat_Face`), no textures → resolution-independent, tiny files.
- **Mechanical detail**: joint balls + accent rings at wrists/ankles/waist — "mechanical but not busy". Joints are rigid segments with ball joints, so bending never stretches or tears the mesh (no skin-weight artefacts); pieces are sized so that the range-of-motion limits keep them apart (checked visually on the pose contact sheets; there is **no automated mesh-collision test**, so a custom pose outside the built-in clips can still make an arm pass through the torso).

## Budget

29,272 triangles / 14,903 vertices / 11 skinned meshes per model; 981 KB raw GLB → **194 KB** with Meshopt.

## Editing / extending the design

1. Edit `blender/build_robot.py` (palette, proportions, parts) or open `assets/models/robot_<style>.blend` in Blender.
2. Keep bone and shape-key names (see [RIG.md](RIG.md)); the engine validates them at load.
3. `npm run model:build` regenerates GLBs, `.blend` files and `rig.json`; `npm run docs:gen` refreshes RIG.md.
