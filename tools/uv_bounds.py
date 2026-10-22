import json, struct, sys, os

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()
off = 12
clen, ctype = struct.unpack_from("<II", data, off)
js = json.loads(data[off + 8:off + 8 + clen])
boff = off + 8 + clen
blen, btype = struct.unpack_from("<II", data, boff)
bin_data = data[boff + 8: boff + 8 + blen]
print("==", os.path.basename(path), "nverts-prims:", len(js["meshes"]))
for mi, mesh in enumerate(js["meshes"]):
    for pi, p in enumerate(mesh["primitives"]):
        attrs = p["attributes"]
        ti = attrs.get("TEXCOORD_0")
        mname = js["materials"][p["material"]]["name"]
        if ti is None:
            print(f"{mesh['name']} p{pi} mat={mname} NO-UV")
            continue
        acc = js["accessors"][ti]
        bv = js["bufferViews"][acc["bufferView"]]
        start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        n = acc["count"]
        uv = struct.unpack_from(f"<{n*2}f", bin_data, start)
        us = uv[0::2]
        vs = uv[1::2]
        print(f"{mesh['name']} p{pi} mat={mname} uv_x[{min(us):.3f}..{max(us):.3f}] uv_y[{min(vs):.3f}..{max(vs):.3f}]")
