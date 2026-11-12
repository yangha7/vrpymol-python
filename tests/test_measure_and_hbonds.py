"""Measuring tools (distance, angle, dihedral) and the H-bond display.

Values are computed in the page from the atom table; they are checked here
against real PyMOL's own `get_distance` / `get_angle` / `get_dihedral` on the
same atoms, using a separate PyMOL session in the test process. H-bond pairs
are PyMOL's (`/api/hbonds`); the page only chooses which to draw.
"""

import os

import pytest
from playwright.sync_api import sync_playwright

from pymol_bridge.session import PymolSession
from tests.live_server import live_server  # noqa: F401
from tests.test_m7_grab import _move_controller
from tests.test_selection import _aim_controller_at_cell
from webxr.server import create_app

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
D = "window.vrPymolDebug"


@pytest.fixture
def client():
    return create_app().test_client()


def test_hbonds_endpoint_returns_pymols_pairs_once_each(client):
    client.get("/api/scene?molecule=1crn&rep=cartoon")
    atoms = {a["index"]: a for a in client.get("/api/atoms").get_json()["atoms"]}
    pairs = client.get("/api/hbonds").get_json()["pairs"]
    # PyMOL's "find polar contacts", through the hydrogens it added
    assert len(pairs) == 38
    ends = [(a, i, b, j) for a, i, b, j, _ in pairs]
    assert len(set(ends)) == 38
    assert not {(b, j, a, i) for a, i, b, j in ends} & set(ends)
    # every bond is reported from a hydrogen, bonded to the donor listed first
    hydrogens = {h["index"]: h for h in client.get("/api/hydrogens").get_json()["hydrogens"]}
    for _, donor, _, _, hydrogen in pairs:
        assert hydrogens[hydrogen]["parent"] == donor
    named = {
        frozenset((f"{atoms[i]['resn']}{atoms[i]['resi']}.{atoms[i]['name']}",
                   f"{atoms[j]['resn']}{atoms[j]['resi']}.{atoms[j]['name']}"))
        for _, i, _, j, _ in pairs
    }
    # the antiparallel sheet's N-H...O=C pair between strands 1-4 and 32-35,
    # and the first turn of the helix starting at residue 7
    assert frozenset(("THR1.N", "ILE35.O")) in named
    assert frozenset(("THR1.O", "ILE35.N")) in named
    assert frozenset(("ILE7.O", "SER11.N")) in named
    for _, i, _, j, _ in pairs:
        assert atoms[i]["element"] in "NO" and atoms[j]["element"] in "NO"


def test_watson_crick_pairs_get_their_textbook_hydrogen_bonds(client):
    """The check `cmd.find_pairs` failed: G-C has three hydrogen bonds
    (N1-H...N3, N2-H...O2, N4-H...O6) and A-T two (N6-H...O4, N3-H...N1)."""
    client.get("/api/scene?molecule=1bna&export=0")
    atoms = {a["index"]: a for a in client.get("/api/atoms").get_json()["atoms"]}
    hydrogens = {h["index"]: h for h in client.get("/api/hydrogens").get_json()["hydrogens"]}
    pairs = client.get("/api/hbonds").get_json()["pairs"]

    def between(residue_a, residue_b):
        found = {}
        for _, i, _, j, h in pairs:
            a, b = atoms[i], atoms[j]
            if {(a["chain"], a["resi"]), (b["chain"], b["resi"])} == {residue_a, residue_b}:
                # donor atom -> acceptor atom, and the H...acceptor distance
                import math

                found[(f"{a['resn']}.{a['name']}", f"{b['resn']}.{b['name']}")] = math.dist(
                    hydrogens[h]["coord"], b["coord"]
                )
        return found

    gc = between(("A", "4"), ("B", "21"))
    assert set(gc) == {("DG.N1", "DC.N3"), ("DG.N2", "DC.O2"), ("DC.N4", "DG.O6")}
    at = between(("A", "6"), ("B", "19"))
    assert set(at) == {("DA.N6", "DT.O4"), ("DT.N3", "DA.N1")}
    # hydrogen to acceptor: the 1.6-2.2 A of a real hydrogen bond
    assert all(1.5 < distance < 2.3 for distance in [*gc.values(), *at.values()])


def _pick(page, atom):
    x, y, z = atom["coord"]
    return page.evaluate(f"() => {D}.pickLocalPoint({x}, {y}, {z})")


def test_distance_angle_dihedral_match_real_pymol(live_server):
    with PymolSession() as pymol:
        pymol.load(os.path.join(FIXTURES, "1crn.pdb"))
        sel = ["mol and resi 1 and name N", "mol and resi 1 and name CA",
               "mol and resi 1 and name C", "mol and resi 2 and name N"]
        expected = {
            "distance": pymol.cmd.get_distance(sel[0], sel[1]),
            "angle": pymol.cmd.get_angle(sel[0], sel[1], sel[2]),
            "dihedral": pymol.cmd.get_dihedral(*sel),  # psi of THR 1
        }
    assert expected["dihedral"] < 0 or expected["dihedral"] > 0  # signed, not just a magnitude

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 900}, ignore_https_errors=True)
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function(f"() => {D}.layerState('cartoon') === 'ready'", timeout=10000)
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        by_name = {(a["resi"], a["name"]): a for a in atoms}
        chain = [by_name[("1", "N")], by_name[("1", "CA")], by_name[("1", "C")], by_name[("2", "N")]]

        for kind, count in (("distance", 2), ("angle", 3), ("dihedral", 4)):
            page.select_option("#tool-mode", kind)
            assert page.evaluate(f"() => {D}.tool") == kind
            for atom in chain[:count]:
                _pick(page, atom)
            measured = page.evaluate(f"() => {D}.measurements")[-1]
            assert measured["kind"] == kind
            assert measured["value"] == pytest.approx(expected[kind], abs=2e-3), kind
            assert page.evaluate(f"() => {D}.pendingAtom") is None
        hud = page.inner_text("#measure-hud")
        assert "N (THR1/A)" in hud and "N (THR2/A)" in hud and hud.endswith("°")
        assert len(page.evaluate(f"() => {D}.measurements")) == 3

        # switching tool mid-measurement drops the half-made one
        _pick(page, chain[0])
        assert page.evaluate(f"() => {D}.pendingAtom") is not None
        page.select_option("#tool-mode", "angle")
        assert page.evaluate(f"() => {D}.pendingAtom") is None

        page.click("#clear-measurements")
        assert page.evaluate(f"() => {D}.measurements") == []
        assert page.evaluate(f"() => {D}.measurementGroup") is None
        browser.close()
    assert not page_errors, f"uncaught JS errors: {page_errors}"


def test_vr_tool_picks_the_atom_under_the_ray_and_hbonds_follow_selection(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 900}, ignore_https_errors=True)
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function(f"() => {D}.layerState('cartoon') === 'ready'", timeout=10000)
        page.evaluate("async () => { window.__three_for_tests__ = await import('three'); }")
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        pairs = page.evaluate("async () => (await (await fetch('/api/hbonds')).json()).pairs")
        by_index = {a["index"]: a for a in atoms}

        # --- the menu's tool row, pressed with the trigger ---
        page.evaluate(f"() => {D}.toggleSequencePanel()")
        page.evaluate(
            f"""() => {{ const b = {D}.menuButton("tool", "distance"); {D}.sequenceCell = () => b; }}"""
        )
        _aim_controller_at_cell(page, 0, 0)
        page.evaluate(f"() => {D}.onTriggerStart(0)")
        page.evaluate(f"() => {D}.onTriggerEnd(0)")
        assert page.evaluate(f"() => {D}.tool") == "distance"
        assert page.input_value("#tool-mode") == "distance"
        page.evaluate(f"() => {D}.toggleSequencePanel()")

        # --- with only cartoon drawn, a ray picks C-alphas, nothing hidden ---
        def aim_at(atom):
            x, y, z = atom["coord"]
            wx, wy, wz = page.evaluate(
                f"""() => {D}.model.localToWorld(
                    new window.__three_for_tests__.Vector3({x}, {y}, {z})).toArray()"""
            )
            _move_controller(page, 0, wx, wy, wz + 0.5)

        side_chain = next(a for a in atoms if a["resi"] == "10" and a["name"] == "CZ")
        aim_at(side_chain)
        picked = page.evaluate(f"() => {D}.atomUnderController(0)")
        assert picked is None or picked.startswith("CA "), picked

        # --- only ARG 10 drawn, as sticks: its atoms are what the ray finds ---
        x, y, z = side_chain["coord"]
        page.evaluate(f"() => {D}.hideRep('cartoon')")  # nothing selected: everywhere
        page.evaluate(f"() => {D}.selectLocalPoint({x}, {y}, {z})")
        page.evaluate(f"() => {D}.showRep('sticks')")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        aim_at(side_chain)
        picked = page.evaluate(f"() => {D}.atomUnderController(0)")
        assert picked is not None and "ARG10" in picked, picked
        selected_before = page.evaluate(f"() => {D}.selectedKeys")
        page.evaluate(f"() => {D}.onTriggerStart(0)")
        page.evaluate(f"() => {D}.onTriggerEnd(0)")
        # in a measuring tool the trigger picks an atom and leaves the selection alone
        assert page.evaluate(f"() => {D}.pendingAtom")["resi"] == "10"
        assert page.evaluate(f"() => {D}.selectedKeys") == selected_before
        # the animation loop marks the atom under the ray
        page.wait_for_timeout(150)
        assert page.evaluate(
            f"() => {D}.measurementGroup.children.some((c) => c.visible && c.material.color.getHex() === 0xffffff)"
        )

        # --- H-bonds: of the selection, then of everything, then hide some ---
        touching = [pr for pr in pairs if "10" in (by_index[pr[1]]["resi"], by_index[pr[3]]["resi"])]
        assert 0 < len(touching) < len(pairs)
        page.evaluate(f"() => {D}.showHbonds()")
        hbonds = page.evaluate(f"() => {D}.hbonds")
        assert hbonds["pairs"] == len(pairs) and hbonds["shown"] == len(touching)
        assert all(any("ARG10" in end for end in pair) for pair in hbonds["shownPairs"])
        assert hbonds["dashes"] >= hbonds["shown"]  # several dashes per bond
        assert page.evaluate(f"() => {D}.model.getObjectByName('hbonds') !== undefined")

        # the side-panel box is ticked, with a dash while only some are shown
        assert page.is_checked("#show-hbonds")
        assert page.evaluate("() => document.getElementById('show-hbonds').indeterminate")
        page.evaluate(f"() => {D}.clearSelection()")
        page.evaluate(f"() => {D}.showHbonds()")
        assert page.evaluate(f"() => {D}.hbonds.shown") == len(pairs)
        assert not page.evaluate("() => document.getElementById('show-hbonds').indeterminate")

        page.evaluate(f"() => {D}.selectLocalPoint({x}, {y}, {z})")
        page.evaluate(f"() => {D}.hideHbonds()")
        assert page.evaluate(f"() => {D}.hbonds.shown") == len(pairs) - len(touching)

        # --- a colour change reloads the scene but keeps what was shown ---
        page.select_option("#color-select", "chain")
        page.wait_for_function(
            f"() => {D}.layerState('sticks') === 'ready' && {D}.hbonds.dashes > 0", timeout=20000
        )
        assert page.evaluate(f"() => {D}.hbonds.shown") == len(pairs) - len(touching)
        browser.close()
    assert not page_errors, f"uncaught JS errors: {page_errors}"
