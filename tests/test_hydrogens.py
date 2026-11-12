"""Polar hydrogens: added by PyMOL on load, shown as overlay layers.

The structures in the viewer have no hydrogens (X-ray structures don't), so
PyMOL's `h_add` places the ones on N and O. They are kept out of the atom
table and the normal layers, and drawn only by "hydrogens only" layers that
the page overlays for the residues asked for.
"""

import math
import os

import pytest
from playwright.sync_api import sync_playwright

from tests.live_server import live_server  # noqa: F401
from tests.test_style_and_groups import _open, _select_residue
from vr_pymol.wrl_parser import parse_wrl
from webxr import server

D = "window.vrPymolDebug"
WHITE = (0.9, 0.9, 0.9)  # PyMOL's hydrogen colour


@pytest.fixture
def client():
    return server.create_app().test_client()


def _sticks(client, query):
    assert client.get(f"/api/layer?rep=sticks&{query}").status_code == 200
    _, cylinders, _ = parse_wrl(os.path.join(server.SCENE_DIR, "scene.wrl"))
    return [tuple(round(c, 2) for c in cyl["color"]) for cyl in cylinders]


def test_hydrogens_are_added_by_pymol_and_kept_out_of_everything_else(client):
    client.get("/api/scene?molecule=1crn&export=0")
    atoms = client.get("/api/atoms").get_json()["atoms"]
    hydrogens = client.get("/api/hydrogens").get_json()["hydrogens"]

    # the atom table is still the 327 atoms of the file, none of them H
    assert len(atoms) == 327 and all(a["element"] != "H" for a in atoms)
    # one per backbone N-H (45 non-proline, non-N-terminal residues...) plus
    # side chains and termini: PyMOL places 68 on crambin's N and O atoms
    assert len(hydrogens) == 68 and all(h["element"] == "H" for h in hydrogens)
    by_index = {a["index"]: a for a in atoms}
    for h in hydrogens:
        parent = by_index[h["parent"]]
        assert parent["element"] in "NO"
        assert (parent["resi"], parent["chain"]) == (h["resi"], h["chain"])
        # N-H 1.01 A, O-H 0.96 A
        assert 0.9 < math.dist(h["coord"], parent["coord"]) < 1.1

    # the normal sticks layer has no hydrogens in it...
    assert WHITE not in _sticks(client, "color=default")
    # ...and the hydrogens-only layer is exactly the 68 N-H / O-H bonds,
    # each drawn as a white half and a half in its parent's colour
    overlay = _sticks(client, "color=default&h=1")
    assert len(overlay) == 2 * 68 and overlay.count(WHITE) == 68
    # no hydrogens layer for representations that don't draw atoms
    assert client.get("/api/layer?rep=cartoon&h=1").status_code == 400


def test_show_h_atoms_overlays_them_and_hbonds_then_start_at_the_hydrogen(live_server):
    with sync_playwright() as p:
        browser, page, errors = _open(p, live_server)
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")

        # with only cartoon shown there is nothing to hang hydrogens on
        page.check("#show-hydrogen-atoms")
        assert "show one of those" in page.inner_text("#hud")
        assert page.evaluate(f"() => {D}.layerState('sticks', true)") == "unloaded"
        page.click("#undo")
        assert page.evaluate(f"() => {D}.hydrogens.shownFor") == 0

        # sticks for everything, hydrogens for ARG 10 only
        page.evaluate(f"() => {D}.showRep('sticks')")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        heavy = page.evaluate(f"() => {D}.layerTriangles('sticks')")
        _select_residue(page, atoms, "10")
        page.evaluate(f"() => {D}.showHydrogens()")
        page.wait_for_function(f"() => {D}.layerState('sticks', true) === 'ready'", timeout=10000)
        overlay = page.evaluate(f"() => {D}.layerTriangles('sticks', true)")
        assert 0 < overlay["visible"] < overlay["total"]  # one residue's worth
        assert page.evaluate(f"() => {D}.layerTriangles('sticks')") == heavy  # the atoms layer is untouched
        assert page.evaluate(f"() => {D}.hydrogens") == {"shownFor": 1, "loaded": 68}

        # for everything: the whole overlay
        page.evaluate(f"() => {D}.clearSelection()")
        page.evaluate(f"() => {D}.showHydrogens()")
        overlay = page.evaluate(f"() => {D}.layerTriangles('sticks', true)")
        assert overlay["visible"] == overlay["total"] > 0

        # H-bond dashes run hydrogen-to-acceptor (about 2 A) where a
        # hydrogen is shown, instead of between the heavy atoms (about 3 A)
        page.evaluate(f"() => {D}.hideHydrogens()")
        page.evaluate(f"() => {D}.showHbonds()")
        heavy_lengths = page.evaluate(f"() => {D}.hbonds.lengths")
        assert len(heavy_lengths) == 38 and min(heavy_lengths) > 2.5
        page.evaluate(f"() => {D}.showHydrogens()")
        page.wait_for_function(
            f"() => {D}.hbonds.lengths.length === 38 && Math.min(...{D}.hbonds.lengths) < 2.0", timeout=5000
        )
        with_h = page.evaluate(f"() => {D}.hbonds.lengths")
        # every one of them now starts at its hydrogen: about 1 A (the N-H
        # or O-H bond) shorter than between the heavy atoms; PyMOL's longest
        # contact in crambin is 2.78 A hydrogen to acceptor
        assert all(1.5 < length < 2.9 for length in with_h), sorted(with_h)
        assert sum(with_h) / len(with_h) < sum(heavy_lengths) / len(heavy_lengths) - 0.8

        # a shown hydrogen can be picked for a measurement
        page.select_option("#tool-mode", "distance")
        hydrogens = page.evaluate("async () => (await (await fetch('/api/hydrogens')).json()).hydrogens")
        h35 = next(h for h in hydrogens if h["resi"] == "35")
        world = page.evaluate(
            f"""() => {D}.model.localToWorld(
                new window.__three_for_tests__.Vector3(...{h35["coord"]})).toArray()"""
        )
        # aim from outside the molecule, along the N->H direction, so the
        # hydrogen is the first atom on the ray
        n35 = next(a for a in atoms if a["index"] == h35["parent"])
        page.evaluate(
            f"""() => {{
                const three = window.__three_for_tests__;
                const d = {D};
                const h = new three.Vector3(...{world});
                const n = d.model.localToWorld(new three.Vector3(...{n35["coord"]}));
                const c = d.controllers[0];
                c.position.copy(h).addScaledVector(h.clone().sub(n).normalize(), 0.004);
                c.updateMatrix(); c.updateMatrixWorld(true);
                c.lookAt(c.position.clone().multiplyScalar(2).sub(h));
                c.updateMatrix(); c.updateMatrixWorld(true);
            }}"""
        )
        assert page.evaluate(f"() => {D}.atomUnderController(0)") == "H01 (ILE35/A)"

        # hiding the hydrogens is undoable like everything else
        page.evaluate(f"() => {D}.hideHydrogens()")
        assert page.evaluate(f"() => {D}.layerTriangles('sticks', true)")["visible"] == 0
        page.click("#undo")
        # (the overlay was dropped when nothing needed it, so it is fetched again)
        page.wait_for_function(f"() => {D}.layerState('sticks', true) === 'ready'", timeout=10000)
        overlay = page.evaluate(f"() => {D}.layerTriangles('sticks', true)")
        assert overlay["visible"] == overlay["total"] > 0
        browser.close()
    assert not errors, f"uncaught JS errors: {errors}"
