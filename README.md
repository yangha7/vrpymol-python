# VR PyMOL (Python / WebXR)

A VR molecular structure viewer backed by **real [pymol-open-source](https://github.com/schrodinger/pymol-open-source)** rendering, served over **WebXR** so it runs on a Quest (or any WebXR browser) with no SteamVR, no PC tether, and no native app build — just a browser pointed at a local server.

This is a from-scratch rewrite of an earlier Unity/OpenXR version of the same idea, built on a different premise: instead of reimplementing PyMOL's rendering algorithms (cartoons, coloring, representations) by hand, it drives the real PyMOL engine headlessly and re-renders its actual output.

## Why WebXR

Getting real VR rendering onto a Mac (or any machine without a PC VR runtime) is normally impossible — Apple ships no OpenXR runtime and SteamVR dropped macOS support years ago. WebXR sidesteps this entirely: Quest and other headsets support WebXR natively in-browser, so the machine running PyMOL just needs to serve a page over the local network. No SteamVR, no PC tether, no OS-specific runtime, and (unlike a from-scratch native rewrite) no Quest-standalone/Android build step either.

## How it works

```
pymol-open-source (headless)  →  VRML2 (.wrl)  →  VTK  →  glTF  →  Three.js (WebXR)
```

PyMOL's own OBJ/COLLADA export bakes spheres/cartoons into degenerate or bulky meshes, but its VRML2 (`.wrl`) export writes real native primitives — `Sphere`/`Cylinder` nodes per atom/bond, a baked mesh for cartoon ribbons. VTK parses that VRML2 directly into real actors (batched via `vtkGlyph3D`/`vtkAppendPolyData` for large structures, not one actor per atom) and exports it as glTF, which the WebXR frontend loads and renders with Three.js. Every representation, color scheme, and geometry detail on screen is PyMOL's own real output — nothing here reimplements PyMOL's rendering.

## Features

- **Representations**: cartoon, sticks, spheres, lines, ribbon, nonbonded, nb_spheres, surface, mesh, dots — combinable like real PyMOL (not single-select).
- **Coloring**: default CPK, by chain, rainbow (N→C), by secondary structure, by B-factor — all real PyMOL commands (`util.cbc`, `util.chainbow`, `util.cbss`, `cmd.spectrum`).
- **Cartoon detail**: flat/smooth sheets, smooth loops (real `cartoon_*` settings).
- **Size controls**: stick radius, sphere scale (real `cmd.set` settings).
- **Show/hide hydrogens and waters.**
- **Click-to-measure**: click two atoms to get their real PyMOL distance (`cmd.get_distance`).
- **Multiple objects at once**: load several molecules into the same scene via the "additional objects" panel — auto-arranged so they don't overlap.
- **Multiple states / movie frames**: a real `cmd.frame` slider appears for multi-state molecules (e.g. NMR ensembles — try `1le0`, a real 20-model structure).
- **Residue selection**: point at the molecule to select a residue, or pick residues (click one, sweep for a range) in a sequence window. Selected atoms get pink markers and the selection is shown as a PyMOL expression (`chain A and resi 6-18`). Works in the static build too.
- **VR controls**: **trigger** selects (a residue on the molecule, or a letter on the sequence window), **grip** grabs — one hand to move/rotate, both hands to scale and rotate — **thumbstick** forward/back zooms, **A/B** (X/Y on the left hand) shows or hides the sequence window, which floats below the molecule.
- **Reset view**, background color picker.

**Known architectural limits** (checked directly against PyMOL's real VRML2 export, not assumed): 2D atom/residue **labels** and per-representation **transparency** never survive this export path — PyMOL's own VRML2 writer doesn't emit them regardless of settings. Everything else in the app is a real, verified PyMOL feature.

## Getting started

Requires [Homebrew](https://brew.sh) and `conda`/`mamba` (via miniforge):

```bash
brew install --cask miniforge
conda create -n vrpymol -c conda-forge pymol-open-source python=3.11
conda activate vrpymol
pip install vtk numpy flask cryptography pytest pygltflib playwright
playwright install chromium  # only needed to run the frontend test suite
```

Run the server:

```bash
conda activate vrpymol
python -m webxr.server
```

It prints an HTTPS URL (WebXR requires a secure context, so the server terminates TLS itself with a self-signed dev cert — see `webxr/dev_cert.py`). Open that URL on the headset's browser (same Wi-Fi network), accept the certificate warning, and click "Enter VR". On a desktop browser it works the same way, minus the VR button.

## Static build (GitHub Pages, no server)

A serverless build is published at **https://anpigzhao-jpg.github.io/vrpymol-python/** — open it in the Meta Quest Browser and tap "Enter VR". Nothing needs to run on your computer.

Since PyMOL can't run inside a browser, the static build is pre-baked: `webxr/bake_static.py` runs the same real-PyMOL export pipeline ahead of time for every molecule × representation × color scheme in a fixed grid, compresses each scene to a quantized `.glb` (`vr_pymol/glb_pack.py`), and writes a per-molecule atom table so click-to-measure still works client-side. The page picks one representation preset at a time; free combination of representations, extra objects, NMR frames and the size/cartoon sliders need the live server above.

Rebuild and publish:

```bash
python -m webxr.bake_static          # writes _site/ (~15 min)
./webxr/publish_pages.sh             # pushes _site/ to the gh-pages branch
```

## Testing

```bash
python -m pytest -q
```

Tests run against the real pymol-open-source engine (no mocking) and drive the actual page via Playwright + headless Chromium for frontend behavior — see `tests/` for the full breakdown by milestone/feature.

## Project layout

- `pymol_bridge/` — thin wrapper around real pymol-open-source (`pymol2.PyMOL()`), object/state management, VRML2 export.
- `vr_pymol/` — VRML2 parsing, batched VTK mesh loading, glTF export, desktop preview rendering.
- `webxr/` — the Flask server (`server.py`), the WebXR frontend (`static/`, plain Three.js + import maps, no build step), and the static GitHub Pages bake (`bake_static.py`, `publish_pages.sh`).
- `tests/` — real-PyMOL-backed pytest suite, including Playwright-driven frontend tests via a live server subprocess.

## Platform note

This project targets **desktop + WebXR browsers** (Quest, Safari on visionOS, etc.) — it does not produce a Quest-standalone/Android build, since that isn't something a pure Python + browser stack can do. If an untethered native Quest build is ever needed, that requires a different stack (Unity/Unreal or other native Android+OpenXR).
