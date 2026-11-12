"""Mixed representations: each representation is a layer, masked per residue.

Showing sticks for a selection while the rest stays cartoon is done in the
browser: the sticks layer is fetched once and only the triangles belonging
to the selected residues are drawn. These tests check that the triangles
drawn really are the selected residues' (by distance to their atoms, and for
spheres by an exact triangle count), not just that some flag was set.
"""

from playwright.sync_api import sync_playwright

from tests.live_server import live_server  # noqa: F401
from tests.test_selection import _aim_controller_at_cell

# Largest distance (Angstroms, model frame) from the centroid of any drawn
# triangle of a layer to the nearest of the given atoms.
FARTHEST_DRAWN_TRIANGLE_JS = """([rep, atoms]) => {
    const three = window.__three_for_tests__;
    const model = window.vrPymolDebug.model;
    model.updateMatrixWorld(true);
    const toModel = model.matrixWorld.clone().invert();
    const a = new three.Vector3(), b = new three.Vector3(), c = new three.Vector3();
    let farthest = 0, triangles = 0;
    model.traverse((mesh) => {
        // every layer of this representation (one per colouring scheme in use)
        let layer = mesh;
        while (layer && !layer.name.startsWith(`layer-${rep}-`)) layer = layer.parent;
        if (!layer || !mesh.isMesh || !mesh.visible) return;
        const matrix = new three.Matrix4().multiplyMatrices(toModel, mesh.matrixWorld);
        const position = mesh.geometry.attributes.position;
        const index = mesh.geometry.index;
        for (let i = 0; i < mesh.geometry.drawRange.count; i += 3) {
            a.fromBufferAttribute(position, index.getX(i)).applyMatrix4(matrix);
            b.fromBufferAttribute(position, index.getX(i + 1)).applyMatrix4(matrix);
            c.fromBufferAttribute(position, index.getX(i + 2)).applyMatrix4(matrix);
            a.add(b).add(c).divideScalar(3);
            let nearest = Infinity;
            for (const [x, y, z] of atoms) {
                nearest = Math.min(nearest, Math.hypot(a.x - x, a.y - y, a.z - z));
            }
            farthest = Math.max(farthest, nearest);
            triangles += 1;
        }
    });
    return { farthest, triangles };
}"""


def _wait_ready(page, rep):
    page.wait_for_function(
        f"() => window.vrPymolDebug.layerState('{rep}') === 'ready'", timeout=20000
    )


def _triangles(page, rep):
    return page.evaluate(f"() => window.vrPymolDebug.layerTriangles('{rep}')")


def test_show_and_hide_by_selection(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1200, "height": 900}, ignore_https_errors=True
        )
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function("() => window.vrPymolDebug.sequence.length > 0", timeout=10000)
        page.evaluate("async () => { window.__three_for_tests__ = await import('three'); }")
        _wait_ready(page, "cartoon")

        # default: the whole molecule as cartoon, nothing else even fetched
        cartoon = _triangles(page, "cartoon")
        assert cartoon["visible"] == cartoon["total"] > 0
        assert page.evaluate("() => window.vrPymolDebug.layerState('sticks')") == "unloaded"
        model_before = page.evaluate("() => window.vrPymolDebug.model.uuid")

        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        helix = [a["coord"] for a in atoms if 7 <= int(a["resi"]) <= 19]

        # select residues 7-19 by sweeping the sequence, then show them as sticks
        page.click("#toggle-sequence")
        box = page.locator("#sequence-canvas").bounding_box()

        def cell_xy(index):
            cell = page.evaluate(f"() => window.vrPymolDebug.sequenceCell({index})")
            return box["x"] + cell["u"] * box["width"], box["y"] + cell["v"] * box["height"]

        page.mouse.move(*cell_xy(6))
        page.mouse.down()
        page.mouse.move(*cell_xy(18), steps=4)
        page.mouse.up()
        assert page.inner_text("#selection-hud") == "chain A and resi 7-19"

        page.check("#rep-checkboxes input[value='sticks']")
        _wait_ready(page, "sticks")
        sticks = _triangles(page, "sticks")
        assert 0 < sticks["visible"] < sticks["total"]
        assert page.evaluate("() => window.vrPymolDebug.shownCount('sticks')") == 13
        # every stick triangle drawn lies on a selected residue: within half
        # a bond length (~0.8 A) of one of its atoms
        drawn = page.evaluate(FARTHEST_DRAWN_TRIANGLE_JS, ["sticks", helix])
        assert drawn["triangles"] == sticks["visible"]
        assert drawn["farthest"] < 1.0, drawn
        # the rest is untouched: cartoon still complete, same model, same view
        assert _triangles(page, "cartoon") == cartoon
        assert page.evaluate("() => window.vrPymolDebug.model.uuid") == model_before

        # hiding cartoon acts on the selection only
        page.evaluate("() => window.vrPymolDebug.hideRep('cartoon')")
        partial = _triangles(page, "cartoon")
        assert 0 < partial["visible"] < cartoon["total"]
        assert page.evaluate("() => window.vrPymolDebug.shownCount('cartoon')") == 46 - 13
        others = [a["coord"] for a in atoms if not 7 <= int(a["resi"]) <= 19]
        # what is left of the cartoon belongs to the other residues (cartoon
        # runs within ~2 A of the backbone; a cut end reaches half a residue,
        # ~1.9 A, towards its neighbour)
        drawn = page.evaluate(FARTHEST_DRAWN_TRIANGLE_JS, ["cartoon", others])
        assert drawn["farthest"] < 3.0, drawn

        # spheres: exactly the selected atoms' spheres, each one whole, even
        # though neighbouring spheres overlap
        page.evaluate("() => window.vrPymolDebug.clearSelection()")
        page.mouse.click(*cell_xy(9))  # ARG 10
        page.evaluate("() => window.vrPymolDebug.showRep('spheres')")
        _wait_ready(page, "spheres")
        spheres = _triangles(page, "spheres")
        arg10 = [a for a in atoms if a["resi"] == "10"]
        assert spheres["total"] % len(atoms) == 0
        assert spheres["visible"] == spheres["total"] // len(atoms) * len(arg10)

        # the 3D menu's buttons do the same: trigger on "hide spheres"
        page.evaluate("() => window.vrPymolDebug.toggleSequencePanel()")
        page.evaluate(
            """() => {
                const d = window.vrPymolDebug;
                const b = d.menuButton("hide", "spheres");
                d.sequenceCell = () => b;  // reuse the cell-aiming helper below
            }"""
        )
        _aim_controller_at_cell(page, 0, 0)
        page.evaluate("() => window.vrPymolDebug.onTriggerStart(0)")
        page.evaluate("() => window.vrPymolDebug.onTriggerEnd(0)")
        assert _triangles(page, "spheres")["visible"] == 0
        assert not page.is_checked("#rep-checkboxes input[value='spheres']")

        # a colour change re-fetches the layers but keeps who is shown how
        page.select_option("#color-select", "chain")
        page.wait_for_function(
            "() => ['cartoon', 'sticks'].every((rep) => window.vrPymolDebug.layerState(rep) === 'ready')"
            " && document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=20000,
        )
        # (triangle counts are not comparable across colourings: PyMOL
        # draws a bond as one cylinder when both ends share a colour and as
        # two halves when they don't)
        assert page.evaluate("() => window.vrPymolDebug.shownCount('sticks')") == 13
        assert page.evaluate("() => window.vrPymolDebug.shownCount('cartoon')") == 46 - 13
        recoloured = _triangles(page, "sticks")
        assert 0 < recoloured["visible"] < recoloured["total"]
        drawn = page.evaluate(FARTHEST_DRAWN_TRIANGLE_JS, ["sticks", helix])
        assert drawn["farthest"] < 1.0, drawn
        assert _triangles(page, "cartoon") == partial
        assert page.evaluate("() => window.vrPymolDebug.model.uuid") == model_before

        browser.close()

    assert not page_errors, f"uncaught JS errors: {page_errors}"
