"""Residue selection: by pointing at the molecule, and from the sequence window.

Server side this is one endpoint (`/api/atoms`); everything else runs in the
page on that atom table. As in test_m7_grab.py, controllers are positioned by
hand and their handlers called through `window.vrPymolDebug`, since headless
Chromium has no XR device; the real-session path (trigger and A button on an
emulated Quest 3) is covered in test_static_site.py.
"""

import pytest
from playwright.sync_api import sync_playwright

from tests.live_server import live_server  # noqa: F401
from tests.test_m7_grab import _move_controller
from webxr.server import create_app

# SEQRES records of tests/fixtures/1crn.pdb (crambin, 46 residues)
CRAMBIN = "TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN"


@pytest.fixture
def client():
    return create_app().test_client()


def test_atoms_endpoint_returns_the_real_atom_table(client):
    client.get("/api/scene?molecule=1crn&rep=cartoon")
    data = client.get("/api/atoms").get_json()
    assert data["ok"]
    assert data["objects"] == [{"name": "mol", "molecule": "1crn"}]
    atoms = data["atoms"]
    assert len(atoms) == 327  # real 1CRN atom count
    first = atoms[0]
    assert (first["name"], first["resn"], first["resi"], first["chain"]) == ("N", "THR", "1", "A")
    # ATOM record 1 of the PDB file: N THR A 1 at 17.047, 14.099, 3.625
    assert first["coord"] == [17.047, 14.099, 3.625]


def _aim_controller_at_cell(page, controller, residue_index):
    """Hold a controller 0.3 m off the 3D sequence board, pointing at one cell."""
    page.evaluate(
        f"""() => {{
            const three = window.__three_for_tests__;
            const cell = window.vrPymolDebug.sequenceCell({residue_index});
            const target = new three.Vector3(...cell.world);
            const c = window.vrPymolDebug.controllers[{controller}];
            c.position.copy(target).addScaledVector(new three.Vector3(...cell.normal), 0.3);
            // lookAt reads the position back from matrixWorld, which three.js
            // leaves stale on controllers (matrixAutoUpdate is off, see
            // test_m7_grab._move_controller) -- refresh it first.
            c.updateMatrix();
            c.updateMatrixWorld(true);
            // lookAt aims +Z at its argument; a controller's ray is -Z
            c.lookAt(c.position.clone().multiplyScalar(2).sub(target));
            c.updateMatrix();
            c.updateMatrixWorld(true);
        }}"""
    )


def _expression(page):
    return page.evaluate("() => window.vrPymolDebug.selectionExpression()")


def test_select_by_pointing_and_by_sequence(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1200, "height": 800}, ignore_https_errors=True
        )
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function("() => window.vrPymolDebug.sequence.length > 0", timeout=10000)
        page.evaluate("async () => { window.__three_for_tests__ = await import('three'); }")

        assert page.evaluate("() => window.vrPymolDebug.sequence") == [CRAMBIN]

        # --- by pointing: a point near an atom toggles that atom's residue ---
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        arg10 = [a for a in atoms if a["resi"] == "10"]
        x, y, z = (c + 0.05 for c in arg10[0]["coord"])
        picked = page.evaluate(f"() => window.vrPymolDebug.selectLocalPoint({x}, {y}, {z})")
        assert picked["resn"] == "ARG" and picked["resi"] == "10"
        assert page.evaluate("() => window.vrPymolDebug.selectedKeys") == ["mol|A|10"]
        # one marker per atom of the residue, not just the atom pointed at
        assert page.evaluate("() => window.vrPymolDebug.selectionMarkerCount") == len(arg10)
        assert _expression(page) == "chain A and resi 10"
        assert page.inner_text("#selection-hud") == "chain A and resi 10"
        page.evaluate(f"() => window.vrPymolDebug.selectLocalPoint({x}, {y}, {z})")
        assert page.evaluate("() => window.vrPymolDebug.selectedKeys") == []
        assert page.evaluate("() => window.vrPymolDebug.selectionMarkerCount") == 0

        # --- desktop sequence pop-out: real mouse click, then a real sweep ---
        page.click("#toggle-sequence")
        box = page.locator("#sequence-canvas").bounding_box()

        def cell_xy(index):
            cell = page.evaluate(f"() => window.vrPymolDebug.sequenceCell({index})")
            return box["x"] + cell["u"] * box["width"], box["y"] + cell["v"] * box["height"]

        page.mouse.click(*cell_xy(2))
        assert _expression(page) == "chain A and resi 3"
        page.mouse.move(*cell_xy(4))
        page.mouse.down()
        page.mouse.move(*cell_xy(9), steps=3)
        page.mouse.up()
        assert _expression(page) == "chain A and resi 3+5-10"
        # a sweep that starts on a selected residue deselects
        page.mouse.move(*cell_xy(9))
        page.mouse.down()
        page.mouse.move(*cell_xy(7), steps=3)
        page.mouse.up()
        assert _expression(page) == "chain A and resi 3+5-7"

        # --- the selection survives a representation change ---
        page.check("#rep-checkboxes input[value='sticks']")
        page.wait_for_function(
            "() => document.getElementById('hud').textContent.startsWith('loaded')"
            " && window.vrPymolDebug.selectionMarkerCount > 0",
            timeout=10000,
        )
        assert _expression(page) == "chain A and resi 3+5-7"
        assert page.evaluate(
            "() => window.vrPymolDebug.model.getObjectByName('selection') !== undefined"
        ), "markers should be re-attached to the newly loaded model"

        # --- 3D board: trigger on a cell selects it and does not grab ---
        page.evaluate("() => window.vrPymolDebug.clearSelection()")
        page.evaluate("() => window.vrPymolDebug.toggleSequencePanel()")
        assert page.evaluate("() => window.vrPymolDebug.sequencePanel.visible")
        _aim_controller_at_cell(page, 0, 20)
        page.evaluate("() => window.vrPymolDebug.onTriggerStart(0)")
        assert _expression(page) == "chain A and resi 21"
        assert page.evaluate("() => window.vrPymolDebug.grabbers") == []
        # sweep with the trigger held: picked up by the animation loop
        _aim_controller_at_cell(page, 0, 25)
        page.wait_for_timeout(150)
        page.evaluate("() => window.vrPymolDebug.onTriggerEnd(0)")
        assert _expression(page) == "chain A and resi 21-26"
        # trigger released: moving the ray on no longer selects
        _aim_controller_at_cell(page, 0, 30)
        page.wait_for_timeout(150)
        assert _expression(page) == "chain A and resi 21-26"

        # --- trigger on the molecule selects a residue; grip still grabs ---
        page.evaluate("() => window.vrPymolDebug.clearSelection()")
        page.evaluate("() => window.vrPymolDebug.toggleSequencePanel()")
        assert not page.evaluate("() => window.vrPymolDebug.sequencePanel.visible")
        # aim along -Z at a real atom (the box centre can fall in a gap
        # between sticks, where a ray rightly hits nothing)
        ax, ay, az = arg10[0]["coord"]
        cx, cy, cz = page.evaluate(
            f"""() => window.vrPymolDebug.model.localToWorld(
                new window.__three_for_tests__.Vector3({ax}, {ay}, {az})).toArray()"""
        )
        _move_controller(page, 0, cx, cy, cz + 1)
        page.evaluate("() => window.vrPymolDebug.onTriggerStart(0)")
        page.evaluate("() => window.vrPymolDebug.onTriggerEnd(0)")
        assert len(page.evaluate("() => window.vrPymolDebug.selectedKeys")) == 1
        assert page.evaluate("() => window.vrPymolDebug.grabbers") == []
        page.evaluate("() => window.vrPymolDebug.onGrabStart(0)")
        assert page.evaluate("() => window.vrPymolDebug.grabbers") == [0]
        page.evaluate("() => window.vrPymolDebug.onGrabEnd(0)")

        # --- a different molecule drops the selection and its sequence ---
        page.select_option("#molecule-select", "caffeine")
        page.wait_for_function(
            "() => window.vrPymolDebug.sequence.join('') === 'X'", timeout=10000
        )
        assert page.evaluate("() => window.vrPymolDebug.selectedKeys") == []
        assert page.inner_text("#selection-hud") == "nothing selected"

        browser.close()

    assert not page_errors, f"uncaught JS errors: {page_errors}"


def test_exported_geometry_is_in_the_atom_table_frame(client, tmp_path):
    """Markers and picking place atoms by their PyMOL coordinates, so the
    exported geometry has to be in that same frame. PyMOL's VRML2 writer
    works in camera space (coordinates relative to the view's centre of
    rotation, turned by the view rotation), which after a plain `load` is
    the molecule shifted by its own centre: invisible for caffeine, which
    sits at the origin, and ~10 Angstroms off for a real protein.
    """
    import re

    import numpy as np

    from pymol_bridge.mesh_export import export_wrl
    from webxr import server

    client.get("/api/scene?molecule=1crn&rep=spheres")
    session = server._get_session()
    session.cmd.turn("y", 40)  # a rotated view must not leak into the export either
    with open(export_wrl(session, str(tmp_path / "scene.wrl"))) as f:
        centres = np.array(
            re.findall(r"translation\s+(\S+)\s+(\S+)\s+(\S+)\s+children Shape \{\s+geometry Sphere", f.read()),
            dtype=float,
        )
    atoms = np.array([a["coord"] for a in server.atom_table(session)])
    assert len(centres) == len(atoms) == 327
    # the writer's sphere order is not the atom order, so pair each atom
    # with its nearest sphere; (327, 327) distances, in Angstroms
    distances = np.linalg.norm(atoms[:, None, :] - centres[None, :, :], axis=2)
    assert distances.min(axis=1).max() < 2e-3
    assert len(set(distances.argmin(axis=1))) == 327  # one sphere per atom
