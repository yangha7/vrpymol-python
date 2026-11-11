"""The real page's click-to-measure flow, driven via window.vrPymolDebug.

Uses `pickLocalPoint` (real known PyMOL atom coordinates) rather than a real
mouse click + raycast, for the same reason test_m7_grab.py drives XR
controllers by hand: this isolates and verifies the actual pick/measure
logic (server round trip, marker/line creation, HUD text) deterministically,
without also depending on raycast-hits-sphere-surface geometry being exactly
right in a headless browser. `onCanvasClick`'s raycast math itself is the
same well-established pattern already used for controller-model hit testing
in M7 (`controllerHitsModel`), not new/risky code.
"""

from tests.live_server import live_server  # noqa: F401

from playwright.sync_api import sync_playwright


def test_two_picks_produce_a_real_distance_measurement(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 800, "height": 600}, ignore_https_errors=True
        )
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=10000,
        )

        # caffeine/spheres: real, known atom coordinates (same fixture and
        # values as the server-side test_measurement.py).
        page.select_option("#molecule-select", "caffeine")
        page.uncheck("#rep-checkboxes input[value='cartoon']")
        page.check("#rep-checkboxes input[value='spheres']")
        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=10000,
        )
        page.wait_for_timeout(200)

        first = page.evaluate(
            "() => window.vrPymolDebug.pickLocalPoint(0.858, 0.259, -0.001)"
        )
        assert first["ok"]
        assert first["name"] == "C1"

        pending = page.evaluate("() => window.vrPymolDebug.pendingAtom")
        assert pending is not None and pending["index"] == first["index"]

        second = page.evaluate(
            "() => window.vrPymolDebug.pickLocalPoint(-3.19, -0.487, 0)"
        )
        assert second["ok"]
        assert second["name"] == "O2"

        # completing the pair clears the pending state and leaves a real
        # measurement (2 markers + 1 line) in the scene graph.
        pending_after = page.evaluate("() => window.vrPymolDebug.pendingAtom")
        assert pending_after is None

        measured = page.evaluate("() => window.vrPymolDebug.measurements")
        assert len(measured) == 1 and measured[0]["kind"] == "distance"
        # drawn as 2 markers, 1 rod between them and 1 value label
        group_children = page.evaluate(
            "() => window.vrPymolDebug.measurementGroup.children.length"
        )
        assert group_children == 4

        hud_text = page.evaluate("() => window.vrPymolDebug.measureHud")
        assert "C1" in hud_text and "O2" in hud_text
        assert "Å" in hud_text  # the Angstrom sign, i.e. a real distance got rendered

        browser.close()


def test_clear_measurements_removes_the_measurement_group(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 800, "height": 600}, ignore_https_errors=True
        )
        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=10000,
        )
        page.select_option("#molecule-select", "caffeine")
        page.uncheck("#rep-checkboxes input[value='cartoon']")
        page.check("#rep-checkboxes input[value='spheres']")
        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=10000,
        )
        page.wait_for_timeout(200)

        page.evaluate("() => window.vrPymolDebug.pickLocalPoint(0.858, 0.259, -0.001)")
        page.evaluate("() => window.vrPymolDebug.pickLocalPoint(-3.19, -0.487, 0)")
        assert page.evaluate("() => window.vrPymolDebug.measurementGroup") is not None

        page.click("#clear-measurements")
        assert page.evaluate("() => window.vrPymolDebug.measurementGroup") is None
        hud_text = page.evaluate("() => window.vrPymolDebug.measureHud")
        assert hud_text.strip() == ""

        browser.close()
