"""Texture-atlas kit for the robot builder (bpy 5.x, numpy + PIL).

One 2048x2048 atlas per model hosts every material family (fixed slots), so the
whole character ships with FOUR images:

- baseColor (+ baked AO multiplied in)  -> JPEG
- normal (Cycles-baked tangent normals incl. procedural micro-bump) -> PNG
- metallicRoughness (procedural per family) -> JPEG
- emissive (procedural LED gradients for face + rings) -> PNG

Every family maps into its slot through a single "atlas" UV layer written per
mesh; the emissive generator relies on the deterministic slot/sub-rect layout.
This module is bpy-free: pure numpy/PIL pattern + composition helpers.
"""
import math

import numpy as np

try:
    from PIL import Image
    _PIL = True
except ImportError:  # pragma: no cover
    _PIL = False

ATLAS = 2048

# family: (x, y, w, h) in atlas pixels (row 0 = canvas top). Deterministic so
# bakes and emissive drawing can rely on the same layout.
SLOTS = {
    "shell":   (0, 0, 1024, 1024),
    "shell2":  (1024, 0, 512, 512),
    "uniform": (1536, 0, 512, 512),
    "face":    (1024, 512, 512, 512),
    "visor":   (0, 1024, 512, 512),
    "dark":    (512, 1024, 512, 512),
    "accent":  (1024, 1024, 512, 512),
    "glow":    (1536, 1024, 256, 256),
}

# The five face meshes pack into fixed sub-rects of the "face" slot so the
# emissive generator knows where eyes/mouth/brows are. Slot-local pixels (<=512).
FACE_SUB = {
    "Eye_L":   (12, 12, 226, 226),
    "Eye_R":   (258, 12, 226, 226),
    "Brow_L":  (12, 258, 226, 96),
    "Brow_R":  (258, 258, 226, 96),
    "Mouth":   (12, 372, 472, 128),
}

DESIGN_VERSION = 2


# ------------------------------------------------------------------- patterns
def upsample2d(grid, h, w):
    """Bilinear stretch a small lattice to (h, w)."""
    im = Image.fromarray((np.clip(grid, 0.0, 1.0) * 255).astype(np.uint8)).convert("L")
    return np.asarray(im.resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0


def fbm(h, w, base=4, octaves=4, seed=0, gain=0.55):
    """Classic value-noise fBm in [0, 1]."""
    acc = np.zeros((h, w), dtype=np.float32)
    amp = 1.0
    total = 0.0
    for o in range(octaves):
        n = max(2, int(base) * (2 ** o))
        rng = np.random.default_rng(seed * 131 + o)
        g = rng.random((n, n)).astype(np.float32)
        acc += amp * upsample2d(g, h, w)
        total += amp
        amp *= gain
    return acc / total


def stretched(h, w, seed=0, stretch=12, base=3, octaves=3):
    """Anisotropic streak noise (brushed metal): noise stretched along one axis."""
    rng = np.random.default_rng(seed + 7)
    n = max(2, base)
    g = rng.random((n, n)).astype(np.float32)
    thin = upsample2d(g, h * stretch, w)
    return np.asarray(Image.fromarray((np.clip(thin, 0, 1) * 255).astype(np.uint8))
                      .convert("L").resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0


def weave(h, w, seed=0, cells=18, tint=0.55):
    """Fine twill weave: two opposing sin stripes + fibre noise, in [0,1]."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    c = cells / 2.0
    pat = 0.5 + 0.5 * np.sin((xx - yy) * math.pi * c) * np.sin((xx + yy) * math.pi * c)
    return np.clip(pat * tint + fbm(h, w, base=6, octaves=2, seed=seed) * 0.6, 0.0, 1.0)


def speckles(h, w, seed=0, freq=24, amt=0.35):
    """High-frequency micro scratches/dust: thresholded fbm."""
    f = fbm(h, w, base=freq, octaves=2, seed=seed)
    return (np.clip((f - 0.62) / 0.38, 0, 1) ** 2) * amt


def blobs(h, w, seed=1, cells=5, thresh=0.55, gain=0.9):
    """Low-frequency smudge/wear patches."""
    f = fbm(h, w, base=cells, octaves=3, seed=seed)
    return np.clip((f - thresh) / (1.0 - thresh), 0, 1) ** 1.5 * gain


def soft_ellipse(canvas, cx, cy, rx, ry, peak=1.0, falloff=1.6, exponent=2.5,
                 color=(1.0, 1.0, 1.0)):
    """Add a soft radial (superellipse) gradient in place (canvas HxWxC)."""
    h, w = canvas.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xr = (xx - cx) / max(rx, 1e-6)
    yr = (yy - cy) / max(ry, 1e-6)
    d = (np.abs(xr) ** exponent + np.abs(yr) ** exponent) ** (1.0 / exponent)
    v = (peak * np.clip(1.0 - d, 0.0, 1.0) ** falloff)[:, :, np.newaxis]
    canvas[:, :, :] = np.clip(canvas + v * np.asarray(color, dtype=np.float32), 0.0, 1.0)


# ------------------------------------------------------------------- family looks
class Look:
    """Material family knobs for the pattern generators."""

    def __init__(self, kind, rough, rough_var=0.12, metal=0.0, deposit=0.0, seed=1):
        self.kind = kind
        self.rough = float(rough)
        self.rough_var = float(rough_var)
        self.metal = float(metal)
        self.deposit = float(deposit)
        self.seed = int(seed)


def rough_field(fam, h, w):
    """Zero-centred roughness variation for one family."""
    si = fam.seed
    k = fam.kind
    if k == "shell":
        return (fbm(h, w, base=10, octaves=4, seed=si) - 0.5) * fam.rough_var \
            + speckles(h, w, seed=si + 3, freq=26, amt=0.10) \
            + blobs(h, w, seed=si + 11, cells=4, gain=0.25 * fam.deposit) * 0.30
    if k == "shell2":
        return (fbm(h, w, base=12, octaves=4, seed=si + 1) - 0.5) * (fam.rough_var * 1.2) \
            + speckles(h, w, seed=si + 21, freq=30, amt=0.12) * 0.06
    if k == "dark":
        return (stretched(h, w, seed=si + 5, stretch=14, base=2, octaves=2) - 0.5) * fam.rough_var * 1.6 \
            + (fbm(h, w, base=4, octaves=2, seed=si + 9) - 0.5) * 0.03
    if k == "uniform":
        return (weave(h, w, seed=si + 2) - 0.5) * fam.rough_var * 1.9 \
            + (fbm(h, w, base=8, octaves=3, seed=si + 4) - 0.5) * 0.06
    if k == "visor":
        return blobs(h, w, seed=si + 6, cells=3, gain=0.5 * fam.deposit) * 0.55 \
            + (fbm(h, w, base=3, octaves=2, seed=si + 13) - 0.5) * 0.02
    if k == "accent":
        return (fbm(h, w, base=8, octaves=3, seed=si + 8) - 0.5) * (fam.rough_var * 0.7)
    if k == "glow":
        return (fbm(h, w, base=6, octaves=2, seed=si + 12) - 0.5) * 0.05
    if k == "face":
        return (fbm(h, w, base=8, octaves=3, seed=si + 16) - 0.5) * 0.05
    return 0.0


def build_metal_rough(looks):
    """Compose the metallicRoughness atlas: G = roughness, B = metallic, R = 1
    (glTF spec unused channel). Unused families get a matte filler."""
    canvas = np.zeros((ATLAS, ATLAS, 3), dtype=np.float32)
    canvas[:, :, 0] = 1.0
    for family, (x0, y0, w, h) in SLOTS.items():
        fam = looks.get(family)
        if fam is None:
            canvas[y0:y0 + h, x0:x0 + w, 1] = 0.75
            continue
        slot = np.full((h, w), fam.rough, dtype=np.float32)
        slot += rough_field(fam, h, w)
        canvas[y0:y0 + h, x0:x0 + w, 1] = np.clip(slot, 0.03, 1.0)
        canvas[y0:y0 + h, x0:x0 + w, 2] = fam.metal
    return canvas


def empty_canvas(channels=3, fill=0.0):
    return np.full((ATLAS, ATLAS, channels), fill, dtype=np.float32)


NORMAL_STRENGTH = {
    "shell": 14.0, "shell2": 18.0, "dark": 12.0, "uniform": 10.0,
    "visor": 3.0, "accent": 12.0, "glow": 5.0, "face": 4.0,
}


def build_normal(looks):
    """Tangent-space normal atlas for the per-family micro-surface.

    Generated directly from the same deterministic detail fields as the
    roughness atlas. Empty atlas space stays neutral (0.5, 0.5, 1), so
    mipmaps and padding never inject invalid normals."""
    canvas = np.empty((ATLAS, ATLAS, 3), dtype=np.float32)
    canvas[:, :, 0] = 0.5
    canvas[:, :, 1] = 0.5
    canvas[:, :, 2] = 1.0
    for family, (x0, y0, w, h) in SLOTS.items():
        fam = looks.get(family)
        if fam is None or family in ("face", "glow"):
            continue
        seed = fam.seed
        kind = fam.kind
        if kind == "shell":
            height = fbm(h, w, base=8, octaves=4, seed=seed) \
                + blobs(h, w, seed=seed + 2, cells=5, gain=0.35) * 0.18 \
                + speckles(h, w, seed=seed + 3, freq=12, amt=0.12) * 0.12
        elif kind == "shell2":
            height = stretched(h, w, seed=seed + 1, stretch=10, base=3, octaves=3) * 0.7 \
                + fbm(h, w, base=12, octaves=3, seed=seed + 4) * 0.3
        elif kind == "dark":
            height = stretched(h, w, seed=seed + 5, stretch=18, base=2, octaves=2) * 0.75 \
                + fbm(h, w, base=10, octaves=3, seed=seed + 7) * 0.25
        elif kind == "uniform":
            height = weave(h, w, seed=seed + 2) * 0.8 \
                + fbm(h, w, base=10, octaves=3, seed=seed + 4) * 0.2
        elif kind == "visor":
            height = fbm(h, w, base=4, octaves=3, seed=seed + 6)
        else:
            height = fbm(h, w, base=9, octaves=3, seed=seed + 8)
        gy, gx = np.gradient(height.astype(np.float32))
        strength = NORMAL_STRENGTH.get(family, 24.0)
        nx = -gx * strength
        ny = -gy * strength
        inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
        slot = np.stack([
            nx * inv * 0.5 + 0.5,
            ny * inv * 0.5 + 0.5,
            inv * 0.5 + 0.5,
        ], axis=-1)
        canvas[y0:y0 + h, x0:x0 + w] = slot
    return canvas


def slot_fill(canvas, family, color, intensity=1.0):
    """Flat-fill one family region (used for the emissive ring strip)."""
    x0, y0, w, h = SLOTS[family]
    canvas[y0:y0 + h, x0:x0 + w, :] = np.clip(
        np.asarray(color, dtype=np.float32) * intensity, 0.0, 1.0)


def paste(canvas, family, img, flip_y=True):
    """Paste an HxWx3 (or HxW) numpy block into its slot, row 0 = canvas top.
    `flip_y` converts bottom-up bake images into top-down canvas space."""
    x0, y0, w, h = SLOTS[family]
    a = np.asarray(img, dtype=np.float32)
    if flip_y:
        a = a[::-1]
    a = np.clip(a, 0.0, 1.0)
    hb = min(h, a.shape[0])
    wb = min(w, a.shape[1])
    region = canvas[y0:y0 + hb, x0:x0 + wb]
    if a.ndim == 3:
        region[:] = a[:hb, :wb]
    else:
        region[:hb, :wb, :] = a[:hb, :wb, np.newaxis]


def subfill(canvas, sub_rect, img, flip_y=True):
    """Paste into a slot-local sub-rect (face family). canvas is a slot view."""
    x0, y0, w, h = sub_rect
    a = np.asarray(img, dtype=np.float32)
    if flip_y:
        a = a[::-1]
    a = np.clip(a, 0.0, 1.0)
    hb = min(h, a.shape[0])
    wb = min(w, a.shape[1])
    region = canvas[y0:y0 + hb, x0:x0 + wb]
    if a.ndim == 3:
        region[:] = a[:hb, :wb]
    else:
        region[:hb, :wb, :] = a[:hb, :wb, np.newaxis]


def to_pil(canvas):
    """Top-down float canvas -> PIL image with channels preserved."""
    if canvas.ndim == 2:
        return Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8))
    c = canvas.shape[2]
    if c == 3:
        return Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8), "RGB")
    if c == 4:
        return Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8), "RGBA")
    return Image.fromarray((np.clip(canvas[:, :, 0], 0, 1) * 255).astype(np.uint8))


def image_to_rgba(img):
    """bpy image (read-only via pixels, RGBA, bottom-up) -> top-down numpy."""
    w = img.size[0]
    h = img.size[1]
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    a = buf.reshape(h, w, 4)  # bottom-up RGBA
    return a[::-1, :, :3].copy()  # top-down RGB


# ------------------------------------------------------------- emissive atlas
def _rr_mask(h, w, cx, cy, rx, ry, r):
    """Soft rounded-rect mask [h,w] in [0,1]: 1 inside, smooth fresnel rim r."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dxr = np.maximum(np.abs(xx - cx) - max(rx - r, 0.0), 0.0)
    dyr = np.maximum(np.abs(yy - cy) - max(ry - r, 0.0), 0.0)
    d = np.sqrt(dxr * dxr + dyr * dyr)
    m = 1.0 - np.clip(d / max(r, 1e-6), 0.0, 1.0) ** 0.8
    m[d > r] = 0.0
    return m


def _grille(mask, cell=13.0, gap=2.2, dim=0.62):
    """LED-matrix seam dimming: thin seam rows/cols every `cell` px."""
    mh, mw = mask.shape[:2]
    yy, xx = np.mgrid[0:mh, 0:mw].astype(np.float32)
    seams = ((yy % cell) < gap) | ((xx % cell) < gap)
    out = mask * (1.0 - seams * (1.0 - dim))
    return out


def _teeth(mask, cell=9.0, gap=1.8, dim=0.55):
    """Vertical LED teeth for the mouth bar."""
    mh, mw = mask.shape[:2]
    xx = np.mgrid[0:mh, 0:mw][1].astype(np.float32)
    seams = (xx % cell) < gap
    return mask * (1.0 - seams * (1.0 - dim))


def _blend_add(view, x0, y0, mask, color):
    """Additive paste `mask * color` at (x0, y0), clipped to the view."""
    x0, y0 = int(x0), int(y0)
    vh, vw = view.shape[:2]
    ax, ay = max(x0, 0), max(y0, 0)
    bx, by = min(x0 + mask.shape[1], vw), min(y0 + mask.shape[0], vh)
    if bx <= ax or by <= ay:
        return
    sub = mask[ay - y0: by - y0, ax - x0: bx - x0]
    view[ay:by, ax:bx] = np.clip(
        view[ay:by, ax:bx]
        + (sub[:, :, np.newaxis] if sub.ndim == 2 else sub)
        * np.asarray(color, dtype=np.float32), 0.0, 1.0)


def _eye_mask(rw, rh, p, hot_x=0.60, hot_y=0.30):
    """Frosted-glass LED panel for one eye: glow floor + core + specular dot."""
    cx, cy = rw * 0.5, rh * 0.5
    bezel = _rr_mask(rh, rw, cx, cy, rw * 0.46, rh * 0.46, min(rw, rh) * 0.42)
    yy, xx = np.mgrid[0:rh, 0:rw].astype(np.float32)
    xr = (xx - cx) / max(rw * 0.36, 1e-6)
    yr = (yy - cy) / max(rh * 0.40, 1e-6)
    d = (np.abs(xr) ** p + np.abs(yr) ** p) ** (1.0 / p)
    core = np.clip(1.0 - d, 0.0, 1.0) ** 1.15
    hx, hy = rw * hot_x, rh * hot_y
    hxr = (xx - hx) / max(rw * 0.16, 1e-6)
    hyr = (yy - hy) / max(rh * 0.13, 1e-6)
    hd = (hxr * hxr + hyr * hyr) ** 0.5
    hotspot = np.clip(1.0 - hd, 0.0, 1.0) ** 1.6
    return bezel * 0.42 + core * 0.9 + hotspot, cy


def draw_face_emissive(canvas, info, layout):
    """Draw the LED face: segmented grille eyes, dash brows, mouth bar + glow fill.

    info: {
      glow: (r,g,b) style emissive colour,
      eye_p: superellipse exponent,
      hide_idle: bool (mascot rests content; mouth/brows stay off),
      eye:   {"half_w","half_h"}, brow: {"half_w","th"}, mouth: {"half_w","th"},
      centers: {name: (x,z)} planar metres,
    }
    layout: {name: {"rect": (x0,y0,w,h) slot-local px, "bbox": (minx,minz,dx,dz)}}

    Shapes are drawn in each sub-rect's LOCAL frame (rect centre = mesh bbox
    centre), so drift of the planar bake never tilts the LED rig. Grille seams
    give the hardware LED-matrix read; the glow slot stays a flat fill.
    """
    glow = np.clip(np.asarray([max(c, 0.0) for c in info["glow"]], dtype=np.float32), 0.0, 1.0)

    face_on = not info.get("hide_idle", False)
    p = float(info.get("eye_p", 2.7))
    ox, oy = SLOTS["face"][0], SLOTS["face"][1]

    for name in ("Eye_L", "Eye_R"):
        if name not in layout:
            continue
        rx, ry, rw, rh = [float(v) for v in layout[name]["rect"]]
        m, _ = _eye_mask(rw, rh, p)
        m = _grille(m, cell=max(9.0, rw * 0.055), gap=2.3, dim=0.78)
        _blend_add(canvas, ox + rx, oy + ry, np.clip(m, 0.0, 1.0), (glow * 0.92).tolist())

    if face_on and "Brow_L" in layout and "Brow_R" in layout:
        for name in ("Brow_L", "Brow_R"):
            rx, ry, rw, rh = [float(v) for v in layout[name]["rect"]]
            bh = max(4.0, rh * 0.34)
            m = np.zeros((int(rh), int(rw)), dtype=np.float32)
            for k, fx in enumerate((0.16, 0.50, 0.84)):
                skew = (0.10, 0.0, 0.10)[k]
                cy = rh * (0.5 + skew * 0.5)
                dash = _rr_mask(int(rh), int(rw), rw * fx, cy,
                                rw * 0.15, bh * 0.5, bh * 0.5)
                m = np.maximum(m, dash)
            m = _grille(m, cell=max(9.0, rw * 0.08), gap=1.6, dim=0.7)
            _blend_add(canvas, ox + rx, oy + ry, np.clip(m, 0.0, 1.0), (glow * 0.85).tolist())

    if face_on and "Mouth" in layout:
        rx, ry, rw, rh = [float(v) for v in layout["Mouth"]["rect"]]
        bw = rw * 0.66
        bh = max(5.0, rh * 0.36)
        m = _rr_mask(int(rh), int(rw), rw * 0.5, rh * 0.5, bw * 0.5, bh * 0.5, bh * 0.5)
        m = _teeth(m, cell=max(6.0, bw * 0.075), gap=1.9, dim=0.65)
        _blend_add(canvas, ox + rx, oy + ry, np.clip(m, 0.0, 1.0), (glow * 0.85).tolist())

    slot_fill(canvas, "glow", glow, 1.0)


def draw_face_color(canvas, info, layout):
    """Dim off-state LED hardware into the face slot: dark bezel + faint dots.

    Runs on the COLOR canvas after AO bakes so the resting face reads as an
    LED module behind glass instead of plain paint."""
    dk = 0.10
    glow = np.clip(np.asarray(info["glow"], dtype=np.float32), 0.0, 1.0)
    glow_off = (glow * 0.45 * 0.18).tolist()
    ox, oy = SLOTS["face"][0], SLOTS["face"][1]

    for name in ("Eye_L", "Eye_R", "Brow_L", "Brow_R", "Mouth"):
        if name not in layout:
            continue
        rx, ry, rw, rh = [float(v) for v in layout[name]["rect"]]
        w, h = int(rw), int(rh)
        if w <= 1 or h <= 1:
            continue
        x0, y0 = int(ox + rx), int(oy + ry)
        bez = _rr_mask(h, w, w * 0.5, h * 0.5, w * 0.46, h * 0.46, min(w, h) * 0.42)
        canvas[y0:y0 + h, x0:x0 + w] *= (1.0 - bez[:, :, np.newaxis] * dk)
        if name.startswith("Eye"):
            m, _ = _eye_mask(w, h, float(info.get("eye_p", 2.7)))
            m = _grille(m, cell=max(9.0, w * 0.055), gap=2.3, dim=0.7)
            _blend_add(canvas, x0, y0, np.clip(m, 0.0, 1.0), glow_off)

