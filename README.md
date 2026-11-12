# VR PyMOL (Python / WebXR)

VR PyMOL displays molecular structures in virtual reality (VR) in a web browser, using geometry, colors and hydrogen bonds computed by [pymol-open-source](https://github.com/schrodinger/pymol-open-source). It is intended for researchers and teachers who know PyMOL and want to inspect a structure — select residues, mix representations, measure, show hydrogen bonds — on a Meta Quest headset or a desktop browser, without a tethered PC or a native application.

The viewer runs on WebXR, the browser interface to VR devices, so the headset needs only its built-in browser.

## Hosted build

A build that needs no installation is published with GitHub Pages:

- This fork: <https://yangha7.github.io/vrpymol-python/>
- Upstream: <https://anpigzhao-jpg.github.io/vrpymol-python/> (as of 2026-11-12 this serves an earlier version without selection, the menu, or the tools described below)

Open the address in the Meta Quest Browser and choose "Enter VR", or open it in a desktop browser. The hosted build offers eight bundled structures and seven representations; see [Static build](#static-build) for what it omits.

## Installation

The live server requires [conda](https://docs.conda.io) (for example through miniforge). The commands below were used on macOS 15; nothing in them is specific to macOS except the Homebrew line.

```bash
brew install --cask miniforge
conda create -n vrpymol -c conda-forge pymol-open-source python=3.11
conda activate vrpymol
pip install vtk numpy flask cryptography pytest pygltflib playwright
playwright install chromium   # only needed to run the test suite
```

Versions in the development environment: Python 3.11.18, pymol-open-source 3.1.0, VTK 9.7.2, Flask 3.1.3, NumPy 2.4.6, Playwright 1.65.0, pytest 9.2.0, three.js r180 (vendored in `webxr/static/vendor/`).

## Running the server

```bash
conda activate vrpymol
python -m webxr.server
```

Expected output (the address is that of the machine running the server):

```
 * WebXR needs HTTPS: open https://192.168.1.20:8420 on the headset
 * Serving Flask app 'server'
 * Debug mode: off
WARNING: This is a development server. Do not use it in a production deployment. Use a production WSGI server instead.
 * Running on all addresses (0.0.0.0)
 * Running on https://127.0.0.1:8420
 * Running on https://192.168.1.20:8420
Press CTRL+C to quit
```

Open the printed address in the headset's browser, with the headset on the same network as the server, accept the certificate warning, and choose "Enter VR". The same address works in a desktop browser. WebXR is only available to pages served over HTTPS, so the server generates a self-signed certificate on first run (`webxr/dev_cert.py`); the warning is expected. Set the `PORT` environment variable to use a port other than 8420.

## Using the viewer

Every menu action applies to the **selected residues**, or to the **whole molecule when nothing is selected**. The first line of the menu states which of the two is in effect.

### Controllers

| Input | Action |
| --- | --- |
| Trigger, on the molecule | Use the active pointer tool: select the residue under the ray, or pick an atom for a measurement |
| Trigger, on the menu | Press a button; press a residue letter, or hold and sweep for a range |
| Grip | Grab the molecule: one hand moves and rotates, two hands scale and rotate |
| Thumbstick forward / back | Zoom in / out about the center of the molecule |
| A (right hand) or X (left hand) | Show or hide the menu |
| B (right hand) or Y (left hand) | Undo the last change |

### Menu

The menu is a board that floats below the molecule in VR and is a pop-out panel on desktop ("show menu and sequence").

| Row | Buttons |
| --- | --- |
| top right | undo, redo |
| show | one button per representation, "H atoms", "h-bonds" |
| hide | the same, plus "everything" |
| select and tool (one row) | select: all, invert, none. tool: select, distance, angle, dihedral, clear measurements |
| colour | coloring schemes (element, chain, rainbow, secondary structure, B-factor); nine solid colors; reset |
| opacity | 100%, 75%, 50%, 25% |
| groups | save, rename, delete; one button per saved group |
| sequence | one bar per chain, which folds or unfolds its sequence and carries a "select" button for the whole chain; only the first chain starts unfolded |

On desktop the side panel offers the same controls, and additionally the molecule, additional objects, state (frame), cartoon detail, stick radius, sphere scale, and background color. Dragging orbits; a click without dragging uses the pointer tool. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo.

### Example: the hydrogen bonds of a base pair

1. Choose the molecule `1bna` (a B-DNA dodecamer).
2. Unfold chain B in the menu. Select G4 in chain A and C21 in chain B, by pointing at them or pressing their letters.
3. Press show → ball+stick, then hide → cartoon.
4. Press show → H atoms, then show → h-bonds.

The pair is drawn with its polar hydrogens and three dashed hydrogen bonds: N1–H···N3 (1.75 Å), N2–H···O2 (1.82 Å) and N4–H···O6 (1.62 Å), each measured from the hydrogen to the acceptor. An A–T pair treated the same way shows two.

## Features

**Selection**
- By pointing at the molecule, or from the sequence. The selection is the residue, as in PyMOL's default selection mode.
- Selected atoms are marked in pink, and the selection is written as a PyMOL expression, for example `chain A and resi 6-18`.
- Named groups store a selection for later recall, as PyMOL's named selections do. Names are limited to letters, digits and underscores, and 16 characters. In VR, "rename" focuses a text field so that the Meta Quest Browser opens its system keyboard (Quest Browser 26.1 or later).

**Representations**
- Cartoon, sticks, ball and stick, spheres, lines, ribbon, nonbonded, nb_spheres, surface, mesh and dots.
- Representations combine, and each can be shown for some residues only: sticks for a binding site and cartoon elsewhere, for instance.
- Ball and stick is PyMOL's sticks and spheres exported together with a stick radius of 0.11 Å and spheres at 0.25 times the van der Waals radius. These sizes follow the [DNA_Builder](https://github.com/yangha7/DNA_Builder) viewer.

**Color and opacity**
- Five schemes, each a PyMOL command: element (PyMOL's default atom colors), chain (`util.cbc`), rainbow from N to C terminus (`util.chainbow`), secondary structure (`util.cbss`), and B-factor (`cmd.spectrum`).
- A scheme can be applied to selected residues while the rest keep another.
- A solid color can be painted over the scheme and removed again.
- Residues can be drawn at 100%, 75%, 50% or 25% opacity.

**Hydrogens and hydrogen bonds**
- The bundled structures contain no hydrogens. When a structure is loaded, PyMOL adds the polar ones, those bonded to nitrogen or oxygen, with `h_add`. Waters are excluded.
- "H atoms" shows these hydrogens on sticks, ball and stick, lines or spheres.
- Hydrogen bonds are the result of PyMOL's "find polar contacts" (`cmd.distance` with `mode=2`), with waters excluded. Each is drawn as a dashed line, from the hydrogen to the acceptor when the donor's hydrogens are shown and between the two heavy atoms otherwise.

**Measurement**
- Distance (two atoms, in Å), angle (three atoms, in degrees) and dihedral (four atoms, in degrees, International Union of Pure and Applied Chemistry sign convention).
- Values agree with PyMOL's `get_distance`, `get_angle` and `get_dihedral` to within 0.002 in the test suite.
- While a measuring tool is active, the atom under the controller's ray is highlighted before it is picked. Only atoms of residues that are drawn can be picked; a residue shown only as cartoon offers its Cα.

**Undo and redo**
- Cover the selection, shown representations, coloring, opacity, hydrogens, hydrogen bonds, groups and measurements.
- One button press, trigger pull or sweep is one step.
- Do not cover the view (grab, zoom) or the choice of molecule; loading another molecule starts a new history.

**Live server only**
- Additional objects in the same scene, arranged side by side.
- States of a multi-state structure, such as the 20 models of the nuclear magnetic resonance (NMR) structure `1le0`.
- Cartoon detail (flat sheets, smooth loops), stick radius, and sphere scale.

## How it works

```
pymol-open-source (headless) → VRML2 (.wrl) → VTK → glTF → three.js (WebXR)
```

PyMOL runs without a window and writes each representation as a Virtual Reality Modeling Language 2 (VRML2) file, which keeps spheres and cylinders as primitives and cartoons and surfaces as meshes. The Visualization Toolkit (VTK) reads that file, batches the primitives, and writes GL Transmission Format (glTF), which three.js loads in the browser.

Each representation, under each coloring scheme, is a separate **layer**. The browser assigns every triangle of a layer to a residue, using the atom table, and draws only the triangles of the residues that are shown in that representation, colored by that scheme. This is what allows representations, schemes, paint and opacity to differ between residues without asking PyMOL for a new export, and therefore in the hosted build.

Computed by PyMOL: the shape and size of every representation, all scheme colors, the positions of added hydrogens, and the hydrogen-bond list.

Computed in the browser: which triangles belong to which residue, per-residue visibility, paint, opacity, smooth-shading normals, selection markers, measurement values and labels, and hydrogen-bond dashes.

## Data and interfaces

**Input.** Structures are Protein Data Bank (PDB) format files in `tests/fixtures/`, named `<id>.pdb`. Coordinates are in Å, and exported geometry is in the same frame as the file.

| Id | Structure | Atom records |
| --- | --- | --- |
| `1crn` | Crambin | 327 |
| `caffeine` | Caffeine | 24 |
| `1mbn` | Myoglobin, with heme | 1260 |
| `1bna` | B-DNA dodecamer | 566 |
| `4hhb` | Human deoxyhemoglobin, four chains, with hemes | 4779 |
| `1lyz` | Hen egg-white lysozyme | 1102 |
| `1gfl` | Green fluorescent protein, two chains | 3950 |
| `1le0` | Tryptophan zipper 1, NMR, 20 models | 4400 |

**Server endpoints.** All return JavaScript Object Notation (JSON) unless noted.

| Endpoint | Returns |
| --- | --- |
| `GET /api/scene?molecule=&export=0&...` | Loads a molecule or updates display settings; returns the loaded objects and settings |
| `GET /api/layer?rep=&color=&h=` | glTF of one representation under one coloring scheme; `h=1` returns only the added hydrogens. Status 404 when PyMOL draws nothing for that representation |
| `GET /api/atoms` | Atom table: `object`, `index`, `name`, `resn`, `resi`, `chain`, `element`, `coord` (`[x, y, z]` in Å, three decimals). Added hydrogens are not included |
| `GET /api/hydrogens` | Added hydrogens, in the same format plus `parent`, the `index` of the bonded N or O |
| `GET /api/hbonds` | Rows `[object_a, index_a, object_b, index_b, hydrogen]`. `a` and `b` are the heavy atoms; where PyMOL reported the bond through a hydrogen, `a` is the donor and `hydrogen` is that hydrogen's `index`, otherwise `hydrogen` is null |
| `GET`, `POST /api/objects`, `DELETE /api/objects/<name>` | List, add or remove additional objects |
| `GET /api/pick`, `GET /api/distance` | Nearest atom to a point, and the distance between two atoms. Retained for other clients; the page no longer calls them |

**Static build files.** `baked/manifest.json` lists the molecules, representations and schemes, and maps `"<molecule>|<rep>|<scheme>"`, with a `|H` suffix for hydrogen layers, to a binary glTF (`.glb`) file with positions quantized to 16-bit integers. `baked/atoms/`, `baked/hydrogens/` and `baked/hbonds/` hold one JSON file per molecule in the formats above.

## Static build

PyMOL cannot run in a browser, so the hosted build is produced ahead of time. `webxr/bake_static.py` exports every bundled molecule in seven representations (cartoon, sticks, ball and stick, spheres, lines, ribbon, surface) under the five coloring schemes, together with the hydrogen layers and the per-molecule tables. The current build is 390 `.glb` files and 640 MB.

```bash
python -m webxr.bake_static     # writes _site/
./webxr/publish_pages.sh        # replaces the gh-pages branch of the origin remote with _site/
```

A bake followed by an upload has taken under 10 min on the development machine. The script replaces the `gh-pages` branch with a single commit each time, because the baked files are large and can be regenerated.

The hosted build omits what needs PyMOL at view time: the nonbonded, nb_spheres, mesh and dots representations, additional objects, NMR states, and the cartoon and size settings.

## Testing

```bash
python -m pytest -q
```

Expected output, with a run time of about 2 min on the development machine:

```
93 passed in 114.69s (0:01:54)
```

The tests use pymol-open-source itself, without mocks, and drive the page in headless Chromium through Playwright. VR input is exercised in two ways: by calling the page's controller handlers directly, and, in `tests/test_static_site.py`, through Meta's Immersive Web Emulation Runtime, which presents an emulated Quest 3 to the page. That test downloads the emulator from esm.sh and therefore needs network access.

## Project layout

- `pymol_bridge/` — wrapper around a headless PyMOL session; VRML2 export.
- `vr_pymol/` — VRML2 parsing, VTK mesh batching, glTF export, `.glb` packing.
- `webxr/server.py` — Flask server and the PyMOL operations behind each endpoint.
- `webxr/static/` — the page (`index.html`, `app.js`) and vendored three.js; no build step.
- `webxr/bake_static.py`, `webxr/publish_pages.sh` — the static build and its publication.
- `tests/` — pytest suite and the PDB fixtures.

## Known limitations

- **Physical headset.** [TK: confirm controller mapping, menu legibility, and the system keyboard on a physical Meta Quest headset.] To date the VR interaction has been verified only in headless Chromium and the Quest 3 emulator, which provides no system keyboard.
- **Cut edges.** Where a cartoon, ribbon or surface is shown for some residues only, its edge follows triangle boundaries and is slightly ragged; PyMOL would draw an end cap.
- **Bonds across a boundary.** Under a scheme that gives both atoms of a bond one color, PyMOL exports the bond as a single cylinder, which appears half drawn where only one of its two residues is shown.
- **Rotatable hydrogens.** PyMOL places the hydrogens of hydroxyl groups (serine, threonine, tyrosine) in a generic orientation, not toward a hydrogen-bond partner. Backbone and nucleobase N–H hydrogens are determined by geometry and are not affected.
- **Waters.** They receive no hydrogens and are excluded from the hydrogen-bond list.
- **Hydrogen-bond counts.** They are PyMOL's polar contacts and include weak ones: some G–C pairs show a fourth contact, and the longest hydrogen-to-acceptor distance in crambin is 2.78 Å.
- **Opacity.** See-through triangles are not depth sorted, so overlapping see-through surfaces can look uneven from some directions.
- **Sphere outlines.** Atoms are exported as triangle meshes. They are shaded smooth, but the outline of a sphere is a polygon and can be seen as such at close range.
- **Labels.** PyMOL's atom and residue labels are not written by its VRML2 export and are not available.
- **Persistence.** The selection, groups and all display state are held in the page and are lost when it is reloaded.
- **Sequence length.** The menu does not scroll in VR; long chains are drawn with smaller letters, which are harder to hit with a controller ray.
- **Download size.** Layers are fetched when first shown. The sphere and ball-and-stick layers of the two largest structures (`4hhb`, `1gfl`) are 8–12 MB each.
- **Platform.** The project targets WebXR browsers. It does not produce a standalone headset application.
