"""Pre-bake a static (serverless) build of the WebXR viewer for GitHub Pages.

GitHub Pages can only serve files, and pymol-open-source can't run in a
browser -- so instead of exporting on demand like webxr/server.py does, this
runs the *same* real-PyMOL export pipeline (`rebuild_scene`) ahead of time
for a fixed grid of molecule x representation x color scheme, and writes
each result as its own compact .glb (see vr_pymol/glb_pack.py) next to a
copy of the frontend. The copied index.html gets a meta tag pointing at
`baked/manifest.json`, which switches the frontend to loading these files
instead of calling `/api/*`.

Per-molecule atom tables (`baked/atoms/<molecule>.json`) are written too, so
click-to-measure still works without a server: nearest-atom lookup and the
distance itself are plain Euclidean math on the same real PyMOL atom
coordinates `/api/pick` and `/api/distance` use.

Usage:
    python -m webxr.bake_static [out_dir]     # default: _site/
"""

import json
import os
import shutil
import sys
import time

from vr_pymol.glb_pack import has_geometry, pack_glb
from webxr import server

HERE = os.path.dirname(__file__)
DEFAULT_OUT = os.path.join(os.path.dirname(HERE), "_site")

MOLECULES = ["1crn", "caffeine", "1mbn", "1bna", "4hhb", "1lyz", "1gfl", "1le0"]

# One file per representation: the frontend loads each as its own layer and
# mixes them per residue in the browser, so no combinations are baked.
REPS = ["cartoon", "sticks", "spheres", "lines", "ribbon", "surface"]

COLORS = list(server._COLOR_SCHEMES)


def _slug(rep):
    return rep.replace("+", "-")


def bake(out_dir, molecules=MOLECULES, reps=REPS, colors=COLORS):
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    shutil.copytree(server.STATIC_DIR, out_dir)
    index_path = os.path.join(out_dir, "index.html")
    with open(index_path) as f:
        html = f.read()
    marker = '<meta name="vrpymol-static-manifest" content="./baked/manifest.json" />'
    html = html.replace("</head>", f"  {marker}\n</head>", 1)
    with open(index_path, "w") as f:
        f.write(html)
    baked_dir = os.path.join(out_dir, "baked")
    os.makedirs(os.path.join(baked_dir, "atoms"))
    os.makedirs(os.path.join(baked_dir, "hbonds"))
    # Pages runs Jekyll by default, which skips some paths; nothing here needs it.
    open(os.path.join(out_dir, ".nojekyll"), "w").close()

    files = {}
    total = len(molecules) * len(reps) * len(colors)
    done = 0
    for molecule in molecules:
        for rep in reps:
            for color in colors:
                start = time.time()
                server.rebuild_scene(molecule, rep, color=color)
                name = f"{molecule}__{_slug(rep)}__{color}.glb"
                done += 1
                if not has_geometry(server.GLTF_PATH):
                    # Left out of the manifest; the frontend reports it.
                    print(f"[{done}/{total}] {name} -- empty, skipped", flush=True)
                    continue
                pack_glb(server.GLTF_PATH, os.path.join(baked_dir, name))
                files[f"{molecule}|{rep}|{color}"] = f"baked/{name}"
                print(f"[{done}/{total}] {name} ({time.time() - start:.1f}s)", flush=True)

        atoms = server.atom_table(server._get_session())
        with open(os.path.join(baked_dir, "atoms", f"{molecule}.json"), "w") as f:
            json.dump(atoms, f, separators=(",", ":"))
        with open(os.path.join(baked_dir, "hbonds", f"{molecule}.json"), "w") as f:
            json.dump(server.hbond_pairs(server._get_session()), f, separators=(",", ":"))

    manifest = {
        "molecules": molecules,
        "reps": reps,
        "colors": colors,
        "files": files,
        "atoms": {m: f"baked/atoms/{m}.json" for m in molecules},
        "hbonds": {m: f"baked/hbonds/{m}.json" for m in molecules},
    }
    with open(os.path.join(baked_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    return manifest


if __name__ == "__main__":
    bake(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT)
