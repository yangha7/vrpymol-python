"""The serverless (GitHub Pages) build: baked files, static mode, and VR.

Bakes a small subset through the real pipeline (webxr/bake_static.py),
serves it with a plain static file server -- no Flask, no /api -- and drives
the real page. The last test goes further than test_m7_grab.py can: it
installs Meta's Immersive Web Emulation Runtime (IWER, the same Quest 3
emulator Meta ships for WebXR development) so the page sees a real WebXR
`immersive-vr` session, enters VR through the page's own button, and grabs
the molecule by pressing an emulated Touch controller's trigger.

IWER is fetched from esm.sh at test time, so that test needs network access.
"""

import functools
import http.server
import json
import math
import os
import threading

import pytest
from playwright.sync_api import sync_playwright

from webxr import bake_static

IWER_URL = "https://esm.sh/iwer@2.6.0"


@pytest.fixture(scope="module")
def static_site(tmp_path_factory):
    out_dir = str(tmp_path_factory.mktemp("site") / "site")
    bake_static.bake(
        out_dir,
        molecules=["1crn", "caffeine"],
        reps=["cartoon", "sticks", "spheres"],
        colors=["default", "chain"],
    )
    # Same page, but with the Quest 3 emulator installed before app.js runs
    # (VRButton checks navigator.xr once, when it's created). forceInstall:
    # Chromium ships its own navigator.xr (with no headset behind it), and
    # mixing that native XRWebGLBinding with an emulated session fails --
    # IWER has to replace the whole runtime. A real Quest has no such mix.
    with open(os.path.join(out_dir, "index.html")) as f:
        html = f.read()
    harness = html.replace(
        '<script type="module" src="./app.js"></script>',
        f"""<script type="module">
          import {{ XRDevice, metaQuest3 }} from "{IWER_URL}";
          const device = new XRDevice(metaQuest3);
          device.installRuntime({{ forceInstall: true }});
          window.__xrDevice = device;
          await import("./app.js");
        </script>""",
    )
    assert harness != html
    with open(os.path.join(out_dir, "quest-emulator.html"), "w") as f:
        f.write(harness)

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=out_dir)
    handler.log_message = lambda *args: None
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        # http://127.0.0.1 counts as a secure context, so WebXR is exposed.
        yield f"http://127.0.0.1:{httpd.server_address[1]}", out_dir
    finally:
        httpd.shutdown()


def _wait_loaded(page, suffix=""):
    page.wait_for_function(
        f"""() => {{
            const t = document.getElementById('hud').textContent;
            return t.startsWith('loaded') && t.endsWith({json.dumps(suffix)});
        }}""",
        timeout=20000,
    )


def test_bake_writes_manifest_files_and_atoms(static_site):
    _, out_dir = static_site
    with open(os.path.join(out_dir, "baked", "manifest.json")) as f:
        manifest = json.load(f)
    # caffeine has no polymer backbone -> PyMOL draws no cartoon -> skipped
    assert "caffeine|cartoon|default" not in manifest["files"]
    assert "caffeine|spheres|default" in manifest["files"]
    for path in manifest["files"].values():
        with open(os.path.join(out_dir, path), "rb") as f:
            assert f.read(4) == b"glTF"
    with open(os.path.join(out_dir, manifest["atoms"]["1crn"])) as f:
        assert len(json.load(f)) == 327  # real 1CRN atom count


def test_static_mode_loads_and_switches_without_a_server(static_site):
    url, _ = static_site
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 600})
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(url, wait_until="networkidle")
        _wait_loaded(page, "1crn__cartoon__default.glb")

        # only the baked representations are offered
        offered = page.eval_on_selector_all("#rep-checkboxes input", "els => els.map(e => e.value)")
        assert offered == ["cartoon", "sticks", "spheres"]
        assert not page.is_visible("#add-object-button")
        molecules = page.eval_on_selector_all("#molecule-select option", "els => els.map(e => e.value)")
        assert molecules == ["1crn", "caffeine"]

        page.check("#rep-checkboxes input[value='sticks']")
        _wait_loaded(page, "1crn__sticks__default.glb")
        page.uncheck("#rep-checkboxes input[value='cartoon']")
        page.select_option("#color-select", "chain")
        _wait_loaded(page, "1crn__sticks__chain.glb")

        # caffeine has no cartoon: asking for it switches it back off and,
        # with nothing else shown, falls back to sticks
        page.uncheck("#rep-checkboxes input[value='sticks']")
        page.check("#rep-checkboxes input[value='cartoon']")
        page.select_option("#molecule-select", "caffeine")
        _wait_loaded(page, "caffeine__sticks__chain.glb")
        assert not page.is_checked("#rep-checkboxes input[value='cartoon']")
        assert page.is_checked("#rep-checkboxes input[value='sticks']")
        assert errors == []
        browser.close()


def test_static_measurement_uses_baked_atoms(static_site):
    url, out_dir = static_site
    with open(os.path.join(out_dir, "baked", "atoms", "caffeine.json")) as f:
        atoms = json.load(f)
    a, b = atoms[0], atoms[1]
    expected = math.dist(a["coord"], b["coord"])

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 600})
        page.goto(url, wait_until="networkidle")
        _wait_loaded(page)
        page.select_option("#molecule-select", "caffeine")
        page.check("#rep-checkboxes input[value='spheres']")
        _wait_loaded(page, "caffeine__spheres__default.glb")
        page.wait_for_timeout(300)  # atom table fetch

        # Points slightly off each atom center still resolve to that atom.
        for atom in (a, b):
            x, y, z = (c + 0.05 for c in atom["coord"])
            page.evaluate(f"() => vrPymolDebug.pickLocalPoint({x}, {y}, {z})")
        hud = page.evaluate("() => vrPymolDebug.measureHud")
        assert f"{expected:.2f} Å" in hud, hud
        browser.close()


def test_quest3_emulator_enter_vr_molecule_in_front_and_trigger_grab(static_site):
    url, _ = static_site
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 600})
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(f"{url}/quest-emulator.html", wait_until="networkidle")
        _wait_loaded(page, "1crn__cartoon__default.glb")

        page.click("#VRButton")
        page.wait_for_function("() => vrPymolDebug.renderer.xr.isPresenting", timeout=10000)
        page.wait_for_timeout(500)

        layout = page.evaluate(
            """async () => {
                const THREE = await import("three");
                const head = new THREE.Vector3();
                vrPymolDebug.renderer.xr.getCamera().getWorldPosition(head);
                const box = new THREE.Box3().setFromObject(vrPymolDebug.model);
                const center = box.getCenter(new THREE.Vector3());
                return { head: head.toArray(), center: center.toArray() };
            }"""
        )
        head, center = layout["head"], layout["center"]
        # In front of the viewer (-Z), at arm's length, not inside the head.
        assert center[2] < head[2] - 0.3, layout
        assert math.dist(head, center) < 1.5, layout

        # Aim the emulated right Touch controller straight at the molecule
        # (identity orientation points down -Z) and squeeze the grip.
        cx, cy, cz = center
        page.evaluate(
            f"""() => {{
                const right = __xrDevice.controllers.right;
                right.position.set({cx}, {cy}, {cz + 0.4});
                right.quaternion.set(0, 0, 0, 1);
            }}"""
        )
        page.wait_for_timeout(300)
        page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('squeeze', 1)")
        page.wait_for_function("() => vrPymolDebug.grabbers.length === 1", timeout=5000)

        page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('squeeze', 0)")
        page.wait_for_function("() => vrPymolDebug.grabbers.length === 0", timeout=5000)
        assert errors == []
        browser.close()


def test_quest3_emulator_trigger_selects_and_a_button_toggles_sequence(static_site):
    url, _ = static_site
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 600})
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(f"{url}/quest-emulator.html", wait_until="networkidle")
        _wait_loaded(page, "1crn__cartoon__default.glb")
        # static mode builds the sequence from the baked atom table
        page.wait_for_function("() => vrPymolDebug.sequence.length === 1", timeout=5000)

        page.click("#VRButton")
        page.wait_for_function("() => vrPymolDebug.renderer.xr.isPresenting", timeout=10000)
        # the sequence board opens by itself, below eye level
        page.wait_for_function("() => vrPymolDebug.sequencePanel.visible", timeout=5000)
        geometry = page.evaluate(
            """async () => {
                const THREE = await import("three");
                const head = vrPymolDebug.renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
                const center = new THREE.Box3().setFromObject(vrPymolDebug.model).getCenter(new THREE.Vector3());
                return {
                    head: head.toArray(),
                    panel: vrPymolDebug.sequencePanel.position.toArray(),
                    center: center.toArray(),
                };
            }"""
        )
        assert geometry["panel"][1] < geometry["head"][1] - 0.3, geometry
        assert geometry["panel"][2] < geometry["head"][2], geometry

        # Trigger while aiming at the molecule selects a residue, no grab.
        cx, cy, cz = geometry["center"]
        page.evaluate(
            f"""() => {{
                const right = __xrDevice.controllers.right;
                right.position.set({cx}, {cy}, {cz + 0.4});
                right.quaternion.set(0, 0, 0, 1);
            }}"""
        )
        page.wait_for_timeout(300)
        page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('trigger', 1)")
        page.wait_for_function("() => vrPymolDebug.selectedKeys.length === 1", timeout=5000)
        page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('trigger', 0)")
        assert page.evaluate("() => vrPymolDebug.grabbers") == []
        assert page.evaluate("() => vrPymolDebug.selectionMarkerCount") > 0

        # Mixed representations work without a server: sticks for just the
        # selected residue, fetched as a baked layer and masked in the page.
        page.evaluate("() => vrPymolDebug.showRep('sticks')")
        page.wait_for_function("() => vrPymolDebug.layerState('sticks') === 'ready'", timeout=10000)
        sticks = page.evaluate("() => vrPymolDebug.layerTriangles('sticks')")
        assert 0 < sticks["visible"] < sticks["total"] / 5, sticks
        cartoon = page.evaluate("() => vrPymolDebug.layerTriangles('cartoon')")
        assert cartoon["visible"] == cartoon["total"] > 0

        # H-bonds come from the file baked by real PyMOL; with one residue
        # selected (by the trigger above), only that residue's bonds show.
        page.evaluate("() => vrPymolDebug.showHbonds()")
        hbonds = page.evaluate("() => vrPymolDebug.hbonds")
        assert hbonds["pairs"] == 37  # crambin, see test_measure_and_hbonds.py
        assert 0 < hbonds["shown"] < 37 and hbonds["dashes"] >= hbonds["shown"], hbonds

        # Paint and see-through restyle the baked layers in the page too
        # (their vertex colours are 8-bit, unlike the live server's export).
        key = page.evaluate("() => vrPymolDebug.selectedKeys[0]")
        page.evaluate("() => { vrPymolDebug.paint('#3366ff'); vrPymolDebug.setOpacity(1); }")
        colours = page.evaluate(f"() => vrPymolDebug.residueColors('sticks', {key!r})")
        assert len(colours) == 1, colours
        red, green, blue = (int(colours[0][i:i + 2], 16) for i in (1, 3, 5))
        assert abs(red - 0x33) <= 4 and abs(green - 0x66) <= 4 and abs(blue - 0xFF) <= 4, colours
        sticks = page.evaluate("() => vrPymolDebug.layerTriangles('sticks')")
        assert sticks["transparent"] == sticks["visible"] > 0

        # A hides the board, A again brings it back.
        for expected in (False, True):
            page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('a-button', 1)")
            page.wait_for_function(
                f"() => vrPymolDebug.sequencePanel.visible === {str(expected).lower()}", timeout=5000
            )
            page.evaluate("() => __xrDevice.controllers.right.updateButtonValue('a-button', 0)")
            page.wait_for_timeout(200)
        assert errors == []
        browser.close()
