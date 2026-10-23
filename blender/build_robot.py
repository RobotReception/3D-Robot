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

# --------------------------------------------------------------------------- styles
STYLES = {
    # Warm, rounded, approachable.
    "friendly": dict(
        head_r=0.255, head_sq=(1.0, 0.9, 0.88), e_head=0.78, torso=(0.175, 0.135, 0.17),
        e_box=0.72, thigh=0.215, shin=0.215, limb_r=0.054, upper=0.19, fore=0.19, chest_h=0.2,
        shell=(0.95, 0.95, 0.96), shell2=(0.80, 0.82, 0.85), dark=(0.06, 0.065, 0.08),
        accent=(0.42, 0.46, 0.54), glow=(0.04, 0.62, 1.0), metal=0.15, rough=0.28, coat=0.8,
        eye=(0.115, 0.135), mouth_w=0.07, chest="panel",
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
        kind="humanoid", head_r=0.168, head_sq=(1.0, 0.94, 0.95), e_head=0.72, torso=(0.19, 0.122, 0.17),
        e_box=0.75, thigh=0.37, shin=0.37, limb_r=0.047, upper=0.27, fore=0.25, chest_h=0.27, hip_x=0.098, foot=1.3, sh_x=0.238,
        shell=(0.95, 0.955, 0.965), shell2=(0.72, 0.74, 0.78), dark=(0.028, 0.031, 0.04), accent=(0.86, 0.66, 0.38),
        uniform=(0.007, 0.014, 0.05), glow=(0.0, 0.62, 1.0), metal=0.0, rough=0.22, coat=1.0, eye=(0.05, 0.06), eye_p=2.1,
        mouth_w=0.05, eye_x_k=0.34, eye_z_k=0.1, mouth_z_k=0.36, mouth_rest_curve=0.6, hide_brows=True,
        glow_strength=1.2, face_strength=0.3,
    ),
    # Chibi mascot: huge head, small egg body, stubby limbs, glowing rings (cute assistant for kiosks/apps).
    "mascot": dict(
        kind="mascot", head_r=0.25, head_sq=(1.0, 0.9, 0.86), e_head=0.86, torso=(0.172, 0.15, 0.2),
        e_box=0.9, thigh=0.06, shin=0.06, limb_r=0.05, upper=0.085, fore=0.075, chest_h=0.07, hip_x=0.076, foot=0.85,
        ankle=0.035, sh_x=0.178, hand_scale=0.6, logo_z=0.375,
        shell=(0.93, 0.935, 0.945), shell2=(0.78, 0.8, 0.83), dark=(0.025, 0.028, 0.035), accent=(0.78, 0.8, 0.83),
        glow=(0.0, 0.55, 1.0), metal=0.0, rough=0.42, coat=0.3, eye=(0.068, 0.078), eye_p=2.0, mouth_w=0.032,
        eye_x_k=0.34, eye_z_k=0.08, mouth_z_k=0.3, mouth_rest_curve=0.85, hide_brows=True,
        visor_w=0.76, visor_h=0.62, visor_z=0.0, visor_bulge=0.014, glow_strength=1.1, face_strength=0.5,
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
    """Receptionist robot (matches the concierge reference sheet): rounded helmet with a big black visor and cyan
    headphone pods, navy vest over a white shirt + tie, gold medallion, charcoal joints, white shell limbs, shoes with a
    cyan sole line. Returns the face-plane y. Every piece is weighted to ONE bone (rigid, no stretching)."""
    hr, sq = S["head_r"], S["head_sq"]
    hc = L["head_c"]
    hrx, hry, hrz = hr * sq[0], hr * sq[1], hr * sq[2]
    tx, ty, _ = S["torso"]
    sh, un, dk, gl, ac, vi = P["shell"], P["uniform"], P["dark"], P["glow"], P["accent"], P["visor"]
    s2 = P["shell2"]
    PI = math.pi

    def ring(center, R, axis, bone, r=0.0045, disc=True):
        """glowing ring joint marker: glow torus + charcoal recessed disc"""
        gl.torus(center, R, r, bone, axis=axis, nu=40, nv=8)
        if disc:
            dk.ellipsoid(center, (R * 0.92, R * 0.92, 0.004), bone, e1=0.5, axis=axis, nu=28, nv=6)

    # ---- head: rounded helmet, large glossy black visor, headphone pods with cyan rings
    sh.ellipsoid((0, 0, hc), (hrx, hry, hrz), "head", e1=S["e_head"], e2=S["e_head"], nu=64, nv=40)
    vis_c = (0, -hry * 0.70, hc - hrz * 0.02)
    vis_depth = hry * 0.36
    vi.ellipsoid(vis_c, (hrx * 0.84, hrz * 0.74, vis_depth), "head", e1=0.34, e2=0.5, axis=(0, -1, 0), nu=64, nv=28)
    face_y = vis_c[1] - vis_depth - 0.0035
    dk.ellipsoid((0, -hry * 0.12, hc + hrz * 0.985), (0.034, 0.014, 0.006), "head", e1=0.5, nu=20, nv=8)       # top sensor slot
    gl.ellipsoid((0, hry * 0.985, hc + hrz * 0.12), (0.045, 0.004, 0.0065), "head", e1=0.5, axis=(0, 1, 0), nu=24, nv=8)  # back light bar
    for sx in (1, -1):
        ax = (sx, 0, 0)
        x0 = sx * hrx * 0.95
        sh.ellipsoid((x0, 0.008, hc), (hrz * 0.46, hrz * 0.46, 0.03), "head", e1=0.5, axis=ax, nu=48, nv=14)          # pod housing
        dk.ellipsoid((x0 + sx * 0.026, 0.008, hc), (hrz * 0.36, hrz * 0.36, 0.012), "head", e1=0.5, axis=ax, nu=40, nv=8)
        gl.torus((x0 + sx * 0.035, 0.008, hc), hrz * 0.27, 0.0055, "head", axis=ax, nu=48, nv=8)                      # cyan ring
        sh.ellipsoid((x0 + sx * 0.035, 0.008, hc), (hrz * 0.18, hrz * 0.18, 0.007), "head", e1=0.6, axis=ax, nu=32, nv=8)
    # neck: charcoal column with two ribs
    dk.ellipsoid((0, 0, L["neck"] + 0.03), (0.044, 0.044, 0.06), "neck", e1=0.55, nu=24, nv=10)
    for dz in (0.012, 0.045):
        s2.torus((0, 0, L["neck"] + dz), 0.043, 0.005, "neck", nu=28, nv=6)

    # ---- torso: navy vest (the shell itself), white shirt V + collar, tie, gold medallion, name tag, cyan piping
    ch_c = L["chest"] + S["chest_h"] * 0.5
    ch_c_r = S["chest_h"] * 0.62 + 0.03
    tp = (0.7, 1.0)
    E1, E2 = 0.62, 0.62

    def tpt(u, v, lift):
        cv, sv = math.cos(v), math.sin(v)
        f = (tp[0] + (tp[1] - tp[0]) * (sv * 0.5 + 0.5)) * lift
        return (tx * f * spow(cv, E1) * spow(math.cos(u), E2), ty * f * spow(cv, E1) * spow(math.sin(u), E2),
                ch_c + ch_c_r * lift * spow(sv, E1))

    def fpt(x, z, lift, back=False):
        """point on the torso surface at height z and lateral offset x (front, or back if `back`)"""
        sv = max(-0.999, min(0.999, (z - ch_c) / ch_c_r))
        sv = math.copysign(abs(sv) ** (1 / E1), sv)
        cv = math.sqrt(max(1e-6, 1 - sv * sv))
        f = tp[0] + (tp[1] - tp[0]) * (sv * 0.5 + 0.5)
        cu = max(-0.999, min(0.999, x / (tx * f * cv ** E1)))
        cu = math.copysign(abs(cu) ** (1 / E2), cu)
        u = math.acos(cu) * (1 if back else -1)
        return tpt(u, math.asin(sv), lift)

    def band(part, half, z0, z1, lift, nu=12, nv=16, back=False):
        """surface strip on the torso centre line from z0 to z1; half(t) = half-width in metres at t in 0..1"""
        rows = []
        for i in range(nv + 1):
            tt = i / nv
            hw = half(tt)
            rows.append([fpt(-hw + 2 * hw * j / nu, z0 + (z1 - z0) * tt, lift, back) for j in range(nu + 1)])
        part.grid(rows, "chest")

    un.ellipsoid((0, 0, ch_c), (tx, ty, ch_c_r), "chest", e1=E1, e2=E2, taper=tp, nu=72, nv=36)
    FRONT = -PI / 2
    zs0, zs1 = ch_c - 0.085, L["neck"] - 0.012
    band(sh, lambda t: 0.006 + 0.085 * t ** 1.1, zs0, zs1, 1.012, nu=16, nv=24)                         # white shirt V
    band(un, lambda t: 0.002 + 0.019 * min(1.0, t * 6) - 0.008 * t, zs0 + 0.01, zs1 - 0.03, 1.022, nu=6, nv=20)  # tie (pointed tip)
    zk = zs1 - 0.022
    yk = fpt(0, zk, 1.0)[1]
    un.ellipsoid((0, yk - 0.008, zk), (0.019, 0.012, 0.016), "chest", e1=0.6, axis=(0, -1, 0), nu=16, nv=10)     # knot
    band(gl, lambda t: 0.006, ch_c - 0.07, ch_c + 0.1, 1.012, nu=4, nv=10, back=True)                    # back light slit
    for sx in (1, -1):  # shirt collar wings
        sh.ellipsoid((sx * 0.03, -0.05, L["neck"] - 0.008), (0.032, 0.028, 0.009), "chest", e1=0.6, axis=(sx * 0.5, -0.6, 0.6), nu=16, nv=8)
    sh.torus((0, -0.002, L["neck"] + 0.006), 0.052, 0.01, "chest", nu=32, nv=8)                          # collar band
    # shoulder yoke (navy) so the vest reads continuous to the shoulder caps
    un.ellipsoid((0, 0.004, L["neck"] - 0.05), (L["sh_x"] * 0.78, ty * 0.62, 0.04), "chest", e1=0.6, e2=0.8, nu=40, nv=14)
    nt = tpt(FRONT + 0.62, 0.42, 1.0)
    s2.ellipsoid((nt[0], nt[1] - 0.004, nt[2]), (0.026, 0.004, 0.009), "chest", e1=0.4, e2=0.5,
                 nu=16, nv=8, axis=(0.25, -1, 0))                                                         # name tag
    # one seamless waist in the vest fabric: flows from the chest, gently narrows, tucks into the hips (no rings, no glow)
    wt, wb = ch_c - ch_c_r * 0.55, L["pel"] + 0.03

    def waist_r(t):
        if t <= 0 or t >= 1:
            return 0.0
        r_ = tx * (0.6 - 0.06 * math.sin(math.pi * min(1.0, t * 1.1)))
        cap = 0.08
        if t < cap:
            r_ *= math.sqrt(1 - ((cap - t) / cap) ** 2)
        if t > 1 - cap:
            r_ *= math.sqrt(1 - ((t - 1 + cap) / cap) ** 2)
        return r_
    un.lathe((0, 0, wt), (0, 0, wb), waist_r, "spine", nu=64, nv=36, cross=(1.0, ty / tx * 1.05))
    sh.ellipsoid((0, 0, L["pel"] - 0.005), (tx * 0.86, ty * 0.96, 0.095), "pelvis", e1=0.7, e2=0.8, nu=44, nv=18)
    for sx in (1, -1):  # charcoal groin seams
        dk.capsule((sx * 0.012, -ty * 0.93, L["pel"] - 0.07), (sx * 0.075, -ty * 0.82, L["pel"] + 0.03), 0.004, 0.004, "pelvis", nu=8, nv=6)

    r = S["limb_r"]
    for side, sx in (("L", 1), ("R", -1)):
        shx, shz = L["sh_x"] * sx, L["sh_z"]
        elb, wr = L["elbow"], L["wrist"]
        # -- arm: refined segmented shell like the reference: sculpted charcoal shoulder cap hugging the torso,
        #    white upper-arm and forearm shells that flare over small recessed charcoal joints (no exposed balls/rings)
        un.capsule((sx * tx * 0.3, 0, shz - 0.008), (shx - sx * 0.02, 0, shz - 0.008), r * 0.95, r, f"clavicle_{side}")
        dk.ellipsoid((shx, 0, shz - 0.01), (0.04, 0.04, 0.04), f"upperarm_{side}", nu=24, nv=12)                     # hidden pivot
        dk.ellipsoid((shx + sx * 0.008, 0, shz + 0.012), (0.066, 0.062, 0.058), f"upperarm_{side}", e1=0.7, e2=0.85,
                     taper=(0.82, 1.0), nu=48, nv=24)                                                                # shoulder cap
        sh.ellipsoid((shx, 0, (shz + elb) / 2 - 0.012), (0.046, 0.044, (shz - elb) / 2 - 0.004), f"upperarm_{side}",
                     e1=0.8, e2=0.95, taper=(0.86, 1.0), nu=40, nv=24)                                               # upper-arm shell
        dk.ellipsoid((shx, 0, elb), (0.034, 0.034, 0.036), f"forearm_{side}", nu=24, nv=12)                           # recessed elbow
        sh.ellipsoid((shx, 0, (elb + wr) / 2 - 0.006), (0.043, 0.041, (elb - wr) / 2 + 0.004), f"forearm_{side}",
                     e1=0.8, e2=0.95, taper=(0.74, 1.0), nu=40, nv=24)                                               # forearm shell
        dk.ellipsoid((shx, 0, wr + 0.004), (0.026, 0.025, 0.02), f"forearm_{side}", e1=0.6, nu=24, nv=8)              # slim wrist
        # -- hand: white back, charcoal palm and knuckles
        sh.ellipsoid((shx, 0, wr - 0.052), (0.027, 0.047, 0.05), f"hand_{side}", e1=0.7, e2=0.8, nu=28, nv=14)
        dk.ellipsoid((shx - sx * 0.019, 0, wr - 0.048), (0.012, 0.037, 0.039), f"hand_{side}", e1=0.6, nu=18, nv=8)
        for fname in FINGERS:
            for seg in (1, 2):
                b = bones[bone_index[f"finger_{fname}_{seg}_{side}"]]
                p0, p1 = b[2], b[3]
                rad = 0.0112 if seg == 1 else 0.0098
                if fname == "thumb":
                    rad *= 1.15
                d = p1 - p0
                (sh if seg == 1 else dk).capsule(p0 + d * 0.06, p1 + d * (0.14 if seg == 2 else -0.04), rad,
                                                 rad * (0.85 if seg == 2 else 1.0), b[0], nu=14, nv=8)
                dk.ellipsoid(p0, (rad * (1.05 if seg == 1 else 0.95),) * 3, b[0], nu=10, nv=6)
        # -- leg
        hx = L["hip_x"] * sx
        hip, knee, ank = L["hip"], L["knee"], L["ankle"]
        dk.ellipsoid((hx, 0, hip), (0.066, 0.066, 0.066), f"thigh_{side}", nu=26, nv=14)
        sh.capsule((hx, 0, hip - 0.04), (hx, 0, knee + 0.045), 0.08, 0.06, f"thigh_{side}", nu=32, nv=16)
        dk.torus((hx, 0, knee + 0.1), 0.062, 0.0025, f"thigh_{side}", nu=32, nv=5)
        # knee: charcoal joint with a big rounded pad
        dk.ellipsoid((hx, 0, knee), (0.055, 0.055, 0.055), f"shin_{side}", nu=24, nv=12)
        dk.ellipsoid((hx, -0.04, knee + 0.008), (0.05, 0.034, 0.058), f"shin_{side}", e1=0.75, e2=0.8, nu=32, nv=16)
        sh.capsule((hx, 0, knee - 0.05), (hx, 0, ank + 0.06), 0.06, 0.043, f"shin_{side}", nu=28, nv=14)
        sh.ellipsoid((hx, 0.028, knee - 0.12), (0.048, 0.046, 0.11), f"shin_{side}", e1=0.8, e2=0.8, nu=24, nv=12)   # calf
        dk.torus((hx, 0, knee - 0.085), 0.049, 0.0022, f"shin_{side}", nu=28, nv=5)
        ac.torus((hx, 0, ank + 0.07), 0.041, 0.0035, f"shin_{side}", nu=32, nv=6)                                 # gold ankle trim
        dk.ellipsoid((hx, 0, ank + 0.02), (0.042, 0.042, 0.042), f"foot_{side}", nu=20, nv=10)
        # shoe: chunky white upper, toe cap, charcoal sole with a wrap-around cyan line
        fl = S.get("foot", 1.0)
        sh.ellipsoid((hx, -0.045 * fl, 0.064), (0.06, 0.118 * fl, 0.054), f"foot_{side}", e1=0.65, e2=0.8, nu=40, nv=18)
        sh.ellipsoid((hx, -0.15 * fl, 0.048), (0.056, 0.07 * fl, 0.04), f"toe_{side}", e1=0.65, e2=0.8, nu=32, nv=14)
        dk.ellipsoid((hx, -0.07 * fl, 0.017), (0.064, 0.152 * fl, 0.018), f"foot_{side}", e1=0.45, e2=0.8, nu=40, nv=10)
        ring_pts = []
        for j in range(65):
            u = 2 * PI * j / 64
            ring_pts.append((hx + 0.0655 * spow(math.cos(u), 0.8), -0.07 * fl + 0.1545 * fl * spow(math.sin(u), 0.8)))
        gl.grid([[(x, y, 0.029) for x, y in ring_pts], [(x, y, 0.036) for x, y in ring_pts]], f"foot_{side}")
    return face_y


def mascot_parts(P, S, L, bones, bone_index):
    """Chibi assistant (reference sheet: 92 x 58 cm): big helmet head with an inset glossy black visor framed by a raised
    rim, silver/white headphone pods with a thin cyan ring, glowing neck ring, pear-shaped body with a chest emblem and a
    back service port, chunky smooth-skinned arms with real chubby fingers, short legs and rounded shoes.
    Returns (face_y, project_fn)."""
    hr, sq = S["head_r"], S["head_sq"]
    hc = L["head_c"]
    hrx, hry, hrz = hr * sq[0], hr * sq[1], hr * sq[2]
    sh, s2, dk, gl, ac, vi = P["shell"], P["shell2"], P["dark"], P["glow"], P["accent"], P["visor"]
    PI = math.pi

    def sstep(a_, b_, x):
        k = min(1.0, max(0.0, (x - a_) / (b_ - a_)))
        return k * k * (3 - 2 * k)

    def blend(b_hi, b_lo, z_mid, half):
        def f(co):
            w = sstep(z_mid - half, z_mid + half, co.z)
            return {b_hi: w, b_lo: 1 - w}
        return f

    def profile(keys, cap0, cap1):
        """keys: [(t, r)] cosine-interpolated radius, elliptical caps of length cap0/cap1 (t units)"""
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

    E = S["e_head"]

    def head_y(x, z, lift=0.0):
        """front (-Y) surface of the (super)ellipsoid head at (x, z), pushed outward by `lift` metres"""
        q = 1 - abs(x / hrx) ** (2 / E) - abs((z - hc) / hrz) ** (2 / E)
        return -hry * max(q, 0.0) ** (E / 2) - lift

    # ---- head: rounded helmet (slightly squarer than a sphere), dense for clean highlights
    sh.ellipsoid((0, 0, hc), (hrx, hry, hrz), "head", e1=E, e2=E, nu=88, nv=60)
    # visor: rounded-rectangle glass bulging out of the face, framed by a raised white rim with a dark seam
    fa, fb, fz, fp = hrx * S["visor_w"], hrz * S["visor_h"], hc + hrz * S["visor_z"], 3.2
    bulge = S.get("visor_bulge", 0.012)

    def vis_rr(x, z):
        return (abs(x / fa) ** fp + abs((z - fz) / fb) ** fp) ** (1 / fp)

    def vis_lift(x, z):
        rr = min(1.0, vis_rr(x, z))
        return 0.002 + bulge * (1 - rr * rr) ** 0.6

    def ring_rows(r0, r1, nr, lift_fn, nt=120):
        rows = []
        for i in range(nr + 1):
            rr = r0 + (r1 - r0) * i / nr
            row = []
            for j in range(nt + 1):
                th = 2 * PI * j / nt
                cx, cz = math.cos(th), math.sin(th)
                k = (abs(cx) ** fp + abs(cz) ** fp) ** (-1 / fp)
                x, z = fa * rr * k * cx, fz + fb * rr * k * cz
                row.append((x, head_y(x, z, lift_fn(rr, x, z)), z))
            rows.append(row)
        return rows

    vi.grid(ring_rows(0.0, 1.0, 20, lambda rr, x, z: vis_lift(x, z)), "head")
    dk.grid(ring_rows(0.995, 1.035, 2, lambda rr, x, z: 0.0026), "head")                                 # dark seam
    sh.grid(ring_rows(1.03, 1.16, 8, lambda rr, x, z: 0.001 + 0.006 * math.sin(PI * (rr - 1.03) / 0.13) ** 0.7), "head")  # raised rim
    project = lambda x, z: head_y(x, z, vis_lift(x, z) + 0.0018)  # face LEDs ride just above the glass
    face_y = head_y(0, hc, vis_lift(0, hc) + 0.0018)

    # ---- headphone pods: white housing, silver ring, white cap, thin cyan light ring where they meet the head
    for sx in (1, -1):
        x0, z0 = sx * hrx * 0.93, hc - hrz * 0.04
        ax = (sx, 0, 0)
        R = hrz * 0.36
        sh.ellipsoid((x0 + sx * 0.022, 0.004, z0), (R, R, 0.034), "head", e1=0.5, axis=ax, nu=56, nv=14)          # housing
        gl.torus((x0 + sx * 0.006, 0.004, z0), R * 0.985, 0.0042, "head", axis=ax, nu=96, nv=8)                   # cyan ring
        ac.torus((x0 + sx * 0.056, 0.004, z0), R * 0.62, 0.0085, "head", axis=ax, nu=72, nv=12)                  # silver ring
        s2.ellipsoid((x0 + sx * 0.052, 0.004, z0), (R * 0.56, R * 0.56, 0.008), "head", e1=0.55, axis=ax, nu=56, nv=10)  # recessed cap
        sh.ellipsoid((x0 + sx * 0.056, 0.004, z0), (R * 0.36, R * 0.36, 0.008), "head", e1=0.6, axis=ax, nu=48, nv=10)  # centre button

    # ---- neck: dark collar with a soft cyan light ring the head sits on
    dk.ellipsoid((0, 0, L["neck"] + 0.028), (0.112, 0.098, 0.02), "neck", e1=0.6, nu=64, nv=10)
    gl.torus((0, 0, L["neck"] + 0.034), 0.108, 0.0062, "neck", nu=96, nv=10)

    # ---- body: one seamless pear shape (narrow shoulders, round belly), smooth weights pelvis -> spine -> chest
    tx = S["torso"][0]
    bt, bb = L["neck"] + 0.034, L["pel"] - 0.07
    body_w = lambda co: (lambda w1, w2: {"chest": w2, "spine": w1 - w2, "pelvis": 1 - w1})(
        sstep(L["pel"], L["spine"] + 0.02, co.z), sstep(L["spine"] + 0.02, L["chest"], co.z))
    cross_y = 0.88
    body_r = profile([(0, tx * 0.8), (0.3, tx * 0.9), (0.66, tx * 1.0), (1, tx * 0.93)], 0.14, 0.26)
    sh.lathe((0, 0, bt), (0, 0, bb), body_r, body_w, nu=80, nv=48, cross=(1.0, cross_y))

    def body_front(z, lift=0.0, back=False):
        t = (bt - z) / (bt - bb)
        return (1 if back else -1) * (body_r(t) * cross_y + lift)

    # chest emblem (also the default logo spot): silver bezel, light ring, pale disc
    ze = S.get("logo_z", L["chest"])
    ye = body_front(ze)
    ac.torus((0, ye - 0.004, ze), 0.024, 0.0042, "chest", axis=(0, -1, 0), nu=64, nv=10)
    gl.torus((0, ye - 0.0055, ze), 0.0175, 0.0018, "chest", axis=(0, -1, 0), nu=56, nv=6)
    s2.ellipsoid((0, ye - 0.002, ze), (0.02, 0.02, 0.004), "chest", e1=0.6, axis=(0, -1, 0), nu=40, nv=8)
    # back service port: dark rounded square with a silver lens
    zb = L["chest"] - 0.01
    yb = body_front(zb, back=True)
    dk.ellipsoid((0, yb + 0.002, zb), (0.03, 0.026, 0.006), "chest", e1=0.35, e2=0.4, axis=(0, 1, 0), nu=40, nv=8)
    ac.ellipsoid((0, yb + 0.006, zb), (0.009, 0.009, 0.004), "chest", e1=0.6, axis=(0, 1, 0), nu=24, nv=8)

    # ---- arms: shoulder -> chunky tapered arm -> wrist as ONE lathe (smooth upperarm/forearm/hand weights) + real hand
    hs = S.get("hand_scale", 1.0)
    for sx in (1, -1):
        side = "L" if sx == 1 else "R"
        shx, shz, elb, wr = L["sh_x"] * sx, L["sh_z"], L["elbow"], L["wrist"]
        top, bot = shz + 0.052, wr - 0.012
        ln = top - bot

        def arm_w(co, elb=elb, wr=wr, side=side):
            w_up = sstep(elb - 0.03, elb + 0.03, co.z)
            w_hand = 1 - sstep(wr - 0.012, wr + 0.012, co.z)
            return {f"upperarm_{side}": w_up * (1 - w_hand), f"forearm_{side}": (1 - w_up) * (1 - w_hand), f"hand_{side}": w_hand}
        r0 = S["limb_r"] * 1.22
        prof = profile([(0, r0), (0.35, r0 * 0.97), (0.7, r0 * 0.86), (1, r0 * 0.8)], r0 / ln * 0.9, r0 / ln * 0.5)
        sh.lathe((shx - sx * 0.012, 0, top), (shx + sx * 0.004, 0, bot), prof, arm_w, nu=48, nv=36, cross=(1.0, 0.94),
                 bend=(sx * 0.01, 0, 0))
        # hand: soft palm block + chubby two-segment fingers on the real finger bones (they curl, wave and point)
        hx = shx + sx * 0.004
        sh.ellipsoid((hx, -0.004, wr - 0.03 * hs / 0.55), (0.028, 0.036, 0.034), f"hand_{side}", e1=0.75, e2=0.8, nu=32, nv=16)
        for fname in FINGERS:
            for seg in (1, 2):
                b = bones[bone_index[f"finger_{fname}_{seg}_{side}"]]
                p0, p1 = b[2], b[3]
                d = p1 - p0
                rad = (0.0118 if fname == "thumb" else 0.0102) * (1.0 if seg == 1 else 0.96)
                sh.capsule(p0 - d * 0.15, p1 + d * (0.25 if seg == 2 else 0.05), rad, rad * (0.92 if seg == 2 else 1.0), b[0], nu=14, nv=8)

    # ---- legs: short thick stubs (thigh/shin smooth weights) + rounded shoes
    for sx in (1, -1):
        side = "L" if sx == 1 else "R"
        hx = L["hip_x"] * sx
        knee, ank = L["knee"], L["ankle"]
        top, bot = L["pel"] - 0.01, ank - 0.012
        ln = top - bot
        r = S["limb_r"] * 1.28
        sh.lathe((hx, 0, top), (hx, 0, bot), profile([(0, r), (0.55, r * 0.95), (1, r * 0.93)], 0.3, r / ln * 0.5),
                 blend(f"thigh_{side}", f"shin_{side}", knee, 0.025), nu=48, nv=24)
        fl = S.get("foot", 1.0)
        sh.ellipsoid((hx, -0.022, 0.036), (r * 1.12, 0.09 * fl / 0.8, 0.038), f"foot_{side}", e1=0.68, e2=0.82, nu=48, nv=20)
        s2.ellipsoid((hx, -0.022, 0.006), (r * 1.08, 0.086 * fl / 0.8, 0.008), f"foot_{side}", e1=0.5, e2=0.82, nu=56, nv=8)  # sole
    return face_y, project

# --------------------------------------------------------------------------- main build
def build(style_name, out_glb, out_blend=None, out_json=None):
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
    if S.get("logo_z"):
        arm_obj["logo_height"] = S["logo_z"]
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
        "glow": make_material("Mat_Glow", (0.02, 0.02, 0.025), 0.0, 0.4, 0.0, S["glow"], 0.9),
        "face": make_material("Mat_Face", (0.02, 0.02, 0.025), 0.0, 0.5, 0.0, S["glow"], 0.4),
    }
    for k in ("face",):
        mats[k].use_backface_culling = False
    humanoid = S.get("kind") == "humanoid"
    mascot = S.get("kind") == "mascot"
    if humanoid or mascot:
        for k in ("dark", "accent", "glow", "face"):  # replace the generic ones (avoid ".001" duplicate names the engine looks up)
            bpy.data.materials.remove(mats[k])
        if humanoid:
            mats["uniform"] = make_material("Mat_Uniform", S["uniform"], 0.05, 0.42, 0.35)
        mats["dark"] = make_material("Mat_Dark", S["dark"], 0.2, 0.28, 0.8)
        mats["accent"] = make_material("Mat_Accent", S["accent"], 0.9, 0.25, 0.4)
        mats["glow"] = make_material("Mat_Glow", (0.02, 0.02, 0.025), 0.0, 0.4, 0.0, S["glow"], S.get("glow_strength", 1.7))
        mats["face"] = make_material("Mat_Face", (0.02, 0.02, 0.025), 0.0, 0.5, 0.0, S["glow"], S.get("face_strength", 1.5))
        mats["face"].use_backface_culling = False
        if True:  # deep glossy black faceplate (less env reflection than the generic visor)
            bpy.data.materials.remove(mats["visor"])
            mats["visor"] = make_material("Mat_Visor", (0.0, 0.0, 0.004), 0.0, 0.1 if mascot else 0.16, 0.0)
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
        if S.get("chest") == "panel":
            # clean chest: low-profile rounded panel flush on the shell + a slim status light (no round core)
            cz = L["chest"] + S["chest_h"] * 0.55
            P["shell2"].ellipsoid((0, -ty * 0.9, cz), (tx * 0.62, S["chest_h"] * 0.36, 0.02), "chest", e1=0.35, e2=0.45,
                                  axis=(0, -1, 0), nu=40, nv=10)
            P["shell"].ellipsoid((0, -ty * 0.9 - 0.006, cz), (tx * 0.58, S["chest_h"] * 0.33, 0.02), "chest", e1=0.35,
                                 e2=0.45, axis=(0, -1, 0), nu=40, nv=10)
            P["glow"].ellipsoid((0, -ty * 0.9 - 0.024, cz + S["chest_h"] * 0.2), (0.03, 0.004, 0.0035), "chest", e1=0.5,
                                axis=(0, -1, 0), nu=20, nv=8)
        # chest plate (accent) + glowing core
        if S.get("chest") != "panel": P["accent"].ellipsoid((0, -ty * 0.86, L["chest"] + S["chest_h"] * 0.52),
                              (tx * 0.52, tx * 0.52, 0.03), "chest", e1=0.5, axis=(0, -1, 0), nu=32, nv=8)
        if S.get("chest") != "panel": P["glow"].ellipsoid((0, -ty * 0.86 - 0.027, L["chest"] + S["chest_h"] * 0.52),
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
    mouth_base = mouth_shape(0.0001, thick=0.0001) if S.get("hide_idle_face") else mouth_shape(mw, curve=S.get("mouth_rest_curve", 0.0))
    shapes = {
        "mouthOpen": mouth_shape(mw * 0.9, 0.85),
        "viseme_sil": mouth_shape(0.0001, thick=0.0001) if S.get("hide_idle_face") else mouth_shape(mw, curve=S.get("mouth_rest_curve", 0.0)),
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
        mk = lambda **k: brow_shape(0.0002 if S.get("hide_brows") else bw, inner=inner, **({"th": 0.0001} if S.get("hide_brows") else {}), **k)
        shapes = {
            "browUp": mk(dz=0.017),
            "browDown": mk(dz=-0.012),
            "browInnerUp": mk(inner_dz=0.022, outer_dz=-0.004),
            "browInnerDown": mk(inner_dz=-0.02, outer_dz=0.006),
        }
        face_objs.append(make_face_mesh(f"Brow_{side}", None, arm_obj, "head", bone_index, bone_names, brow_shape(0.0002, th=0.0001, inner=inner) if S.get("hide_idle_face") or S.get("hide_brows") else mk(), face_y,
                                        bc, mats["face"], shapes, 7, 2, project=project))

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
    a = ap.parse_args(argv)
    m = build(a.style, a.out, a.blend, a.json)
    print("OK", a.style, a.out, "height", m["height_m"], "bones", len(m["bones"]))
