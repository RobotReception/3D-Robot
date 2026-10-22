"""
Robot Avatar Engine - procedural character builder (Blender / bpy).

Builds a fully rigged robot (armature + skinned meshes + PBR materials + facial
shape keys) from code and exports it as GLB.  Fully reproducible:

    pip install bpy numpy
    python blender/build_robot.py --style premium --out public/models/robot_premium.glb

Three style variants share the same skeleton hierarchy and morph-target names, so
the runtime engine drives all of them identically (rest proportions differ).

Coordinate conventions (Blender, Z-up): the robot faces -Y, its LEFT side is +X.
glTF export converts to Y-up so the robot faces +Z, left side stays +X.
"""
import argparse
import json
import math
import os
import sys

import bpy  # noqa: must be imported before bmesh
import bmesh  # noqa: E402
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atlas  # noqa: E402  (texture atlas kit, numpy+PIL based)

# --------------------------------------------------------------------------- styles
STYLES = {
    # Warm, rounded, approachable.
    "friendly": dict(
        head_r=0.255, head_sq=(1.0, 0.9, 0.88), e_head=0.78, torso=(0.175, 0.135, 0.17),
        e_box=0.72, thigh=0.215, shin=0.215, limb_r=0.054, upper=0.19, fore=0.19, chest_h=0.2,
        shell=(0.93, 0.92, 0.88), shell2=(0.78, 0.80, 0.82), dark=(0.07, 0.075, 0.09),
        accent=(0.98, 0.52, 0.16), glow=(0.04, 0.62, 1.0), metal=0.15, rough=0.32, coat=0.6,
        eye=(0.115, 0.135), mouth_w=0.07,
    ),
    # Angular, tall, neon.
    "futuristic": dict(
        head_r=0.2, head_sq=(1.0, 0.95, 0.8), e_head=0.5, torso=(0.16, 0.12, 0.185),
        e_box=0.5, thigh=0.29, shin=0.29, limb_r=0.042, upper=0.215, fore=0.215, chest_h=0.23,
        shell=(0.13, 0.14, 0.17), shell2=(0.30, 0.32, 0.38), dark=(0.03, 0.03, 0.04),
        accent=(0.75, 0.2, 1.0), glow=(0.36, 0.12, 1.0), metal=0.85, rough=0.22, coat=0.9,
        eye=(0.13, 0.085), mouth_w=0.06,
    ),
    # Elegant, restrained, enterprise.
    "premium": dict(
        head_r=0.215, head_sq=(1.0, 0.92, 0.9), e_head=0.72, torso=(0.165, 0.12, 0.185),
        e_box=0.68, thigh=0.265, shin=0.265, limb_r=0.044, upper=0.2, fore=0.2, chest_h=0.22,
        shell=(0.95, 0.95, 0.96), shell2=(0.62, 0.64, 0.68), dark=(0.05, 0.055, 0.065),
        accent=(0.83, 0.68, 0.40), glow=(0.06, 0.42, 1.0), metal=0.55, rough=0.2, coat=1.0,
        eye=(0.105, 0.12), mouth_w=0.058,
    ),
    # Realistic humanoid receptionist: human proportions (1.76 m), panelled white shell, navy uniform, glowing ring joints.
    "concierge": dict(
        kind="humanoid", head_r=0.13, head_sq=(0.88, 0.96, 1.12), e_head=0.85, torso=(0.195, 0.12, 0.17),
        e_box=0.75, thigh=0.405, shin=0.39, limb_r=0.045, upper=0.30, fore=0.27, chest_h=0.32, hip_x=0.10, foot=1.22,
        shell=(0.97, 0.97, 0.98), shell2=(0.80, 0.82, 0.86), dark=(0.015, 0.016, 0.02), accent=(0.78, 0.8, 0.84),
        uniform=(0.035, 0.06, 0.15), glow=(0.0, 0.32, 1.0), metal=0.0, rough=0.2, coat=1.0, eye=(0.058, 0.066), eye_p=2.1,
        mouth_w=0.04,
    ),
    # Chibi mascot: huge head, small egg body, stubby limbs, glowing rings (cute assistant for kiosks/apps).
    "mascot": dict(
        kind="mascot", head_r=0.35, head_sq=(1.0, 0.9, 0.83), e_head=1.0, torso=(0.172, 0.15, 0.2),
        e_box=0.9, thigh=0.05, shin=0.055, limb_r=0.048, upper=0.085, fore=0.075, chest_h=0.06, hip_x=0.072, foot=0.8,
        ankle=0.04, sh_x=0.168, hand_scale=0.55, default_emotion="content",
        shell=(0.95, 0.95, 0.965), shell2=(0.72, 0.74, 0.86), dark=(0.01, 0.011, 0.016), accent=(0.36, 0.36, 0.72),
        glow=(0.16, 0.32, 1.0), metal=0.0, rough=0.34, coat=0.6, eye=(0.125, 0.11), eye_p=2.0, mouth_w=0.035,
        eye_x_k=0.33, eye_z_k=0.035, mouth_z_k=0.3, visor_w=0.70, visor_h=0.64, visor_z=0.12, hide_idle_face=True, glow_strength=2.4, face_strength=1.6,
    ),
}

FINGERS = ["thumb", "index", "middle", "ring"]
EYE_NU, EYE_NV = 33, 9
MOUTH_NU, MOUTH_NV = 41, 7


# --------------------------------------------------------------------------- layout
def layout(S):
    """Joint positions (Blender space)."""
    L = {}
    ankle = S.get("ankle", 0.085)
    knee = ankle + S["shin"]
    hip = knee + S["thigh"]
    pel = hip + 0.035
    spine = pel + 0.07
    chest = spine + 0.13
    neck = chest + S["chest_h"]
    hr, sq = S["head_r"], S["head_sq"]
    head_pivot = neck + 0.05
    head_c = head_pivot + hr * sq[2] * 0.92
    sh_z = neck - 0.075
    sh_x = S.get("sh_x", S["torso"][0] + S["limb_r"] + 0.03)
    elbow = sh_z - S["upper"]
    wrist = elbow - S["fore"]
    L.update(ankle=ankle, knee=knee, hip=hip, pel=pel, spine=spine, chest=chest, neck=neck,
             head_pivot=head_pivot, head_c=head_c, sh_z=sh_z, sh_x=sh_x, elbow=elbow, wrist=wrist,
             hip_x=S.get("hip_x", 0.095 if S["thigh"] < 0.25 else 0.09))
    return L


def build_bones(S, L):
    """Return ordered [(name, parent, head, tail)] in Blender space."""
    V = lambda x, y, z: Vector((x, y, z))
    B = []
    B.append(("root", None, V(0, 0, 0), V(0, 0, 0.12)))
    B.append(("pelvis", "root", V(0, 0, L["pel"]), V(0, 0, L["spine"])))
    B.append(("spine", "pelvis", V(0, 0, L["spine"]), V(0, 0, L["chest"])))
    B.append(("chest", "spine", V(0, 0, L["chest"]), V(0, 0, L["neck"])))
    B.append(("neck", "chest", V(0, 0, L["neck"]), V(0, 0, L["head_pivot"])))
    hr = S["head_r"]
    B.append(("head", "neck", V(0, 0, L["head_pivot"]), V(0, 0, L["head_c"] + hr * S["head_sq"][2])))
    # eyes: bones sit at the eye centre; gaze is a translation inside the visor plane (no tilt)
    ex, ez = S["eye"][0] * 0.0 + hr * 0.36, L["head_c"] + hr * 0.04
    face_y = -hr * S["head_sq"][1] * 1.04
    for side, sx in (("L", 1), ("R", -1)):
        B.append((f"eye_{side}", "head", V(sx * ex, face_y, ez), V(sx * ex, face_y - 0.04, ez)))
    for side, sx in (("L", 1), ("R", -1)):
        shx, shz = L["sh_x"] * sx, L["sh_z"]
        B.append((f"clavicle_{side}", "chest", V(sx * (S["torso"][0] * 0.45), 0, shz), V(shx, 0, shz)))
        B.append((f"upperarm_{side}", f"clavicle_{side}", V(shx, 0, shz), V(shx, 0, L["elbow"])))
        B.append((f"forearm_{side}", f"upperarm_{side}", V(shx, 0, L["elbow"]), V(shx, 0, L["wrist"])))
        hs = S.get("hand_scale", 1.0)
        B.append((f"hand_{side}", f"forearm_{side}", V(shx, 0, L["wrist"]), V(shx, 0, L["wrist"] - 0.07 * hs)))
        base_z = L["wrist"] - 0.092 * hs
        for fi, fname in enumerate(FINGERS):
            if fname == "thumb":
                fx, fy, dirv = shx - sx * 0.026 * hs, -0.062 * hs, V(-sx * 0.004, -0.012, -1).normalized()
                z0 = L["wrist"] - 0.045 * hs
            else:
                fx = shx
                fy = {"index": -0.034 * hs, "middle": 0.0, "ring": 0.034 * hs}[fname]
                dirv = V(0, 0, -1)
                z0 = base_z
            l1, l2 = ((0.04, 0.034) if fname != "thumb" else (0.034, 0.03))
            l1, l2 = l1 * hs, l2 * hs
            p0 = V(fx, fy, z0)
            p1 = p0 + dirv * l1
            p2 = p1 + dirv * l2
            B.append((f"finger_{fname}_1_{side}", f"hand_{side}", p0, p1))
            B.append((f"finger_{fname}_2_{side}", f"finger_{fname}_1_{side}", p1, p2))
    for side, sx in (("L", 1), ("R", -1)):
        hx = L["hip_x"] * sx
        B.append((f"thigh_{side}", "pelvis", V(hx, 0, L["hip"]), V(hx, 0, L["knee"])))
        B.append((f"shin_{side}", f"thigh_{side}", V(hx, 0, L["knee"]), V(hx, 0, L["ankle"])))
        fl = S.get("foot", 1.0)
        B.append((f"foot_{side}", f"shin_{side}", V(hx, 0, L["ankle"]), V(hx, -0.1 * fl, 0.045 * L["ankle"] / 0.085)))
        B.append((f"toe_{side}", f"foot_{side}", V(hx, -0.1 * fl, 0.045 * L["ankle"] / 0.085), V(hx, -0.17 * fl, 0.03 * L["ankle"] / 0.085)))
    return B


# --------------------------------------------------------------------------- geometry
def spow(x, e):
    return math.copysign(abs(x) ** e, x)


class Part:
    """Accumulates geometry for one material, with per-vertex bone weights."""

    def __init__(self, name, bone_index):
        self.name = name
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.bone_index = bone_index

    def _tag(self, verts, bone):
        """bone: a bone name (rigid) or a function(co) -> {bone: weight} for smooth skinning."""
        if callable(bone):
            for v in verts:
                for bn, w in bone(v.co).items():
                    if w > 1e-4:
                        v[self.dl][self.bone_index[bn]] = w
            return
        gi = self.bone_index[bone]
        for v in verts:
            v[self.dl][gi] = 1.0

    def lathe(self, p0, p1, profile, bone, nu=48, nv=40, cross=(1.0, 1.0), bend=(0, 0, 0), caps=(True, True)):
        """Seamless surface of revolution from p0 to p1. profile(t)->radius for t in 0..1 (0 at closed ends);
        rings are denser near the ends so the caps stay round. cross scales the section (x, y); bend bows the axis."""
        p0, p1 = Vector(p0), Vector(p1)
        axis = (p1 - p0)
        rot = Vector((0, 0, -1)).rotation_difference(axis.normalized()).to_matrix()
        bendv = Vector(bend)
        rows = []
        for i in range(nv + 1):
            t = (1 - math.cos(math.pi * i / nv)) / 2
            r = profile(t)
            c = p0 + axis * t + bendv * math.sin(math.pi * t)
            ring = []
            if r < 1e-5:
                ring = [self.bm.verts.new(c)]
            else:
                for j in range(nu):
                    u = 2 * math.pi * j / nu
                    ring.append(self.bm.verts.new(c + rot @ Vector((r * cross[0] * math.cos(u), r * cross[1] * math.sin(u), 0))))
            rows.append(ring)
        for i in range(nv):
            a, b = rows[i], rows[i + 1]
            for j in range(nu):
                k = (j + 1) % nu
                if len(a) == 1 and len(b) > 1:
                    self.bm.faces.new((a[0], b[j], b[k]))
                elif len(b) == 1 and len(a) > 1:
                    self.bm.faces.new((a[k], a[j], b[0]))
                elif len(a) > 1:
                    self.bm.faces.new((a[j], b[j], b[k], a[k]))
        self._tag([v for r_ in rows for v in r_], bone)

    def grid(self, rows, bone):
        """Quad sheet from a 2-D list of points (rows x cols)."""
        vs = [[self.bm.verts.new(Vector(p)) for p in row] for row in rows]
        for i in range(len(vs) - 1):
            for j in range(len(vs[0]) - 1):
                self.bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))
        self._tag([v for r_ in vs for v in r_], bone)

    def ellipsoid(self, center, radii, bone, e1=1.0, e2=1.0, axis=(0, 0, 1), nu=28, nv=16,
                  taper=(1.0, 1.0), roll=0.0):
        """Superellipsoid; local Z is the 'cap' axis (aligned to `axis`)."""
        rot = Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix()
        if roll:
            rot = rot @ Matrix.Rotation(roll, 3, "Z")
        a, b, c = radii
        verts_rows = []
        for i in range(1, nv):
            v = -math.pi / 2 + math.pi * i / nv
            cv, sv = math.cos(v), math.sin(v)
            tz = (sv * 0.5 + 0.5)
            f = taper[0] + (taper[1] - taper[0]) * tz
            ring = []
            for j in range(nu):
                u = 2 * math.pi * j / nu
                x = a * f * spow(cv, e1) * spow(math.cos(u), e2)
                y = b * f * spow(cv, e1) * spow(math.sin(u), e2)
                z = c * spow(sv, e1)
                p = rot @ Vector((x, y, z)) + Vector(center)
                ring.append(self.bm.verts.new(p))
            verts_rows.append(ring)
        bot = self.bm.verts.new(rot @ Vector((0, 0, -c)) + Vector(center))
        top = self.bm.verts.new(rot @ Vector((0, 0, c)) + Vector(center))
        allv = [bot, top] + [v for r in verts_rows for v in r]
        for j in range(nu):
            k = (j + 1) % nu
            self.bm.faces.new((bot, verts_rows[0][k], verts_rows[0][j]))
            self.bm.faces.new((top, verts_rows[-1][j], verts_rows[-1][k]))
        for i in range(len(verts_rows) - 1):
            for j in range(nu):
                k = (j + 1) % nu
                self.bm.faces.new((verts_rows[i][j], verts_rows[i][k], verts_rows[i + 1][k], verts_rows[i + 1][j]))
        self._tag(allv, bone)

    def patch(self, center, radii, bone, e1, e2, taper=(1.0, 1.0), u=(0, 1), v=(-1, 1), lift=1.012, nu=18, nv=14):
        """Open surface patch of a z-axis superellipsoid (angles u in radians, v in -pi/2..pi/2) lifted slightly outward:
        used for two-tone panels that sit on the shell like real armour plating."""
        a, b, c = radii
        rows = []
        for i in range(nv + 1):
            vv = v[0] + (v[1] - v[0]) * i / nv
            cv, sv = math.cos(vv), math.sin(vv)
            f = (taper[0] + (taper[1] - taper[0]) * (sv * 0.5 + 0.5)) * lift
            ring = []
            for j in range(nu + 1):
                uu = u[0] + (u[1] - u[0]) * j / nu
                p = Vector((a * f * spow(cv, e1) * spow(math.cos(uu), e2), b * f * spow(cv, e1) * spow(math.sin(uu), e2),
                            c * lift * spow(sv, e1))) + Vector(center)
                ring.append(self.bm.verts.new(p))
            rows.append(ring)
        allv = [v_ for r_ in rows for v_ in r_]
        for i in range(nv):
            for j in range(nu):
                self.bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))
        self._tag(allv, bone)

    def capsule(self, p0, p1, r0, r1, bone, e1=0.55, nu=16, nv=10):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        L = d.length
        self.ellipsoid((p0 + p1) / 2, (1.0, 1.0, L / 2 + max(r0, r1) * 0.35), bone, e1=e1, e2=1.0,
                       axis=d, nu=nu, nv=nv, taper=(r0, r1))

    def torus(self, center, R, r, bone, axis=(0, 0, 1), nu=32, nv=10):
        rot = Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix()
        rows = []
        for i in range(nv):
            v = 2 * math.pi * i / nv
            ring = []
            for j in range(nu):
                u = 2 * math.pi * j / nu
                x = (R + r * math.cos(v)) * math.cos(u)
                y = (R + r * math.cos(v)) * math.sin(u)
                z = r * math.sin(v)
                ring.append(self.bm.verts.new(rot @ Vector((x, y, z)) + Vector(center)))
            rows.append(ring)
        for i in range(nv):
            for j in range(nu):
                i2, j2 = (i + 1) % nv, (j + 1) % nu
                self.bm.faces.new((rows[i][j], rows[i2][j], rows[i2][j2], rows[i][j2]))
        self._tag([v for r_ in rows for v in r_], bone)

    def finish(self, armature_obj, bone_names):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for poly in me.polygons:
            poly.use_smooth = True
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        for bn in bone_names:
            obj.vertex_groups.new(name=bn)
        # weights were written by group index into the deform layer already
        obj.parent = armature_obj
        mod = obj.modifiers.new("Armature", "ARMATURE")
        mod.object = armature_obj
        return obj


# --------------------------------------------------------------------------- materials
def make_material(name, color, metal=0.0, rough=0.5, coat=0.0, emission=None, emission_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.05
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return m


# --------------------------------------------------------------------------- face shapes
def eye_shape(w, h, cy=0.0, top=1.0, bot=1.0, top_slope=0.0, bot_arc=0.0, crescent=0.0, inner=1.0, p=2.7,
              nu=EYE_NU, nv=EYE_NV, cx=0.0, cz=0.0):
    """Vertex positions (x, z) for an eye grid. `inner` = +1 if +x is toward the nose."""
    pts = []
    for j in range(nv):
        t = j / (nv - 1)
        for i in range(nu):
            s = -1 + 2 * i / (nu - 1)
            hh = max(0.0, 1 - abs(s) ** p) ** (1 / p)
            zt = cy + hh * h * top + top_slope * h * s * inner * 0.5
            if crescent > 0:
                zb = zt - crescent * h * (hh ** 0.6)
                zt = zt + 0.0
            else:
                zb = cy - hh * h * bot + bot_arc * h * (1 - s * s)
            if zt < zb + 0.012:
                m = (zt + zb) / 2
                zt, zb = m + 0.006, m - 0.006
            pts.append((cx + s * w, cz + zb + t * (zt - zb)))
    return pts


def mouth_shape(W, open_=0.0, curve=0.0, up=0.45, thick=0.0065, nu=MOUTH_NU, nv=MOUTH_NV, round_=0.0):
    """Vertex positions (x, z) for the mouth grid (centered at 0,0)."""
    pts = []
    for j in range(nv):
        t = j / (nv - 1)
        for i in range(nu):
            s = -1 + 2 * i / (nu - 1)
            exp = 2.2 + 1.6 * round_
            hm = max(0.0, 1 - abs(s) ** exp) ** (0.8 - 0.3 * round_)
            c = curve * W * 0.55 * (s * s)
            zt = c + thick + open_ * up * 0.055 * hm
            zb = c - thick - open_ * (1 - up) * 0.055 * hm
            pts.append((s * W, zb + t * (zt - zb)))
    return pts


def brow_shape(w, dz=0.0, inner_dz=0.0, outer_dz=0.0, th=0.0095, nu=7, nv=2, inner=1.0, tilt=0.0):
    pts = []
    for j in range(nv):
        t = j / (nv - 1)
        for i in range(nu):
            s = -1 + 2 * i / (nu - 1)
            k = (s * inner + 1) / 2  # 1 at inner end
            bend = 0.35 * (1 - s * s) * 0.012
            z = dz + inner_dz * k + outer_dz * (1 - k) + bend + (t - 0.5) * th
            pts.append((s * w, z))
    return pts


def make_face_mesh(name, obj_collection, armature_obj, bone, bone_index, bone_names, basis_pts, y, center, material,
                   shapes, nu, nv, project=None):
    """Planar grid on y = const, positions = center + (x, z). Shape keys from `shapes` {name: pts}."""
    me = bpy.data.meshes.new(name)
    Y = (lambda x_, z_: project(x_, z_)) if project else (lambda x_, z_: y)
    verts = [(center[0] + x, Y(center[0] + x, center[1] + z), center[1] + z) for (x, z) in basis_pts]
    faces = []
    for j in range(nv - 1):
        for i in range(nu - 1):
            a = j * nu + i
            faces.append((a, a + 1, a + nu + 1, a + nu))
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.shape_key_add(name="Basis")
    for kname, pts in shapes.items():
        sk = obj.shape_key_add(name=kname, from_mix=False)
        for idx, (x, z) in enumerate(pts):
            sk.data[idx].co = Vector((center[0] + x, Y(center[0] + x, center[1] + z), center[1] + z))
    for bn in bone_names:
        obj.vertex_groups.new(name=bn)
    vg = obj.vertex_groups[bone]
    vg.add(list(range(len(verts))), 1.0, "REPLACE")
    obj.parent = armature_obj
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = armature_obj
    obj.data.materials.append(material)
    return obj



# --------------------------------------------------------------------------- humanoid (concierge) parts
def spherical_front_y(zc, b, c, e1, taper, z):
    """y of the front surface (-Y side) of a superellipsoid centred at height zc at height z (for placing badges/tie)."""
    sv = (z - zc) / c
    sv = math.copysign(min(1.0, abs(sv)) ** (1 / e1), sv)
    cv = math.sqrt(max(0.0, 1 - sv * sv))
    f = taper[0] + (taper[1] - taper[0]) * (sv * 0.5 + 0.5)
    return -b * f * cv ** e1


def humanoid_parts(P, S, L, bones, bone_index):
    """Detailed receptionist robot. Returns the face-plane y. Every piece is weighted to ONE bone (rigid, no stretching)."""
    hr, sq = S["head_r"], S["head_sq"]
    hc = L["head_c"]
    hrx, hry, hrz = hr * sq[0], hr * sq[1], hr * sq[2]
    tx, ty, _ = S["torso"]
    sh, un, dk, gl, ac, vi = P["shell"], P["uniform"], P["dark"], P["glow"], P["accent"], P["visor"]
    s2 = P["shell2"]

    def ring(center, R, axis, bone, r=0.0045, disc=True):
        """glowing ring joint marker: glow torus + black recessed disc"""
        gl.torus(center, R, r, bone, axis=axis, nu=40, nv=8)
        if disc:
            dk.ellipsoid(center, (R * 0.92, R * 0.92, 0.004), bone, e1=0.5, axis=axis, nu=28, nv=6)

    def strip(center, half, bone, axis=(0, 0, 1)):
        gl.ellipsoid(center, (half[0] * 1.25, half[1] * 1.15, half[2]), bone, e1=0.5, e2=0.9, axis=axis, nu=14, nv=10)

    # ---- head: smooth helmet, large glossy faceplate, headphone-style ear caps with glowing rings
    sh.ellipsoid((0, 0, hc), (hrx, hry, hrz), "head", e1=S["e_head"], e2=S["e_head"], nu=56, nv=32)
    vis_c = (0, -hry * 0.72, hc + hrz * 0.01)
    vis_depth = hry * 0.34
    vi.ellipsoid(vis_c, (hrx * 0.9, hrz * 0.80, vis_depth), "head", e1=0.32, e2=0.62, axis=(0, -1, 0), nu=56, nv=26)
    face_y = vis_c[1] - vis_depth - 0.0035
    gl.ellipsoid((0, -hry * 0.30, hc + hrz * 0.985), (0.036, 0.012, 0.0035), "head", e1=0.6, nu=20, nv=8)  # top light slit
    for sx in (1, -1):
        ec = (sx * hrx * 0.985, 0.006, hc - 0.004)
        sh.ellipsoid(ec, (hrz * 0.44, hrz * 0.44, 0.024), "head", e1=0.45, axis=(sx, 0, 0), nu=36, nv=14)
        ring((sx * (hrx * 0.985 + 0.024), 0.006, hc - 0.004), hrz * 0.31, (sx, 0, 0), "head", r=0.0055)
        dk.ellipsoid((sx * (hrx * 0.985 + 0.02), 0.006, hc - 0.004), (hrz * 0.2, hrz * 0.2, 0.006), "head", e1=0.5, axis=(sx, 0, 0), nu=20, nv=6)
    # neck: black column with two ribs
    dk.ellipsoid((0, 0, L["neck"] + 0.03), (0.046, 0.046, 0.055), "neck", e1=0.55, nu=24, nv=10)
    for dz in (0.0, 0.035):
        s2.torus((0, 0, L["neck"] + dz), 0.044, 0.006, "neck", nu=28, nv=6)

    # ---- torso: V-shaped white shell, navy uniform panels, collar, tie, emblem, name tag
    ch_c = L["chest"] + S["chest_h"] * 0.5
    ch_c_r = S["chest_h"] * 0.62 + 0.03
    tp = (0.70, 1.0)
    sh.ellipsoid((0, 0, ch_c), (tx, ty, ch_c_r), "chest", e1=0.72, e2=0.82, taper=tp, nu=56, nv=30)
    # navy uniform = armour patches lifted 1.2 % off the same surface parametrisation (two-tone suit, like real panelling)
    PI = math.pi
    for sx in (1, -1):
        c0 = 0.0 if sx == 1 else PI
        # side flank panels: sector around the +/-X axis, lower 70 % of the chest
        un.patch((0, 0, ch_c), (tx, ty, ch_c_r), "chest", 0.72, 0.82, taper=tp, u=(c0 - 0.62, c0 + 0.62), v=(-0.95, 0.55), lift=1.014, nu=20, nv=16)
    # lower front band
    un.patch((0, 0, ch_c), (tx, ty, ch_c_r), "chest", 0.72, 0.82, taper=tp, u=(-PI / 2 - 0.62, -PI / 2 + 0.62), v=(-1.05, -0.62), lift=1.014, nu=24, nv=6)
    # tie: narrow centre strip from the collar to the belt line, plus knot
    un.patch((0, 0, ch_c), (tx, ty, ch_c_r), "chest", 0.72, 0.82, taper=tp, u=(-PI / 2 - 0.14, -PI / 2 + 0.14), v=(-0.62, 1.0), lift=1.02, nu=8, nv=18)
    zk = L["neck"] - 0.03
    un.ellipsoid((0, spherical_front_y(ch_c, ty, ch_c_r, 0.72, tp, zk) - 0.012, zk), (0.017, 0.014, 0.014), "chest", e1=0.6, axis=(0, -1, 0), nu=16, nv=10)  # knot
    # shoulder yoke so the shoulder line is continuous (no bare black bar)
    sh.ellipsoid((0, 0.005, L["neck"] - 0.052), (L["sh_x"] * 0.8, ty * 0.6, 0.042), "chest", e1=0.6, e2=0.8, nu=40, nv=14)
    for sx in (1, -1):  # collar wings
        sh.ellipsoid((sx * 0.034, -0.052, L["neck"] - 0.012), (0.034, 0.03, 0.01), "chest", e1=0.6, axis=(sx * 0.5, -0.5, 0.7), nu=16, nv=8)
    sh.torus((0, -0.004, L["neck"] + 0.004), 0.058, 0.012, "chest", nu=32, nv=8)                                   # collar band
    ze = ch_c + 0.075
    ye = spherical_front_y(ch_c, ty, ch_c_r, 0.72, tp, ze)
    ring((0.075, ye - 0.004, ze), 0.02, (0, -1, 0), "chest", r=0.0035)                                              # emblem (generic)
    ac.ellipsoid((-0.07, spherical_front_y(ch_c, ty, ch_c_r, 0.72, tp, ze) - 0.003, ze), (0.032, 0.011, 0.0035), "chest", e1=0.5,
                 axis=(0, -1, 0), nu=16, nv=8)                                                                      # name tag
    s2.ellipsoid((0, ty * 0.82, ch_c + 0.02), (tx * 0.6, ch_c_r * 0.62, 0.045), "chest", e1=0.6, e2=0.6, axis=(0, 1, 0), nu=28, nv=12)  # back plate
    # waist (black under-suit) and pelvis
    dk.ellipsoid((0, 0, L["spine"] + 0.035), (tx * 0.5, ty * 0.66, 0.08), "spine", e1=0.55, nu=28, nv=10)
    for dz in (0.0, 0.05):
        s2.torus((0, 0, L["spine"] + dz), tx * 0.46, 0.006, "spine", nu=32, nv=6)
    sh.ellipsoid((0, 0, L["pel"] + 0.005), (tx * 0.88, ty * 0.98, 0.10), "pelvis", e1=0.72, e2=0.8, nu=40, nv=18)
    un.torus((0, 0, L["pel"] + 0.075), tx * 0.74, 0.013, "pelvis", nu=40, nv=8)                                      # belt

    r = S["limb_r"]
    for side, sx in (("L", 1), ("R", -1)):
        shx, shz = L["sh_x"] * sx, L["sh_z"]
        elb, wr = L["elbow"], L["wrist"]
        # -- shoulder
        sh.capsule((sx * tx * 0.3, 0, shz - 0.01), (shx, 0, shz - 0.01), r * 0.95, r, f"clavicle_{side}")
        dk.ellipsoid((shx, 0, shz - 0.006), (0.043, 0.043, 0.043), f"upperarm_{side}", nu=24, nv=14)
        # An elongated, tilted shoulder shell follows the arm line and blends into the yoke,
        # avoiding the detached spherical-pauldron look while preserving the shoulder joint.
        sh.ellipsoid((shx + sx * 0.004, 0, shz + 0.006), (0.05, 0.05, 0.056), f"upperarm_{side}",
                     e1=0.76, e2=0.82, axis=(sx * 0.2, 0, 1), nu=40, nv=22)
        sh.capsule((sx * tx * 0.58, -0.012, shz + 0.035), (shx, -0.012, shz - 0.105),
                   0.047, 0.038, f"upperarm_{side}", e1=0.72, nu=32, nv=18)  # shoulder-to-arm armour sweep
        ring((shx + sx * 0.058, 0, shz + 0.004), 0.026, (sx, 0, 0), f"upperarm_{side}")
        # -- upper arm
        for zz in (shz - 0.10, elb + 0.07):
            dk.torus((shx, 0, zz), 0.0405, 0.0022, f"upperarm_{side}", nu=28, nv=5)
        sh.capsule((shx, 0, shz - 0.055), (shx, 0, elb + 0.03), 0.047, 0.037, f"upperarm_{side}", nu=24, nv=14)
        strip((shx + sx * 0.040, 0.004, (shz + elb) / 2 - 0.01), (0.0045, 0.011, 0.075), f"upperarm_{side}")
        # -- elbow
        dk.ellipsoid((shx, 0, elb), (0.034, 0.034, 0.034), f"forearm_{side}", nu=22, nv=12)
        ring((shx + sx * 0.032, 0, elb), 0.016, (sx, 0, 0), f"forearm_{side}", r=0.003)
        # -- forearm
        for zz in (elb - 0.09, wr + 0.11):
            dk.torus((shx, 0, zz), 0.0345, 0.002, f"forearm_{side}", nu=28, nv=5)
        sh.capsule((shx, 0, elb - 0.025), (shx, 0, wr + 0.035), 0.042, 0.031, f"forearm_{side}", nu=24, nv=14)
        strip((shx + sx * 0.034, 0.006, (elb + wr) / 2), (0.004, 0.01, 0.07), f"forearm_{side}")
        dk.torus((shx, 0, wr + 0.04), 0.033, 0.008, f"forearm_{side}", nu=28, nv=8)
        gl.torus((shx, 0, wr + 0.052), 0.0305, 0.002, f"forearm_{side}", nu=32, nv=6)
        # -- hand
        dk.ellipsoid((shx, 0, wr + 0.004), (0.03, 0.03, 0.022), f"hand_{side}", e1=0.6, nu=20, nv=10)
        sh.ellipsoid((shx, 0, wr - 0.052), (0.027, 0.047, 0.05), f"hand_{side}", e1=0.7, e2=0.8, nu=28, nv=14)
        dk.ellipsoid((shx - sx * 0.019, 0, wr - 0.048), (0.012, 0.036, 0.038), f"hand_{side}", e1=0.6, nu=18, nv=8)   # inner palm pad (black)
        for fname in FINGERS:
            for seg in (1, 2):
                b = bones[bone_index[f"finger_{fname}_{seg}_{side}"]]
                p0, p1 = b[2], b[3]
                rad = 0.0112 if seg == 1 else 0.0098
                if fname == "thumb":
                    rad *= 1.15
                d = p1 - p0
                sh.capsule(p0 + d * 0.06, p1 + d * (0.14 if seg == 2 else -0.04), rad, rad * (0.85 if seg == 2 else 1.0), b[0], nu=14, nv=8)
                if seg == 1:
                    dk.ellipsoid(p0, (rad * 1.05,) * 3, b[0], nu=10, nv=6)           # black knuckle
                else:
                    dk.ellipsoid(p0, (rad * 0.95,) * 3, b[0], nu=10, nv=6)           # black mid joint
        # -- leg
        hx = L["hip_x"] * sx
        hip, knee, ank = L["hip"], L["knee"], L["ankle"]
        dk.ellipsoid((hx, 0, hip), (0.056, 0.056, 0.056), f"thigh_{side}", nu=26, nv=14)
        ring((hx + sx * 0.052, 0, hip - 0.004), 0.024, (sx, 0, 0), f"thigh_{side}", r=0.004)
        for zz in (hip - 0.13, knee + 0.11):
            dk.torus((hx, 0, zz), 0.064, 0.0025, f"thigh_{side}", nu=32, nv=5)
        sh.capsule((hx, 0, hip - 0.04), (hx, 0, knee + 0.04), 0.076, 0.057, f"thigh_{side}", nu=32, nv=18)
        sh.ellipsoid((hx + sx * 0.012, 0, hip + 0.015), (0.073, 0.068, 0.066), f"thigh_{side}", e1=0.76, e2=0.82,
                     axis=(sx * 0.18, 0, 1), nu=32, nv=18)  # integrated hip guard
        strip((hx + sx * 0.067, 0.004, (hip + knee) / 2 + 0.02), (0.0045, 0.011, 0.11), f"thigh_{side}")
        dk.ellipsoid((hx, 0, knee), (0.046, 0.046, 0.046), f"shin_{side}", nu=24, nv=12)
        ring((hx + sx * 0.043, 0, knee), 0.021, (sx, 0, 0), f"shin_{side}", r=0.0035)
        sh.ellipsoid((hx, -0.044, knee + 0.012), (0.041, 0.03, 0.052), f"shin_{side}", e1=0.76, e2=0.82, nu=32, nv=18)  # kneecap
        for zz in (knee - 0.09, ank + 0.14):
            dk.torus((hx, 0, zz), 0.047, 0.0022, f"shin_{side}", nu=28, nv=5)
        sh.capsule((hx, 0, knee - 0.045), (hx, 0, ank + 0.055), 0.054, 0.039, f"shin_{side}", nu=24, nv=14)
        sh.ellipsoid((hx, 0.03, knee - 0.12), (0.046, 0.044, 0.11), f"shin_{side}", e1=0.8, e2=0.8, nu=24, nv=12)                # calf
        strip((hx + sx * 0.047, 0.003, (knee + ank) / 2 + 0.02), (0.0042, 0.01, 0.1), f"shin_{side}")
        dk.torus((hx, 0, ank + 0.075), 0.04, 0.008, f"shin_{side}", nu=28, nv=8)
        dk.ellipsoid((hx, 0, ank), (0.044, 0.044, 0.044), f"foot_{side}", nu=20, nv=10)
        ring((hx + sx * 0.04, 0, ank), 0.02, (sx, 0, 0), f"foot_{side}", r=0.0045)
        fl = S.get("foot", 1.0)
        sh.ellipsoid((hx, -0.05 * fl, 0.062), (0.057, 0.115 * fl, 0.05), f"foot_{side}", e1=0.7, e2=0.8, nu=32, nv=16)           # shoe upper
        sh.ellipsoid((hx, -0.165 * fl, 0.044), (0.052, 0.062 * fl, 0.036), f"toe_{side}", e1=0.7, e2=0.8, nu=24, nv=12)         # toe cap
        dk.ellipsoid((hx, -0.07 * fl, 0.02), (0.061, 0.145 * fl, 0.021), f"foot_{side}", e1=0.5, e2=0.8, nu=32, nv=10)           # sole
        for dx in (-0.058, 0.058):
            gl.ellipsoid((hx + dx, -0.07 * fl, 0.024), (0.0028, 0.115 * fl, 0.0042), f"foot_{side}", e1=0.5, nu=12, nv=8)       # sole glow
        gl.ellipsoid((hx, -0.205 * fl, 0.026), (0.048, 0.0028, 0.0042), f"toe_{side}", e1=0.5, nu=14, nv=8)
    return face_y


def mascot_parts(P, S, L, bones, bone_index):
    """Chibi mascot built for smooth, seamless curves:
    - body, arms (with mitten) and legs are single lathed surfaces with *smooth* skin weights (they bend, no ball joints)
    - the faceplate is projected onto the head ellipsoid (flush, not a goggle) and so are the eyes/mouth/brows.
    Returns (face_y, project_fn)."""
    hr, sq = S["head_r"], S["head_sq"]
    hc = L["head_c"]
    hrx, hry, hrz = hr * sq[0], hr * sq[1], hr * sq[2]
    sh, dk, gl, ac, vi = P["shell"], P["dark"], P["glow"], P["accent"], P["visor"]

    def sstep(a_, b_, x):
        k = min(1.0, max(0.0, (x - a_) / (b_ - a_)))
        return k * k * (3 - 2 * k)

    def blend(b_hi, b_lo, z_mid, half):
        """weight function: b_hi above z_mid+half, b_lo below z_mid-half, smooth in between"""
        def f(co):
            w = sstep(z_mid - half, z_mid + half, co.z)
            return {b_hi: w, b_lo: 1 - w}
        return f

    def profile(keys, cap0, cap1):
        """keys: [(t, r)] smooth (cosine) interpolation, with elliptical caps of length cap0/cap1 (in t units)"""
        def f(t):
            if t <= 0 or t >= 1:
                return 0.0
            i = 0
            while i < len(keys) - 2 and t > keys[i + 1][0]:
                i += 1
            (t0, r0), (t1, r1) = keys[i], keys[i + 1]
            u = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
            r = r0 + (r1 - r0) * (1 - math.cos(math.pi * u)) / 2
            if t < cap0:
                r *= math.sqrt(max(0.0, 1 - ((cap0 - t) / cap0) ** 2))
            if t > 1 - cap1:
                r *= math.sqrt(max(0.0, 1 - ((t - (1 - cap1)) / cap1) ** 2))
            return r
        return f

    def head_y(x, z, lift=0.0):
        """front (-Y) surface of the head ellipsoid at (x, z), pushed outward by `lift` meters"""
        q = 1 - (x / hrx) ** 2 - ((z - hc) / hrz) ** 2
        return -hry * math.sqrt(max(q, 0.0)) - lift

    # ---- head: true ellipsoid, very dense for clean highlights
    sh.ellipsoid((0, 0, hc), (hrx, hry, hrz), "head", nu=128, nv=84)
    # faceplate: rounded-square oval projected onto the head surface (flush, crisp edge)
    fa, fb, fz, fp = hrx * S.get("visor_w", 0.70), hrz * S.get("visor_h", 0.64), hc + hrz * S.get("visor_z", 0.12), 2.5
    rows = []
    NR, NT = 22, 120
    for i in range(NR + 1):
        rr = i / NR
        row = []
        for j in range(NT + 1):
            th = 2 * math.pi * j / NT
            cx, cz = math.cos(th), math.sin(th)
            k = (abs(cx) ** fp + abs(cz) ** fp) ** (-1 / fp)   # superellipse radius along this direction
            x, z = fa * rr * k * cx, fz + fb * rr * k * cz
            row.append((x, head_y(x, z, 0.0018), z))
        rows.append(row)
    vi.grid(rows, "head")
    project = lambda x, z: head_y(x, z, 0.0045)   # face LEDs float 4.5 mm above the faceplate
    face_y = head_y(0, hc, 0.0045)

    # ---- ear lenses: white rim, glowing ring, lavender lens; aligned to the side of the head
    for sx in (1, -1):
        x0, z0 = sx * hrx * 0.975, hc - hrz * 0.02
        ax = (sx, 0, 0)
        sh.torus((x0 + sx * 0.012, 0, z0), hrz * 0.27, 0.017, "head", axis=ax, nu=64, nv=14)
        gl.torus((x0 + sx * 0.022, 0, z0), hrz * 0.215, 0.0085, "head", axis=ax, nu=64, nv=10)
        ac.ellipsoid((x0 + sx * 0.012, 0, z0), (hrz * 0.2, hrz * 0.2, 0.016), "head", e1=0.75, axis=ax, nu=48, nv=12)

    # ---- neck: glowing ring the head floats on
    dk.ellipsoid((0, 0, L["neck"] + 0.012), (0.075, 0.07, 0.02), "neck", e1=0.6, nu=40, nv=8)
    gl.torus((0, 0, L["neck"] + 0.016), 0.088, 0.0115, "neck", nu=72, nv=10)

    # ---- body: one seamless rounded shape (soft shoulders, slight belly), smooth weights pelvis -> spine -> chest
    bt, bb = L["neck"] + 0.02, L["pel"] - 0.065
    body_w = lambda co: (lambda w1, w2: {"chest": w2, "spine": w1 - w2, "pelvis": 1 - w1})(
        sstep(L["pel"], L["spine"] + 0.02, co.z), sstep(L["spine"] + 0.02, L["chest"], co.z))
    tx = S["torso"][0]
    sh.lathe((0, 0, bt), (0, 0, bb), profile([(0, tx * 0.86), (0.25, tx * 0.97), (0.6, tx), (1, tx * 0.94)], 0.16, 0.22),
             body_w, nu=72, nv=48, cross=(1.0, 0.88))
    gl.ellipsoid((0, -S["torso"][0] * 0.88 * 0.985, bb + 0.06), (0.03, 0.0042, 0.0036), "pelvis", e1=0.5, axis=(0, -1, 0), nu=24, nv=8)

    # ---- arms: shoulder -> tapered arm -> rounded mitten as ONE lathe, smooth upperarm/forearm/hand weights
    for sx in (1, -1):
        side = "L" if sx == 1 else "R"
        shx, shz, elb, wr = L["sh_x"] * sx, L["sh_z"], L["elbow"], L["wrist"]
        top, bot = shz + 0.05, wr - 0.085
        ln = top - bot
        def arm_w(co, elb=elb, wr=wr, side=side):
            w_up = sstep(elb - 0.03, elb + 0.03, co.z)
            w_hand = 1 - sstep(wr - 0.02, wr + 0.02, co.z)
            return {f"upperarm_{side}": w_up * (1 - w_hand), f"forearm_{side}": (1 - w_up) * (1 - w_hand), f"hand_{side}": w_hand}
        r0 = S["limb_r"] * 1.25
        prof = profile([(0, r0), (0.35, r0 * 0.95), (0.62, r0 * 0.8), (0.8, r0 * 0.95), (1, r0 * 0.9)], r0 / ln * 0.9, r0 / ln * 1.1)
        sh.lathe((shx - sx * 0.01, 0, top), (shx + sx * 0.012, 0, bot), prof, arm_w, nu=48, nv=44, cross=(1.0, 0.94),
                 bend=(sx * 0.012, 0, 0))
        # glowing ring on the mitten tip (shows when waving)
        tipz = bot + 0.012
        gl.torus((shx + sx * 0.012, 0, tipz), 0.024, 0.0042, f"hand_{side}", axis=(0, 0, -1), nu=40, nv=8)
        ac.ellipsoid((shx + sx * 0.012, 0, tipz + 0.002), (0.022, 0.022, 0.004), f"hand_{side}", e1=0.6, axis=(0, 0, -1), nu=28, nv=6)

    # ---- legs: short seamless stubs (thigh/shin smooth weights) + rounded shoes with a glowing toe dash
    for sx in (1, -1):
        side = "L" if sx == 1 else "R"
        hx = L["hip_x"] * sx
        hip, knee, ank = L["hip"], L["knee"], L["ankle"]
        top, bot = L["pel"] - 0.01, ank - 0.01
        ln = top - bot
        r = S["limb_r"] * 1.12
        sh.lathe((hx, 0, top), (hx, 0, bot), profile([(0, r), (0.5, r * 0.96), (1, r * 0.98)], 0.3, r / ln * 0.6),
                 blend(f"thigh_{side}", f"shin_{side}", knee, 0.025), nu=44, nv=28)
        fl = S.get("foot", 1.0)
        sh.ellipsoid((hx, -0.018, 0.038), (r * 1.18, 0.082 * fl / 0.8, 0.04), f"foot_{side}", e1=0.72, e2=0.82, nu=56, nv=26)
        gl.ellipsoid((hx, -0.018 - 0.082 * fl / 0.8 * 0.985, 0.028), (0.03, 0.0042, 0.004), f"toe_{side}", e1=0.5, axis=(0, -1, 0), nu=24, nv=8)
    return face_y, project
# --------------------------------------------------------------------------- textures
import numpy as np  # noqa: E402 (venv guarantees numpy; atlas relies on it)


def _family_of(mat_name):
    """Mat_Shell -> shell; Mat_Uniform -> uniform."""
    base = mat_name[4:] if mat_name.startswith("Mat_") else mat_name
    return base.lower()


def _bake_target(mat, img):
    """Create/refresh an unlinked bake-target Image Texture node in a material."""
    node = mat.node_tree.nodes.get("bake_target")
    if node is None:
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.name = "bake_target"
    node.image = img
    for n in mat.node_tree.nodes.values():
        n.select = False
    mat.node_tree.nodes.active = node
    node.select = True
    return node


def _drop_bake_target(mat):
    node = mat.node_tree.nodes.get("bake_target") if mat.node_tree else None
    if node is not None:
        mat.node_tree.nodes.remove(node)


def _isolate_atlas_uv(me):
    """Leave exactly one uv layer ("atlas", active) -> stable TEXCOORD_0.

    Ops-built meshes often carry a stale "UVMap" layer with junk coords; the
    glTF exporter exports the first uv layer as TEXCOORD_0, so any survivor
    would sample the atlas' white void region.
    """
    for u in [u for u in (me.uv_layers or []) if u.name != "atlas"]:
        me.uv_layers.remove(u)
    if "atlas" not in me.uv_layers:
        me.uv_layers.new(name="atlas")
    me.uv_layers.active = me.uv_layers["atlas"]


def _uv_tile(obj, rect, pad=12):
    """Smart-UV one mesh, then normalize its uv bbox into one atlas tile rect.

    rect is the ABSOLUTE tile (x0, y0, w, h) in atlas pixels; uv coords become
    absolute too, so a full-atlas 2048 bake image lines up with the canvas.
    """
    me = obj.data
    if not me.polygons:
        return
    _isolate_atlas_uv(me)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        try:
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02,
                                     correct_aspect=True, scale_to_bounds=False)
        except Exception as e:
            print("WARN smart_project failed on", obj.name, e)
            bpy.ops.uv.cube_project(cube_size=1.5)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    # re-fetch mesh/layer AFTER the edit-mode round trip: the python uv-layer
    # reference can go stale across a bmesh rebuild (invalid layer.data).
    me = obj.data
    layer = me.uv_layers["atlas"]
    n = len(layer.data)
    uvs = np.empty(n * 2, dtype=np.float32)
    layer.data.foreach_get("uv", uvs)
    np_uvs = uvs.reshape(n, 2)
    umin = np_uvs.min(axis=0)
    span = np.clip(np_uvs.max(axis=0) - umin, 1e-6, None)
    p01 = (np_uvs - umin) / span
    x0, y0, w, h = rect
    px = x0 + pad + p01[:, 0] * (w - 2 * pad)
    py = y0 + pad + p01[:, 1] * (h - 2 * pad)
    # Author v = py/ATLAS (py = canvas row). glb v becomes 1 - v (exporter
    # flip); we therefore save every atlas mirrored top-down (_save_canvas)
    # so the sampler's row v*2048 == the canvas row exactly.
    uv = np.stack([px / atlas.ATLAS, py / atlas.ATLAS], axis=1)
    layer.data.foreach_set("uv", uv.reshape(-1).astype(np.float32))
    me.update()


def _face_uv(obj, sub):
    """Planar (x, z) UV into one face sub-rect; returns the layout entry."""
    me = obj.data
    _isolate_atlas_uv(me)
    lay = me.uv_layers["atlas"]
    n = len(me.vertices)
    coords = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", coords)
    co = coords.reshape(n, 3)
    minx, minz = co[:, 0].min(), co[:, 2].min()
    dx = max(co[:, 0].max() - minx, 1e-5)
    dz = max(co[:, 2].max() - minz, 1e-5)
    sx, sy, sw, sh = sub
    ux0, uy0, _, _ = atlas.SLOTS["face"]
    for poly in me.polygons:
        for li in poly.loop_indices:
            p = me.vertices[me.loops[li].vertex_index].co
            u = (p.x - minx) / dx
            v = (p.z - minz) / dz
            u = np.clip(u, 0.0, 1.0)
            v = np.clip(v, 0.0, 1.0)
            px, py = sx + 2 + u * (sw - 4), sy + 2 + (1.0 - v) * (sh - 4)
            lay.data[li].uv = ((ux0 + px) / atlas.ATLAS, (uy0 + py) / atlas.ATLAS)
    me.update()
    return {"rect": tuple(sub), "bbox": (float(minx), float(minz), float(dx), float(dz))}


def _cycle_bake(op_type, obj, samples, ao_distance=None, clear=True):
    """Cycles-bake the active object into its material's bake_target image."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        scene.cycles.device = "CPU"
    except Exception:
        pass
    scene.cycles.samples = max(2, int(samples))
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    if ao_distance is not None:
        try:
            scene.cycles.ao_distance = ao_distance
        except Exception:
            pass
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    args = dict(type=op_type, uv_layer="atlas", margin=8, margin_type="EXTEND",
                use_clear=clear, use_selected_to_active=False)
    if op_type == "NORMAL":
        args["normal_space"] = "TANGENT"
    result = bpy.ops.object.bake(**args)
    if "FINISHED" not in result:
        raise RuntimeError(f"{op_type} bake failed for {obj.name}: {result}")


def _bake_full(obj, op_type, samples, ao_distance=None):
    """Bake one object into a full-atlas image and read it back as numpy RGB."""
    mat = obj.data.materials[0]
    img = bpy.data.images.new("_bake_full", atlas.ATLAS, atlas.ATLAS)
    img.pixels.foreach_set(np.ones(atlas.ATLAS * atlas.ATLAS * 4, dtype=np.float32))
    _bake_target(mat, img)
    try:
        _cycle_bake(op_type, obj, samples, ao_distance=ao_distance, clear=False)
        return atlas.image_to_rgba(img)[::-1]
    finally:
        _drop_bake_target(mat)
        bpy.data.images.remove(img)


def _bake_full_bumped(obj, samples, dist, scale):
    """Full-atlas TANGENT-space NORMAL bake through a temporary noise->bump swap.

    Saves the material's Normal links, wires a Noise Texture -> Bump chain with
    per-family (dist, scale) into the Principled BSDF for one bake, then
    restores the original wiring. Returns RGB (top-down) like _bake_full."""
    mat = obj.data.materials[0]
    img = bpy.data.images.new("_bake_bump", atlas.ATLAS, atlas.ATLAS)
    img.pixels.foreach_set(np.zeros(atlas.ATLAS * atlas.ATLAS * 4, dtype=np.float32))
    _bake_target(mat, img)
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    saved = [l.from_socket for l in nt.links
             if l.to_node is bsdf and l.to_socket.name == "Normal"]
    for l in [l for l in nt.links if l.to_node is bsdf and l.to_socket.name == "Normal"]:
        nt.links.remove(l)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 8.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 1.0
    bump.inputs["Distance"].default_value = dist
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    try:
        _cycle_bake("NORMAL", obj, samples, ao_distance=None, clear=False)
        return atlas.image_to_rgba(img)[::-1]
    finally:
        for l in [l for l in nt.links if l.to_node is bsdf and l.to_socket.name == "Normal"]:
            nt.links.remove(l)
        for sock in saved:
            nt.links.new(sock, bsdf.inputs["Normal"])
        nt.nodes.remove(noise)
        nt.nodes.remove(bump)
        _drop_bake_target(mat)
        bpy.data.images.remove(img)


# per-family bump for the NORMAL bakes: (distance [m], noise scale)
# Broad, gentle undulations only: high-frequency grain read as chrome sparkle
# and exploded the normal-map bitrate; keep features >= ~4 mm.
PUMP = {
    "shell": (0.0016, 160.0), "shell2": (0.0020, 180.0), "dark": (0.0014, 180.0),
    "uniform": (0.0040, 200.0), "visor": (0.0006, 260.0), "accent": (0.0016, 170.0),
    "glow": (0.0012, 220.0), "face": (0.0008, 260.0),
}


def _style_knobs(style_name, S, human, masc):
    """Per-family (rough, metal) mirroring the make_material() values exactly."""
    return {
        "shell": (S["rough"], S["metal"] * 0.4),
        "shell2": (S["rough"] + 0.08, S["metal"]),
        "dark": (0.28 if human else 0.55, 0.2 if human else 0.3),
        "accent": (0.25 if human else 0.28, 0.9 if human else (0.1 if style_name == "friendly" else 0.7)),
        "visor": (0.16 if masc else 0.09, 0.0),
        "glow": (0.4, 0.0),
        "face": (0.5, 0.0),
        "uniform": (0.34, 0.1),
    }


def _base_colors(S, human, masc):
    visor = (0.0, 0.0, 0.004) if masc else (0.01, 0.012, 0.018)
    darkish = (0.02, 0.02, 0.025)
    out = {"shell": S["shell"], "shell2": S["shell2"], "dark": S["dark"], "accent": S["accent"],
           "visor": visor, "glow": darkish, "face": darkish}
    if human and "uniform" in S:
        out["uniform"] = S["uniform"]
    return out


def _srgb_encode(a):
    return np.clip(np.power(np.clip(a, 0.0, 1.0), 1.0 / 2.2), 0.0, 1.0)


def _save_canvas(canvas, path, srgb=False, quality=90, subsampling=None, down=1):
    pil = atlas.to_pil(_srgb_encode(canvas) if srgb else np.clip(canvas, 0.0, 1.0))
    # The exporter stores v = 1 - authored v; mirror the bitmap top-down so
    # the sampler's v (flipY=false) walks rows exactly like the canvas did.
    pil = pil.transpose(atlas.Image.FLIP_TOP_BOTTOM)
    if down > 1:
        pil = pil.resize((pil.width // down, pil.height // down), atlas.Image.LANCZOS)
    if path.lower().endswith((".jpg", ".jpeg")):
        options = {"quality": quality}
        if subsampling is not None:
            options["subsampling"] = subsampling
        pil.save(path, **options)
    else:
        pil.save(path)


def _load_tex(path, non_color=False):
    img = bpy.data.images.load(os.path.abspath(path), check_existing=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    return img


def _wire_material(mat, files, kind):
    """Add texture nodes: Base Color, Normal, Metallic/Roughness, Emission."""
    nt = mat.node_tree
    _drop_bake_target(mat)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    col = nt.nodes.new("ShaderNodeTexImage")
    col.image = _load_tex(files["color"])
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    nrm = nt.nodes.new("ShaderNodeTexImage")
    nrm.image = _load_tex(files["normal"], non_color=True)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 1.0
    nt.links.new(nrm.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    mrt = nt.nodes.new("ShaderNodeTexImage")
    mrt.image = _load_tex(files["metal_rough"], non_color=True)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(mrt.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if kind in ("glow", "face"):
        em = nt.nodes.new("ShaderNodeTexImage")
        em.image = _load_tex(files["emissive"])
        nt.links.new(em.outputs["Color"], bsdf.inputs["Emission Color"])


def _tile_grid(slot, count, pad=12):
    """Split one slot into a cols x rows grid of tiles for count objects."""
    cols = max(1, int(math.ceil(math.sqrt(max(1, count)))))
    rows = max(1, int(math.ceil(count / cols)))
    x0, y0, w, h = slot
    tw, th = w // cols, h // rows
    tiles = [(x0 + c * tw, y0 + r * th, tw, th) for r in range(rows) for c in range(cols)]
    return tiles, pad


def _shift_uv(obj, offset):
    """Add `offset` to every uv of `obj` (re-fetches the layer freshly).

    All our textures tile with REPEAT wrapping, so a +1.0 shift renders
    identically, but keeps every TEXCOORD out of [0,1]; glTF-transform's
    meshopt step then skips quantizing uv (its quantized texcoords decode
    unnormalized -> uv * 65536 in three.js) and we keep exact float32 uv.
    """
    me = obj.data
    layer = me.uv_layers.get("atlas")
    if layer is None or not len(layer.data):
        return
    n = len(layer.data)
    uvs = np.empty(n * 2, dtype=np.float32)
    layer.data.foreach_get("uv", uvs)
    uvs[0::2] += offset
    uvs[1::2] += offset
    layer.data.foreach_set("uv", uvs)
    me.update()


def texturize(style_name, S, L, objs, face_objs, mats, tex_dir, samples=16):
    """Bake AO + normal, compose metallicRoughness + emissive, save 4 textures and
    wire them into the materials. Raises on failure; callers must catch."""
    human = S.get("kind") == "humanoid"
    masc = S.get("kind") == "mascot"
    os.makedirs(tex_dir, exist_ok=True)
    knob = _style_knobs(style_name, S, human, masc)
    base = _base_colors(S, human, masc)

    fam_objs = {}
    for o in objs:
        if len(o.data.polygons):
            fam = _family_of(o.data.materials[0].name)
            fam_objs.setdefault(fam, []).append(o)
    face_objs = [o for o in face_objs if len(o.data.polygons)]

    looks = {fam: atlas.Look(kind=fam, rough=knob[fam][0], metal=knob[fam][1],
                             rough_var=0.18 if fam in ("shell", "shell2") else 0.22,
                             deposit=0.6 if style_name == "concierge" else 0.35,
                             seed=int(math.fmod(abs(hash(fam)), 900)) + 3) for fam in knob}
    mr = atlas.build_metal_rough(looks)

    color = atlas.empty_canvas(3, 1.0)
    normal = atlas.build_normal(looks)
    emissive = atlas.empty_canvas(3, 0.0)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"

    # ---- body families: per-object tiles -----------------------------------
    def area(o):
        bb = o.bound_box
        dx = bb[6][0] - bb[0][0]
        dy = bb[6][1] - bb[0][1]
        dz = bb[6][2] - bb[0][2]
        return dx * dy * dz

    for fam, group in fam_objs.items():
        group = sorted(group, key=area, reverse=True)
        tiles, pad = _tile_grid(atlas.SLOTS[fam], len(group))
        smp = max(4, samples // 2)
        for rect, o in zip(tiles, group):
            print("[tex] uv", o.name, fam, rect)
            _uv_tile(o, rect, pad=pad)
            rx, ry, rw, rh = rect
            ao_full = _bake_full(o, "AO", smp, ao_distance=0.55)
            ao_tile = ao_full[ry:ry + rh, rx:rx + rw].mean(axis=2)[:, :, np.newaxis]
            ao_full = None
            shade = (1.0 - 0.8) + 0.8 * np.clip(ao_tile, 0.0, 1.0)
            color[ry:ry + rh, rx:rx + rw] = np.clip(
                np.asarray(base[fam], dtype=np.float32)[None, None, :] * shade, 0.0, 1.0)
            dist, nsc = PUMP[fam]
            bump_full = _bake_full_bumped(o, smp, dist, nsc)
            normal[ry:ry + rh, rx:rx + rw] = bump_full[ry:ry + rh, rx:rx + rw]
            bump_full = None

    # ---- face family: per-object bakes inside the face slot -----------------
    face_layout = {}
    if face_objs:
        for o in face_objs:
            print("[tex] face uv", o.name)
            face_layout[o.name] = _face_uv(o, atlas.FACE_SUB[o.name])
        FX, FY, FW, FH = atlas.SLOTS["face"]
        cview = color[FY:FY + FH, FX:FX + FW]
        nview = normal[FY:FY + FH, FX:FX + FW]
        base_f = np.asarray(base["face"], dtype=np.float32)
        fdist, fnsc = PUMP["face"]
        for o in face_objs:
            sx, sy, sw, sh = atlas.FACE_SUB[o.name]
            smp = max(4, samples // 2)
            ao_full = _bake_full(o, "AO", smp, ao_distance=0.3)
            a = ao_full[FY + sy:FY + sy + sh, FX + sx:FX + sx + sw].mean(axis=2)
            ao_full = None
            shade = 0.55 + 0.45 * np.clip(a, 0.0, 1.0)
            cview[sy:sy + sh, sx:sx + sw] = np.clip(base_f[None, None, :] * shade[:, :, np.newaxis], 0.0, 1.0)
            bump_full = _bake_full_bumped(o, smp, fdist, fnsc)
            nview[sy:sy + sh, sx:sx + sw] = bump_full[FY + sy:FY + sy + sh, FX + sx:FX + sx + sw]
            bump_full = None
    else:
        face_layout = {name: {"rect": sub, "bbox": (0.0, 0.0, 1e-4, 1e-4)}
                       for name, sub in atlas.FACE_SUB.items()}

    # ---- emissive -----------------------------------------------------------
    hr, hc = S["head_r"], L["head_c"]
    hrz = S["head_r"] * S["head_sq"][2]
    ew, eh_ = S["eye"][0] * 0.5, S["eye"][1] * 0.5
    ex = hr * S.get("eye_x_k", 0.36)
    ez = hc + hr * S.get("eye_z_k", 0.04)
    info = {
        "glow": S["glow"], "eye_p": S.get("eye_p", 2.7),
        "hide_idle": bool(S.get("hide_idle_face")),
        "eye": {"half_w": ew, "half_h": eh_},
        "brow": {"half_w": ew * 0.95, "th": 0.0095},
        "mouth": {"half_w": S["mouth_w"], "th": 0.0065},
        "centers": {"Eye_L": (ex, ez), "Eye_R": (-ex, ez),
                    "Brow_L": (ex, ez + eh_ * 1.45), "Brow_R": (-ex, ez + eh_ * 1.45),
                    "Mouth": (0.0, hc - hrz * S.get("mouth_z_k", 0.45))},
    }
    atlas.draw_face_emissive(emissive, info, face_layout)
    atlas.draw_face_color(color, info, face_layout)

    # ---- save + wire ----------------------------------------------------------
    files = {
        "color": os.path.join(tex_dir, f"{style_name}_color.jpg"),
        "metal_rough": os.path.join(tex_dir, f"{style_name}_metal_rough.jpg"),
        "normal": os.path.join(tex_dir, f"{style_name}_normal.jpg"),
        "emissive": os.path.join(tex_dir, f"{style_name}_emissive.png"),
    }
    _save_canvas(color, files["color"], srgb=True, quality=92)
    _save_canvas(mr, files["metal_rough"], quality=88)
    _save_canvas(normal, files["normal"], quality=92, subsampling=0, down=2)
    _save_canvas(emissive, files["emissive"], srgb=True)
    for fam in fam_objs:
        _wire_material(mats[fam], files, fam)
    _wire_material(mats["face"], files, "face")

    # final export-only uv wrap shift (before this, bakes authored pixels/ATLAS)
    for o in [o for fam_group in fam_objs.values() for o in fam_group] + list(face_objs):
        _shift_uv(o, 1.0)

    return {"design_version": atlas.DESIGN_VERSION,
            "textures": {k: os.path.basename(v) for k, v in files.items()}}



# --------------------------------------------------------------------------- main build
def build(style_name, out_glb, out_blend=None, out_json=None, tex_dir=None, samples=16):
    S = STYLES[style_name]
    L = layout(S)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # ---- armature
    arm_data = bpy.data.armatures.new("RobotArmature")
    arm_obj = bpy.data.objects.new("RobotArmature", arm_data)
    scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    arm_obj.select_set(True)
    bones = build_bones(S, L)
    if S.get("default_emotion"):
        arm_obj["default_emotion"] = S["default_emotion"]
    bpy.ops.object.mode_set(mode="EDIT")
    ebs = {}
    for name, parent, head, tail in bones:
        eb = arm_data.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        if (tail - head).length < 0.01:
            eb.tail = head + Vector((0, 0, 0.02))
        ebs[name] = eb
    for name, parent, _, _ in bones:
        if parent:
            ebs[name].parent = ebs[parent]
            ebs[name].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    bone_names = [b[0] for b in bones]
    bone_index = {n: i for i, n in enumerate(bone_names)}

    # ---- materials
    mats = {
        "shell": make_material("Mat_Shell", S["shell"], S["metal"] * 0.4, S["rough"], S["coat"]),
        "shell2": make_material("Mat_Shell2", S["shell2"], S["metal"], S["rough"] + 0.08, S["coat"] * 0.5),
        "dark": make_material("Mat_Dark", S["dark"], 0.3, 0.55),
        "accent": make_material("Mat_Accent", S["accent"], 0.7 if style_name != "friendly" else 0.1, 0.28, 0.5),
        "visor": make_material("Mat_Visor", (0.01, 0.012, 0.018), 0.0, 0.06, 1.0),
        "glow": make_material("Mat_Glow", (0.02, 0.02, 0.025), 0.0, 0.4, 0.0, S["glow"], 1.6),
        "face": make_material("Mat_Face", (0.02, 0.02, 0.025), 0.0, 0.5, 0.0, S["glow"], 1.25),
    }
    for k in ("face",):
        mats[k].use_backface_culling = False
    humanoid = S.get("kind") == "humanoid"
    mascot = S.get("kind") == "mascot"
    if humanoid or mascot:
        for k in ("dark", "accent", "glow", "face"):  # replace the generic ones (avoid ".001" duplicate names the engine looks up)
            bpy.data.materials.remove(mats[k])
        if humanoid:
            mats["uniform"] = make_material("Mat_Uniform", S["uniform"], 0.1, 0.34, 0.9)
        mats["dark"] = make_material("Mat_Dark", S["dark"], 0.2, 0.28, 0.8)
        mats["accent"] = make_material("Mat_Accent", S["accent"], 0.9, 0.25, 0.4)
        mats["glow"] = make_material("Mat_Glow", (0.02, 0.02, 0.025), 0.0, 0.4, 0.0, S["glow"], S.get("glow_strength", 1.7))
        mats["face"] = make_material("Mat_Face", (0.02, 0.02, 0.025), 0.0, 0.5, 0.0, S["glow"], S.get("face_strength", 1.5))
        mats["face"].use_backface_culling = False
        if mascot:  # deep glossy black faceplate (less env reflection than the generic visor)
            bpy.data.materials.remove(mats["visor"])
            mats["visor"] = make_material("Mat_Visor", (0.0, 0.0, 0.004), 0.0, 0.16, 0.0)
    keys = ("shell", "shell2", "dark", "accent", "visor", "glow") + (("uniform",) if humanoid else ())
    parts = {k: Part("Body_" + k.capitalize() if k not in ("visor", "glow") else k.capitalize(), bone_index) for k in keys}
    P = parts

    hr, sq, eh = S["head_r"], S["head_sq"], S["e_head"]
    hc = L["head_c"]
    hrx, hry, hrz = hr * sq[0], hr * sq[1], hr * sq[2]
    tx, ty, tz = S["torso"]
    eb_ = S["e_box"]
    r = S["limb_r"]

    project = None
    if mascot:
        face_y, project = mascot_parts(P, S, L, bones, bone_index)
    elif humanoid:
        face_y = humanoid_parts(P, S, L, bones, bone_index)
    else:
        # ---- head
        P["shell"].ellipsoid((0, 0, hc), (hrx, hry, hrz), "head", e1=eh, e2=eh, axis=(0, 0, 1), nu=40, nv=24)
        # faceplate (dark glass): front -Y; local Z of the ellipsoid -> world -Y
        vis_c = (0, -hry * 0.78, hc + hrz * 0.02)
        vis_depth = hry * 0.3
        P["visor"].ellipsoid(vis_c, (hrx * 0.82, hrz * 0.64, vis_depth), "head", e1=0.3, e2=0.55,
                             axis=(0, -1, 0), nu=40, nv=18)
        face_y = vis_c[1] - vis_depth - 0.0035
        # side ears
        for sx in (1, -1):
            P["shell2"].ellipsoid((sx * (hrx * 0.97), 0.0, hc), (hrz * 0.3, hrz * 0.3, hrx * 0.1), "head", e1=0.5,
                                  axis=(sx, 0, 0), nu=24, nv=10)
            P["accent"].torus((sx * (hrx * 1.04), 0.0, hc), hrz * 0.27, 0.011, "head", axis=(sx, 0, 0))
            P["glow"].ellipsoid((sx * (hrx * 1.07), 0.0, hc), (hrz * 0.13, hrz * 0.13, 0.008), "head", axis=(sx, 0, 0),
                                nu=16, nv=6)
        # antenna
        P["dark"].capsule((0, 0.01, hc + hrz * 0.93), (0, 0.01, hc + hrz * 1.28), 0.012, 0.010, "head")
        P["glow"].ellipsoid((0, 0.01, hc + hrz * 1.33), (0.022, 0.022, 0.022), "head", nu=16, nv=10)
        # neck
        P["dark"].ellipsoid((0, 0, L["neck"] + 0.02), (0.052, 0.052, 0.045), "neck", e1=0.5, nu=20, nv=8)

        # ---- torso
        P["shell"].ellipsoid((0, 0, L["chest"] + S["chest_h"] * 0.5), (tx, ty, S["chest_h"] * 0.62 + 0.03), "chest",
                             e1=eb_, e2=eb_ + 0.1, nu=40, nv=22)
        # chest plate (accent) + glowing core
        P["accent"].ellipsoid((0, -ty * 0.86, L["chest"] + S["chest_h"] * 0.52),
                              (tx * 0.52, tx * 0.52, 0.03), "chest", e1=0.5, axis=(0, -1, 0), nu=32, nv=8)
        P["glow"].ellipsoid((0, -ty * 0.86 - 0.027, L["chest"] + S["chest_h"] * 0.52),
                            (tx * 0.26, tx * 0.26, 0.014), "chest", e1=0.6, axis=(0, -1, 0), nu=28, nv=8)
        # back unit
        P["shell2"].ellipsoid((0, ty * 0.85, L["chest"] + S["chest_h"] * 0.55), (tx * 0.62, S["chest_h"] * 0.42, 0.05),
                              "chest", e1=0.6, e2=0.6, axis=(0, 1, 0), nu=28, nv=10)
        # waist
        P["dark"].ellipsoid((0, 0, L["spine"] + 0.03), (tx * 0.6, ty * 0.78, 0.07), "spine", e1=0.55, nu=28, nv=10)
        # pelvis
        P["shell2"].ellipsoid((0, 0, L["pel"] - 0.005), (tx * 0.93, ty * 0.95, 0.085), "pelvis", e1=eb_, e2=eb_ + 0.1,
                              nu=32, nv=14)
        P["accent"].torus((0, 0, L["pel"] + 0.045), tx * 0.8, 0.008, "pelvis")

        # ---- arms / legs / hands
        for side, sx in (("L", 1), ("R", -1)):
            shx, shz = L["sh_x"] * sx, L["sh_z"]
            # clavicle + shoulder joint
            P["shell2"].capsule((sx * tx * 0.45, 0, shz), (shx, 0, shz), r * 0.95, r * 1.05, f"clavicle_{side}")
            P["dark"].ellipsoid((shx, 0, shz), (r * 1.4, r * 1.4, r * 1.4), f"upperarm_{side}", nu=22, nv=12)
            P["shell"].capsule((shx, 0, shz - 0.02), (shx, 0, L["elbow"] + 0.02), r * 1.05, r * 0.92, f"upperarm_{side}")
            P["dark"].ellipsoid((shx, 0, L["elbow"]), (r * 1.1, r * 1.1, r * 1.1), f"forearm_{side}", nu=20, nv=10)
            P["shell"].capsule((shx, 0, L["elbow"] - 0.02), (shx, 0, L["wrist"] + 0.025), r * 0.95, r * 0.8,
                               f"forearm_{side}")
            P["accent"].torus((shx, 0, L["wrist"] + 0.045), r * 0.86, 0.007, f"forearm_{side}")
            P["dark"].ellipsoid((shx, 0, L["wrist"]), (r * 0.82, r * 0.82, r * 0.5), f"hand_{side}", e1=0.6, nu=18, nv=8)
            # palm
            P["shell2"].ellipsoid((shx, 0, L["wrist"] - 0.05), (0.034, 0.05, 0.045), f"hand_{side}", e1=0.65, e2=0.7,
                                  nu=20, nv=10)
            for fname in FINGERS:
                for seg in (1, 2):
                    b = bones[bone_index[f"finger_{fname}_{seg}_{side}"]]
                    p0, p1 = b[2], b[3]
                    rad = 0.0135 if seg == 1 else 0.0122
                    if fname == "thumb":
                        rad *= 1.12
                    P["dark"].capsule(p0 - (p1 - p0) * 0.12, p1 + (p1 - p0) * (0.1 if seg == 2 else 0.05), rad,
                                      rad * (0.92 if seg == 2 else 1.0), b[0], nu=12, nv=8)
            # leg
            hx = L["hip_x"] * sx
            P["dark"].ellipsoid((hx, 0, L["hip"]), (r * 1.45, r * 1.45, r * 1.45), f"thigh_{side}", nu=22, nv=12)
            P["shell"].capsule((hx, 0, L["hip"] - 0.03), (hx, 0, L["knee"] + 0.03), r * 1.2, r * 1.0, f"thigh_{side}")
            P["dark"].ellipsoid((hx, 0, L["knee"]), (r * 1.15, r * 1.25, r * 1.15), f"shin_{side}", nu=20, nv=10)
            P["shell"].capsule((hx, 0, L["knee"] - 0.03), (hx, 0, L["ankle"] + 0.035), r * 1.05, r * 0.85, f"shin_{side}")
            P["accent"].torus((hx, 0, L["ankle"] + 0.07), r * 0.86, 0.007, f"shin_{side}")
            P["dark"].ellipsoid((hx, 0, L["ankle"]), (r * 0.92, r * 0.92, r * 0.92), f"foot_{side}", nu=18, nv=10)
            P["shell2"].ellipsoid((hx, -0.032, 0.046), (0.062, 0.115, 0.046), f"foot_{side}", e1=0.7, e2=0.75,
                                  axis=(0, 0, 1), nu=28, nv=14)
            P["accent"].ellipsoid((hx, -0.1, 0.03), (0.05, 0.05, 0.026), f"toe_{side}", e1=0.65, e2=0.8,
                                  axis=(0, 0, 1), nu=20, nv=10)
            P["dark"].ellipsoid((hx, -0.032, 0.012), (0.058, 0.108, 0.014), f"foot_{side}", e1=0.5, e2=0.75, nu=24, nv=8)

    objs = []
    for key, part in parts.items():
        o = part.finish(arm_obj, bone_names)
        o.data.materials.append(mats[key if key != "dark" else "dark"])
        objs.append(o)

    # ---- face
    W = S["mouth_w"]
    ew, eh_ = S["eye"][0] * 0.5, S["eye"][1] * 0.5
    ex = hr * S.get("eye_x_k", 0.36)
    ez = hc + hr * S.get("eye_z_k", 0.04)
    face_objs = []
    for side, sx in (("L", 1), ("R", -1)):
        inner = -sx  # local +x toward nose?  (eye at +x: nose is toward -x => inner = -1 for L)
        ec = (sx * ex, ez)
        mk = lambda **k: eye_shape(ew, eh_, inner=inner, **{"p": S.get("eye_p", 2.7), **k})
        base = mk()
        shapes = {
            "eyeBlink": mk(top=0.04, bot=0.04),
            "eyeSquint": mk(top=0.62, bot=0.2, cy=-0.1 * eh_),
            "eyeWide": eye_shape(ew * 1.12, eh_ * 1.3, inner=inner),
            "eyeHappy": mk(crescent=0.3 if S.get("hide_idle_face") else 0.42, cy=-0.1 * eh_, top=0.62),
            "eyeSad": mk(top_slope=1.0, top=0.82, bot=0.9),
            "eyeAngry": mk(top_slope=-1.15, top=0.8, bot=0.85, cy=-0.05 * eh_),
            "eyeSurprised": eye_shape(ew * 0.9, eh_ * 1.45, inner=inner, p=2.2),
            "eyeCurious": mk(top=1.12, bot=0.9, top_slope=0.25),
        }
        shapes_abs = {k: v for k, v in shapes.items()}
        o = make_face_mesh(f"Eye_{side}", None, arm_obj, f"eye_{side}", bone_index, bone_names, base, face_y, ec,
                           mats["face"], shapes_abs, EYE_NU, EYE_NV, project=project)
        face_objs.append(o)

    mw = W
    mouth_base = mouth_shape(0.0001, thick=0.0001) if S.get("hide_idle_face") else mouth_shape(mw)
    shapes = {
        "mouthOpen": mouth_shape(mw * 0.9, 0.85),
        "viseme_sil": mouth_shape(0.0001, thick=0.0001) if S.get("hide_idle_face") else mouth_shape(mw),
        "viseme_PP": mouth_shape(mw * 0.62, 0.0, thick=0.011),
        "viseme_FF": mouth_shape(mw * 0.82, 0.22, curve=-0.1, up=0.3),
        "viseme_TH": mouth_shape(mw * 0.8, 0.38, up=0.35),
        "viseme_DD": mouth_shape(mw * 0.85, 0.34),
        "viseme_kk": mouth_shape(mw * 0.8, 0.42),
        "viseme_CH": mouth_shape(mw * 0.52, 0.42, round_=0.6),
        "viseme_SS": mouth_shape(mw * 1.0, 0.14, thick=0.008),
        "viseme_nn": mouth_shape(mw * 0.85, 0.26),
        "viseme_RR": mouth_shape(mw * 0.62, 0.38, round_=0.5),
        "viseme_aa": mouth_shape(mw * 0.92, 1.0),
        "viseme_E": mouth_shape(mw * 1.0, 0.58),
        "viseme_I": mouth_shape(mw * 1.08, 0.3, curve=0.18),
        "viseme_O": mouth_shape(mw * 0.55, 0.9, round_=1.0, up=0.5),
        "viseme_U": mouth_shape(mw * 0.4, 0.58, round_=1.0, up=0.5),
        "mouthSmile": mouth_shape(mw * 1.08, 0.1, curve=1.0, thick=0.0075),
        "mouthFrown": mouth_shape(mw * 0.85, 0.0, curve=-1.0, thick=0.0075),
        "mouthSurprise": mouth_shape(mw * 0.42, 1.0, round_=1.0, up=0.5),
    }
    mouth_c = (0, hc - hrz * S.get("mouth_z_k", 0.45))
    face_objs.append(make_face_mesh("Mouth", None, arm_obj, "head", bone_index, bone_names, mouth_base, face_y,
                                    mouth_c, mats["face"], shapes, MOUTH_NU, MOUTH_NV, project=project))

    bw = ew * 0.95
    for side, sx in (("L", 1), ("R", -1)):
        inner = -sx
        bc = (sx * ex, ez + eh_ * 1.45)
        mk = lambda **k: brow_shape(bw, inner=inner, **k)
        shapes = {
            "browUp": mk(dz=0.017),
            "browDown": mk(dz=-0.012),
            "browInnerUp": mk(inner_dz=0.022, outer_dz=-0.004),
            "browInnerDown": mk(inner_dz=-0.02, outer_dz=0.006),
        }
        face_objs.append(make_face_mesh(f"Brow_{side}", None, arm_obj, "head", bone_index, bone_names, brow_shape(0.0002, th=0.0001, inner=inner) if S.get("hide_idle_face") else mk(), face_y,
                                        bc, mats["face"], shapes, 7, 2, project=project))

    # ---- textures (phase 1): bake + save + wire; falls back to untextured ----
    applied_tex = None
    if tex_dir:
        try:
            applied_tex = texturize(style_name, S, L, objs, face_objs, mats, tex_dir, samples)
            arm_obj["design_version"] = atlas.DESIGN_VERSION
        except Exception:
            import traceback
            print("WARN textures skipped:")
            traceback.print_exc()

    # ---- export
    meta = {
        "style": style_name,
        "bones": [
            {"name": n, "parent": p, "head": [round(h.x, 4), round(h.y, 4), round(h.z, 4)],
             "tail": [round(t.x, 4), round(t.y, 4), round(t.z, 4)]} for n, p, h, t in bones
        ],
        "meshes": {o.name: [k.name for k in o.data.shape_keys.key_blocks][1:] if o.data.shape_keys else []
                   for o in bpy.data.objects if o.type == "MESH"},
        "materials": [m.name for m in bpy.data.materials],
        "layout": {k: round(v, 4) for k, v in L.items()},
        "height_m": round(hc + hrz * (1.0 if humanoid or mascot else 1.4), 3),
    }
    if applied_tex is not None:
        meta["textures"] = applied_tex["textures"]
        meta["design_version"] = applied_tex["design_version"]
    if out_json:
        with open(out_json, "w") as f:
            json.dump(meta, f, indent=1)
    os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=out_glb, export_format="GLB", export_apply=False, export_morph=True, export_morph_normal=False,
        export_skins=True, export_animations=False, export_yup=True, export_extras=True,
        export_materials="EXPORT", export_cameras=False, export_lights=False, use_selection=False,
    )
    if out_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out_blend))
    return meta


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", default="premium", choices=list(STYLES))
    ap.add_argument("--out", required=True)
    ap.add_argument("--blend")
    ap.add_argument("--json")
    ap.add_argument("--tex-dir", default=None)
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--no-tex", action="store_true")
    a = ap.parse_args(argv)
    tex_dir = a.tex_dir
    if tex_dir is None:
        tex_dir = os.path.join("assets", "textures", a.style)
    if a.no_tex:
        tex_dir = None
    m = build(a.style, a.out, a.blend, a.json, tex_dir=tex_dir, samples=a.samples)
    print("OK", a.style, a.out, "height", m["height_m"], "bones", len(m["bones"]),
          "textures" if m.get("textures") else "flat")
    sys.stdout.flush()
    os._exit(0)  # bpy module teardown can crash (heap corruption); artifacts are already on disk
