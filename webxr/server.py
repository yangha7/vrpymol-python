"""Local server: real PyMOL scene -> glTF -> WebXR page.

Runs on any machine that can run the `vrpymol` conda env (this Mac included);
the headset just needs a browser and Wi-Fi to whatever host this binds to --
no SteamVR, no OpenXR desktop runtime, no PC tether.
"""

import os
import threading

from flask import Flask, Response, jsonify, request, send_from_directory
from pymol import util

from pymol_bridge.mesh_export import export_wrl
from pymol_bridge.session import PymolSession
from vr_pymol.glb_pack import has_geometry
from vr_pymol.gltf_export import export_gltf
from vr_pymol.mesh_loader import load_actors
from webxr.dev_cert import ensure_dev_cert

HERE = os.path.dirname(__file__)
STATIC_DIR = os.path.join(HERE, "static")
SCENE_DIR = os.path.join(HERE, "_scene")
FIXTURES_DIR = os.path.join(os.path.dirname(HERE), "tests", "fixtures")
GLTF_PATH = os.path.join(SCENE_DIR, "scene.gltf")

# Representations the frontend can ask for one at a time (`/api/layer`).
LAYER_REPS = (
    "cartoon",
    "sticks",
    "ball_and_stick",
    "spheres",
    "lines",
    "ribbon",
    "nonbonded",
    "nb_spheres",
    "surface",
    "mesh",
    "dots",
)

# Ball and stick is not a PyMOL representation of its own: it is sticks and
# spheres shown together, thin and small. Sizes match the DNA_Builder
# viewer: stick radius in Angstroms, spheres as a fraction of each atom's
# van der Waals radius.
BALL_AND_STICK = "ball_and_stick"
BALL_AND_STICK_SIZES = {"stick_radius": 0.11, "sphere_scale": 0.25}
# PyMOL's own defaults, used when no size has been asked for -- set
# explicitly on every export so one export's sizes never carry into the next.
PYMOL_DEFAULT_SIZES = {"stick_radius": 0.25, "sphere_scale": 1.0}

# Crystal structures carry no hydrogens, so PyMOL adds the polar ones (on N
# and O -- the ones hydrogen bonds are made with) to every object as it is
# loaded. They live in the session under this named selection and are left
# out of everything -- the atom table, picking, the normal layers -- except
# the "hydrogens only" layers the frontend overlays on request.
ADDED_H = "added_h"
# Representations a hydrogens-only layer exists for: the ones that draw atoms.
HYDROGEN_REPS = ("sticks", BALL_AND_STICK, "spheres", "lines")

DEFAULT_MOLECULE = "1crn"
DEFAULT_REP = "cartoon"
DEFAULT_COLOR = "default"

# Real PyMOL coloring commands, checked directly against the installed
# pymol-open-source (`pymol/util.py`) rather than guessed: `util.cbc` (color
# by chain), `util.cbss` (by secondary structure: red helix/yellow sheet/
# green loop), `util.chainbow` (real N-to-C rainbow spectrum), and
# `cmd.spectrum("b", ...)` (by temperature factor) are all real, existing
# commands. "default" puts back the colors PyMOL itself gave each atom when
# the object was loaded (recorded then, see `_capture_default_colors`):
# without that, "default" after any other scheme left the other scheme's
# colors in place.
def _restore_default_colors(session):
    for name, colors in _default_colors.items():
        remaining = iter(colors)
        session.cmd.alter(name, "color = next(remaining)", space={"remaining": remaining, "next": next})
    session.cmd.recolor()


def _capture_default_colors(session, name):
    """Record `name`'s per-atom PyMOL color indices, in atom order."""
    colors = []
    session.cmd.iterate(name, "colors.append(color)", space={"colors": colors})
    _default_colors[name] = colors


_default_colors = {}  # object name -> per-atom color indices as loaded

_COLOR_SCHEMES = {
    "default": _restore_default_colors,
    "chain": lambda session: util.cbc("all", _self=session.cmd),
    "rainbow": lambda session: util.chainbow("all", _self=session.cmd),
    "secondary-structure": lambda session: util.cbss("all", _self=session.cmd),
    "b-factor": lambda session: session.cmd.spectrum("b", "blue_white_red", "all"),
}

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()
_session = None

# Multi-object registry: object name -> molecule id. "mol" is always the
# single "primary" object driven by the original `molecule`/`rep`/... params
# (full-scene-reset semantics, unchanged from before multi-object support);
# any other keys are "additional" objects added via `/api/objects` that layer
# alongside the primary one without disturbing it. Display settings (rep,
# color, hydrogens, ...) are global -- applied uniformly across every loaded
# object, real PyMOL's own `hide`/`show` default selection ("all") already
# does this for free, no per-object plumbing needed.
_objects = {}
_display_settings = {
    "rep": DEFAULT_REP,
    "hydrogens": True,
    "waters": True,
    "color": DEFAULT_COLOR,
    "stick_radius": None,
    "sphere_scale": None,
    "cartoon_flat_sheets": True,
    "cartoon_smooth_loops": False,
    "frame": 1,
    "hydrogens_only": False,
}


def _get_session():
    global _session
    if _session is None:
        _session = PymolSession()
    return _session


def _added_h(session):
    """The name of the added-hydrogens selection, created empty if this
    session has none yet."""
    if ADDED_H not in session.cmd.get_names("selections"):
        session.cmd.select(ADDED_H, "none", enable=0)
    return ADDED_H


def _add_polar_hydrogens(session, name):
    """Have PyMOL add hydrogens to object `name`'s N and O atoms (`h_add`,
    placed from bonding geometry) and record them in `ADDED_H`.

    Waters are skipped: PyMOL can only guess which way a water's hydrogens
    point. The added atoms are flagged "ignore" so they don't change the
    molecular surface computed for the heavy atoms.
    """
    added = _added_h(session)
    session.cmd.select("_before_h_add", name, enable=0)
    session.cmd.h_add(f"{name} and (elem N+O) and not solvent")
    session.cmd.select(added, f"({added}) or ({name} and not _before_h_add)", enable=0)
    session.cmd.delete("_before_h_add")
    session.cmd.flag("ignore", added, "set")


def _export_current_scene(session, settings):
    """Apply `settings` (see `_display_settings`) to every currently loaded
    object and export. Caller must already hold `_lock`.

    `frame` is a real PyMOL movie frame (`cmd.frame`), global across the
    whole session same as real PyMOL -- not per-object -- verified directly
    that it changes what a multi-state object (e.g. an NMR ensemble, many
    states/frames per one object) actually exports via `cmd.save`.
    """
    if settings["rep"] == BALL_AND_STICK:
        reps = ["sticks", "spheres"]
        sizes = BALL_AND_STICK_SIZES  # fixed: the size sliders are for plain sticks/spheres
    else:
        reps = settings["rep"].split("+")
        sizes = {
            name: default if settings[name] is None else settings[name]
            for name, default in PYMOL_DEFAULT_SIZES.items()
        }
    for name, value in sizes.items():
        session.cmd.set(name, value)
    session.cmd.set("cartoon_flat_sheets", int(settings["cartoon_flat_sheets"]))
    session.cmd.set("cartoon_smooth_loops", int(settings["cartoon_smooth_loops"]))
    session.cmd.hide("everything")
    added = _added_h(session)
    if settings.get("hydrogens_only"):
        # Just the added hydrogens, in this representation: each hydrogen,
        # and for sticks and lines the atom it is bonded to as well, since
        # PyMOL draws a bond only when both of its ends are shown.
        with_parents = f"{added} or (neighbor {added})"
        for one_rep in reps:
            session.cmd.show(one_rep, added if one_rep == "spheres" else with_parents)
    else:
        for one_rep in reps:
            session.cmd.show(one_rep)
        session.cmd.hide("everything", added)
    _COLOR_SCHEMES[settings["color"]](session)
    if not settings["hydrogens"]:
        session.cmd.hide("everything", "hydro")
    if not settings["waters"]:
        session.cmd.hide("everything", "solvent")

    max_states = session.cmd.count_states("all") if _objects else 1
    frame = max(1, min(settings.get("frame", 1), max_states))
    session.cmd.frame(frame)

    os.makedirs(SCENE_DIR, exist_ok=True)
    wrl_path = os.path.join(SCENE_DIR, "scene.wrl")
    export_wrl(session, wrl_path)
    actors = load_actors(wrl_path)
    export_gltf(actors, GLTF_PATH)
    return max_states


def rebuild_scene(
    molecule,
    rep,
    hydrogens=True,
    waters=True,
    color=DEFAULT_COLOR,
    stick_radius=None,
    sphere_scale=None,
    cartoon_flat_sheets=True,
    cartoon_smooth_loops=False,
    frame=1,
    export=True,
    hydrogens_only=False,
):
    """Replace the *entire* scene with just `molecule` (single-object mode,
    the original behavior, object always named "mol") and show `rep` (one or
    more reps, "+"-joined), export glTF.

    `hydrogens`/`waters` toggle real PyMOL selections (`hydro`, `solvent`)
    off after showing the requested reps, same toggles the Unity project's
    hotbar exposed. `color` picks a real PyMOL coloring scheme (see
    `_COLOR_SCHEMES`); `stick_radius`/`sphere_scale` are real PyMOL settings
    (`cmd.set`), left untouched (PyMOL's own current default) when None.
    `cartoon_flat_sheets`/`cartoon_smooth_loops` are real PyMOL cartoon
    settings, checked to actually change the exported cartoon mesh before
    wiring up (transparency, by contrast, was checked and found to never
    survive PyMOL's own VRML2 export at all, so it isn't exposed here).
    Defaults here match PyMOL's own real defaults (checked via `cmd.get`,
    not assumed): `cartoon_flat_sheets` is on, `cartoon_smooth_loops` is
    off. `frame` (real PyMOL movie frame) only matters for multi-state
    molecules (e.g. NMR ensembles); harmless default of 1 for every
    single-state fixture.

    `hydrogens_only` exports just the added polar hydrogens in `rep` (one
    of `HYDROGEN_REPS`), the overlay the frontend shows for "H atoms".

    `export=False` loads the molecule and records the settings without
    exporting anything, for callers that fetch representations one at a time
    through `/api/layer` (every export applies the recorded settings itself).

    To add/remove more objects *alongside* this one without resetting the
    whole scene, use `add_object_to_scene`/`remove_object_from_scene`.
    """
    pdb_path = os.path.join(FIXTURES_DIR, f"{molecule}.pdb")
    if not os.path.isfile(pdb_path):
        raise FileNotFoundError(molecule)
    if color not in _COLOR_SCHEMES:
        raise ValueError(f"unknown color scheme {color!r}")

    settings = dict(
        rep=rep,
        hydrogens=hydrogens,
        waters=waters,
        color=color,
        stick_radius=stick_radius,
        sphere_scale=sphere_scale,
        cartoon_flat_sheets=cartoon_flat_sheets,
        cartoon_smooth_loops=cartoon_smooth_loops,
        frame=frame,
        hydrogens_only=hydrogens_only,
    )
    with _lock:
        session = _get_session()
        session.load(pdb_path)
        _objects.clear()
        _objects["mol"] = molecule
        _add_polar_hydrogens(session, "mol")
        _default_colors.clear()
        _capture_default_colors(session, "mol")
        _display_settings.update(settings)
        if export:
            _export_current_scene(session, _display_settings)


def add_object_to_scene(molecule):
    """Load `molecule` as an additional object, keeping the primary "mol"
    object (and any other additional objects) as they are. Returns the
    (possibly de-duplicated) object name actually used and the new
    `max_states` across the whole scene."""
    pdb_path = os.path.join(FIXTURES_DIR, f"{molecule}.pdb")
    if not os.path.isfile(pdb_path):
        raise FileNotFoundError(molecule)
    with _lock:
        session = _get_session()
        name = session.add_object(pdb_path, base_name=molecule)
        _objects[name] = molecule
        _add_polar_hydrogens(session, name)
        _capture_default_colors(session, name)
        max_states = _export_current_scene(session, _display_settings)
    return name, max_states


def remove_object_from_scene(name):
    """Remove an additional object (never the primary "mol" one, and never
    the last remaining object -- the viewer always shows at least one
    molecule). Returns the new `max_states`."""
    with _lock:
        if name not in _objects:
            raise KeyError(name)
        if name == "mol":
            raise ValueError("the primary molecule can't be removed this way -- switch it instead")
        if len(_objects) <= 1:
            raise ValueError("at least one object must remain")
        session = _get_session()
        session.remove_object(name)
        del _objects[name]
        _default_colors.pop(name, None)
        max_states = _export_current_scene(session, _display_settings)
    return max_states


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/scene.gltf")
def scene_gltf():
    with open(GLTF_PATH, "rb") as f:
        data = f.read()
    response = Response(data, mimetype="model/gltf+json")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/scene")
def api_scene():
    """Update display settings and/or the primary molecule, then export.

    `molecule` is optional and only triggers a full single-object reset (via
    `rebuild_scene`, wiping any additional objects added through
    `/api/objects`) when it's actually *changing* the primary "mol" object --
    the existing frontend's rep/color/etc. controls always resend the
    currently-selected primary molecule alongside every settings change, and
    without this check every such change would silently nuke any additional
    objects even though the user never touched the molecule dropdown.
    """
    molecule = request.args.get("molecule")
    rep = request.args.get("rep", _display_settings["rep"])
    hydrogens = request.args.get("hydrogens", "1" if _display_settings["hydrogens"] else "0") != "0"
    waters = request.args.get("waters", "1" if _display_settings["waters"] else "0") != "0"
    color = request.args.get("color", _display_settings["color"])
    stick_radius = request.args.get("stick_radius", type=float)
    if stick_radius is None:
        stick_radius = _display_settings["stick_radius"]
    sphere_scale = request.args.get("sphere_scale", type=float)
    if sphere_scale is None:
        sphere_scale = _display_settings["sphere_scale"]
    cartoon_flat_sheets = (
        request.args.get("cartoon_flat_sheets", "1" if _display_settings["cartoon_flat_sheets"] else "0") != "0"
    )
    cartoon_smooth_loops = (
        request.args.get("cartoon_smooth_loops", "1" if _display_settings["cartoon_smooth_loops"] else "0") != "0"
    )
    frame = request.args.get("frame", type=int, default=_display_settings["frame"])
    # export=0: the layered frontend only wants the session updated here and
    # fetches each representation separately from /api/layer.
    export = request.args.get("export", "1") != "0"

    try:
        if molecule is not None and _objects.get("mol") != molecule:
            rebuild_scene(
                molecule,
                rep,
                hydrogens=hydrogens,
                waters=waters,
                color=color,
                stick_radius=stick_radius,
                sphere_scale=sphere_scale,
                cartoon_flat_sheets=cartoon_flat_sheets,
                cartoon_smooth_loops=cartoon_smooth_loops,
                frame=frame,
                export=export,
            )
        else:
            if color not in _COLOR_SCHEMES:
                raise ValueError(f"unknown color scheme {color!r}")
            settings = dict(
                rep=rep,
                hydrogens=hydrogens,
                waters=waters,
                color=color,
                stick_radius=stick_radius,
                sphere_scale=sphere_scale,
                cartoon_flat_sheets=cartoon_flat_sheets,
                cartoon_smooth_loops=cartoon_smooth_loops,
                frame=frame,
            )
            with _lock:
                session = _get_session()
                _display_settings.update(settings)
                if export:
                    _export_current_scene(session, _display_settings)
    except FileNotFoundError:
        return jsonify({"ok": False, "error": f"unknown molecule {molecule!r}"}), 404
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    with _lock:
        session = _get_session()
        max_states = session.cmd.count_states("all") if _objects else 1
        objects = [{"name": n, "molecule": m} for n, m in _objects.items()]
    return jsonify(
        {
            "ok": True,
            "objects": objects,
            "rep": _display_settings["rep"],
            "hydrogens": _display_settings["hydrogens"],
            "waters": _display_settings["waters"],
            "color": _display_settings["color"],
            "stick_radius": _display_settings["stick_radius"],
            "sphere_scale": _display_settings["sphere_scale"],
            "cartoon_flat_sheets": _display_settings["cartoon_flat_sheets"],
            "cartoon_smooth_loops": _display_settings["cartoon_smooth_loops"],
            "frame": _display_settings["frame"],
            "max_states": max_states,
        }
    )


@app.route("/api/layer")
def api_layer():
    """One representation of the current scene, as glTF.

    The frontend draws each representation as its own layer and decides per
    residue which part of it is visible, so it asks for them one at a time,
    under the current display settings. `color` picks the colouring scheme
    for this layer (default: the scene's), since different residues can be
    coloured by different schemes. 404 when PyMOL draws
    nothing for this representation (cartoon of a small molecule, nonbonded
    of a structure with no waters or ions).
    """
    rep = request.args.get("rep")
    if rep not in LAYER_REPS:
        return jsonify({"ok": False, "error": f"unknown representation {rep!r}"}), 400
    color = request.args.get("color", _display_settings["color"])
    if color not in _COLOR_SCHEMES:
        return jsonify({"ok": False, "error": f"unknown color scheme {color!r}"}), 400
    # h=1: only the added polar hydrogens, to overlay on the normal layer
    hydrogens_only = request.args.get("h") == "1"
    if hydrogens_only and rep not in HYDROGEN_REPS:
        return jsonify({"ok": False, "error": f"no hydrogens layer for {rep!r}"}), 400
    with _lock:
        session = _get_session()
        _export_current_scene(
            session,
            {**_display_settings, "rep": rep, "color": color, "hydrogens_only": hydrogens_only},
        )
        if not has_geometry(GLTF_PATH):
            return jsonify({"ok": False, "error": f"nothing to draw as {rep}"}), 404
        with open(GLTF_PATH, "rb") as f:
            data = f.read()
    response = Response(data, mimetype="model/gltf+json")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/objects", methods=["GET"])
def api_objects_list():
    with _lock:
        session = _get_session()
        max_states = session.cmd.count_states("all") if _objects else 1
        objects = [{"name": n, "molecule": m} for n, m in _objects.items()]
    return jsonify({"ok": True, "objects": objects, "max_states": max_states})


@app.route("/api/objects", methods=["POST"])
def api_objects_add():
    data = request.get_json(silent=True) or {}
    molecule = data.get("molecule")
    if not molecule:
        return jsonify({"ok": False, "error": "molecule is required"}), 400
    try:
        name, max_states = add_object_to_scene(molecule)
    except FileNotFoundError:
        return jsonify({"ok": False, "error": f"unknown molecule {molecule!r}"}), 404
    with _lock:
        objects = [{"name": n, "molecule": m} for n, m in _objects.items()]
    return jsonify({"ok": True, "name": name, "objects": objects, "max_states": max_states})


@app.route("/api/objects/<name>", methods=["DELETE"])
def api_objects_remove(name):
    try:
        max_states = remove_object_from_scene(name)
    except KeyError:
        return jsonify({"ok": False, "error": f"no such object {name!r}"}), 404
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    with _lock:
        objects = [{"name": n, "molecule": m} for n, m in _objects.items()]
    return jsonify({"ok": True, "objects": objects, "max_states": max_states})


def atom_table(session: PymolSession, state: int = 1) -> list[dict]:
    """Every atom of every loaded object, as the records `/api/pick` returns.

    `coord` is in Angstroms in PyMOL's model frame -- the same frame glTF
    export bakes into vertex positions -- rounded to the 3 decimals a PDB
    file carries. `state` is the 1-based PyMOL state to read coordinates
    from, clamped per object (a single-state object next to an NMR ensemble
    stays on its only state, as it does in the exported scene).

    The polar hydrogens PyMOL added on load are not part of it; see
    `hydrogen_table`.
    """
    atoms = []
    heavy = f"not {_added_h(session)}"
    for object_name in session.cmd.get_object_list():
        object_state = max(1, min(state, session.cmd.count_states(object_name)))
        for atom in session.cmd.get_model(f"{object_name} and {heavy}", state=object_state).atom:
            atoms.append(
                {
                    "object": object_name,
                    "index": atom.index,
                    "name": atom.name,
                    "resn": atom.resn,
                    "resi": atom.resi,
                    "chain": atom.chain,
                    "element": atom.symbol,
                    "coord": [round(c, 3) for c in atom.coord],
                }
            )
    return atoms


def hbond_pairs(session: PymolSession, state: int = 1) -> list[list]:
    """Hydrogen bonds, as PyMOL's own "find polar contacts" finds them.

    That is `cmd.distance(..., mode=2)`, the command behind the GUI's
    Action > find > polar contacts. With the polar hydrogens PyMOL added on
    load it reports most bonds as hydrogen...acceptor. (`cmd.find_pairs` in
    hydrogen-bond mode looked equivalent but is not: on a G-C base pair it
    returns N1-O2 and O6-N3 and misses the real N2-H...O2 and N4-H...O6.)
    Waters are left out: on a hydrated structure they add hundreds of
    contacts that bury the ones inside the molecule.

    Returns `[object_a, index_a, object_b, index_b, hydrogen]` rows, each
    bond once. `a` and `b` are the two heavy atoms (N or O), by the atom
    table's `index`. Where PyMOL reported the bond from a hydrogen, `a` is
    the donor that hydrogen is bonded to and `hydrogen` is the hydrogen's
    `index` (see `hydrogen_table`); otherwise `hydrogen` is None.
    """
    cmd = session.cmd
    polar = "not solvent"
    cmd.delete("_polar_contacts")
    cmd.distance("_polar_contacts", polar, polar, mode=2, state=state)

    # A distance object holds only coordinates, two points per contact, so
    # each end is matched back to the atom at that position.
    atom_at = {}
    parent = {}
    added = {(a.model, a.index) for a in cmd.get_model(_added_h(session)).atom}
    for object_name in cmd.get_object_list():
        object_state = max(1, min(state, cmd.count_states(object_name)))
        model = cmd.get_model(object_name, state=object_state)
        for atom in model.atom:
            atom_at[tuple(round(c, 3) for c in atom.coord)] = (object_name, atom.index)
        for bond in model.bond:
            a, b = (model.atom[i] for i in bond.index)
            if (object_name, a.index) in added:
                parent[(object_name, a.index)] = (object_name, b.index)
            elif (object_name, b.index) in added:
                parent[(object_name, b.index)] = (object_name, a.index)

    session_data = cmd.get_session("_polar_contacts", 1, 1, 0, 0)
    cmd.delete("_polar_contacts")
    coords = []
    for entry in session_data.get("names", []):
        if entry and entry[0] == "_polar_contacts":
            for dist_set in entry[5][2]:  # one per state
                if dist_set:
                    coords.extend(dist_set[1] or [])

    rows = set()
    for k in range(0, len(coords) - 5, 6):
        ends = [atom_at.get(tuple(round(c, 3) for c in coords[k + o : k + o + 3])) for o in (0, 3)]
        if None in ends:
            continue
        hydrogens = [end for end in ends if end in added]
        if len(hydrogens) == 2:
            continue
        if hydrogens:
            hydrogen = hydrogens[0]
            donor = parent.get(hydrogen)
            acceptor = ends[1] if ends[0] == hydrogen else ends[0]
            if donor is None:
                continue
            rows.add((donor[0], donor[1], acceptor[0], acceptor[1], hydrogen[1]))
        else:
            first, second = sorted(ends)
            rows.add((first[0], first[1], second[0], second[1], None))
    return [list(row) for row in sorted(rows, key=lambda r: (r[0], r[1], r[2], r[3], r[4] or 0))]


@app.route("/api/hbonds")
def api_hbonds():
    with _lock:
        session = _get_session()
        max_states = session.cmd.count_states("all") if _objects else 1
        state = max(1, min(_display_settings["frame"], max_states))
        pairs = hbond_pairs(session, state)
    return jsonify({"ok": True, "pairs": pairs})


def hydrogen_table(session: PymolSession, state: int = 1) -> list[dict]:
    """The polar hydrogens PyMOL added on load, in the atom table's format
    plus `parent`: the `index` of the N or O each is bonded to (same object).
    `coord` in Angstroms, model frame.
    """
    hydrogens = []
    added = _added_h(session)
    for object_name in session.cmd.get_object_list():
        object_state = max(1, min(state, session.cmd.count_states(object_name)))
        added_indices = {a.index for a in session.cmd.get_model(f"{object_name} and {added}").atom}
        if not added_indices:
            continue
        model = session.cmd.get_model(object_name, state=object_state)
        parent = {}
        for bond in model.bond:
            a, b = (model.atom[i] for i in bond.index)
            if a.index in added_indices:
                parent[a.index] = b.index
            elif b.index in added_indices:
                parent[b.index] = a.index
        for atom in model.atom:
            if atom.index not in added_indices:
                continue
            hydrogens.append(
                {
                    "object": object_name,
                    "index": atom.index,
                    "name": atom.name,
                    "resn": atom.resn,
                    "resi": atom.resi,
                    "chain": atom.chain,
                    "element": atom.symbol,
                    "coord": [round(c, 3) for c in atom.coord],
                    "parent": parent.get(atom.index),
                }
            )
    return hydrogens


@app.route("/api/hydrogens")
def api_hydrogens():
    with _lock:
        session = _get_session()
        hydrogens = hydrogen_table(session, _display_settings["frame"])
    return jsonify({"ok": True, "hydrogens": hydrogens})


@app.route("/api/atoms")
def api_atoms():
    """The atom table for the scene as currently exported, so the frontend
    can build the sequence and select residues without a request per pick."""
    with _lock:
        session = _get_session()
        atoms = atom_table(session, _display_settings["frame"])
        objects = [{"name": n, "molecule": m} for n, m in _objects.items()]
    return jsonify({"ok": True, "objects": objects, "atoms": atoms})


@app.route("/api/pick")
def api_pick():
    """Nearest real atom to a 3D point, for click-to-select/measure.

    Takes a point in the *molecule's own local coordinate space* (i.e. real
    PyMOL/PDB Angstrom coordinates, unchanged by whatever fit/scale/rotation
    the frontend currently has the model under -- the frontend inverts its
    own display transform via `object3D.worldToLocal()` before calling this,
    since glTF export bakes real absolute coordinates into vertex positions
    with no extra node transforms in between).

    Deliberately does NOT thread a custom per-vertex "atom ID" through the
    batched glyph geometry/glTF export to support picking -- checked earlier
    that `vtkGLTFExporter` already silently drops things it doesn't
    understand (see mesh_loader.py's vtkGlyph3DMapper finding), so a custom
    attribute surviving that export was a real risk not worth taking when
    "ask PyMOL for the nearest real atom" does the same job with zero
    changes to the rendering pipeline.
    """
    x = request.args.get("x", type=float)
    y = request.args.get("y", type=float)
    z = request.args.get("z", type=float)
    if x is None or y is None or z is None:
        return jsonify({"ok": False, "error": "x, y, z are required"}), 400

    with _lock:
        session = _get_session()
        # `index` is only unique *within* one object in real PyMOL (two
        # different objects can both have an atom at index 1) -- with
        # multiple objects loaded, disambiguate by pairing each atom with
        # its own object name (`cmd.get_object_list` + one `get_model` call
        # per object), same as real PyMOL selections do (`object and index N`).
        best = None
        best_object = None
        best_dist = None
        for object_name in session.cmd.get_object_list():
            for atom in session.cmd.get_model(f"{object_name} and not {_added_h(session)}").atom:
                dist = (
                    (atom.coord[0] - x) ** 2 + (atom.coord[1] - y) ** 2 + (atom.coord[2] - z) ** 2
                )
                if best_dist is None or dist < best_dist:
                    best, best_object, best_dist = atom, object_name, dist
        if best is None:
            return jsonify({"ok": False, "error": "no atoms loaded"}), 404

    return jsonify(
        {
            "ok": True,
            "object": best_object,
            "index": best.index,
            "name": best.name,
            "resn": best.resn,
            "resi": best.resi,
            "chain": best.chain,
            "element": best.symbol,
            "coord": list(best.coord),
        }
    )


@app.route("/api/distance")
def api_distance():
    """Real PyMOL distance between two atoms, by their `/api/pick` index.

    `object1`/`object2` (from `/api/pick`'s own `object` field) default to
    "mol" for backward compatibility with single-object callers, but are
    required for a correct result once more than one object is loaded --
    `index` alone is only unique within one object.
    """
    atom1 = request.args.get("atom1", type=int)
    atom2 = request.args.get("atom2", type=int)
    object1 = request.args.get("object1", "mol")
    object2 = request.args.get("object2", "mol")
    if atom1 is None or atom2 is None:
        return jsonify({"ok": False, "error": "atom1, atom2 are required"}), 400

    with _lock:
        session = _get_session()
        distance = session.cmd.get_distance(
            f"{object1} and index {atom1}", f"{object2} and index {atom2}"
        )

    return jsonify({"ok": True, "distance": distance})


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


def create_app():
    rebuild_scene(DEFAULT_MOLECULE, DEFAULT_REP)
    return app


if __name__ == "__main__":
    create_app()
    port = int(os.environ.get("PORT", "8420"))
    # HTTPS (even self-signed) is required here, not optional: WebXR only
    # exposes `navigator.xr` in a "secure context", and a headset opening
    # this over the LAN by IP is neither `localhost` nor real HTTPS unless
    # we terminate TLS ourselves -- see dev_cert.py for the why/how.
    cert_path, key_path, ip = ensure_dev_cert()
    print(f" * WebXR needs HTTPS: open https://{ip}:{port} on the headset")
    # threaded=False: on macOS, VTK's render-window creation touches Cocoa
    # APIs that are only safe to call from the process's main thread. A
    # threaded dev server would handle /api/scene requests (which render)
    # on a worker thread and hard-crash the whole process (not a catchable
    # Python exception -- an uncaught ObjC exception aborts the interpreter).
    app.run(host="0.0.0.0", port=port, threaded=False, ssl_context=(cert_path, key_path))
