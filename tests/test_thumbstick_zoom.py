"""Thumbstick zoom: scale the model about its own centre from a controller stick.

Like M7, reading a real controller's thumbstick needs a real headset. What is
verifiable headlessly is the zoom math itself, driven through the
`window.vrPymolDebug.stickZoom(stickY, dt)` hook, which applies exactly what
one animation frame applies for a given stick deflection.
"""

from tests.live_server import live_server  # noqa: F401

from playwright.sync_api import sync_playwright

from tests.test_m7_grab import _get_box_center_and_position, _move_controller

MODEL = "window.vrPymolDebug.model"


def _zoom(page, stick_y, dt, frames=1):
    page.evaluate(
        f"""() => {{
            for (let i = 0; i < {frames}; i++) window.vrPymolDebug.stickZoom({stick_y}, {dt});
        }}"""
    )


def _pivot(page):
    return page.evaluate("() => window.vrPymolDebug.zoomPivot")


def _close(a, b, tol=1e-6):
    return all(abs(x - y) < tol for x, y in zip(a, b))


def test_thumbstick_zoom(live_server):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 800, "height": 600}, ignore_https_errors=True
        )
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))

        page.goto(live_server, wait_until="networkidle")
        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=10000,
        )
        page.wait_for_timeout(200)
        page.evaluate(
            """async () => { window.__three_for_tests__ = await import("three"); }"""
        )

        start = _get_box_center_and_position(page, MODEL)
        # The pivot is the centre of the molecule's atoms, which is close to
        # but not exactly the centre of whatever geometry is drawn.
        pivot = _pivot(page)

        # Inside the deadzone: stick drift must not zoom.
        _zoom(page, -0.1, 0.5)
        assert _get_box_center_and_position(page, MODEL)["scale"] == start["scale"]

        # Forward (negative Y) zooms in, about the model's centre.
        _zoom(page, -1.0, 0.5)
        zoomed_in = _get_box_center_and_position(page, MODEL)
        assert abs(zoomed_in["scale"] / start["scale"] - 2.718281828 ** 0.5) < 1e-3
        assert _close(_pivot(page), pivot), "zoom should not move the molecule's centre"
        assert not _close(zoomed_in["position"], start["position"])  # it scaled about it

        # Back by the same amount returns to the starting size.
        _zoom(page, 1.0, 0.5)
        restored = _get_box_center_and_position(page, MODEL)
        assert abs(restored["scale"] / start["scale"] - 1) < 1e-6
        assert _close(_pivot(page), pivot)

        # Held for a long time, zoom stops at the limits instead of running away.
        _zoom(page, -1.0, 0.1, frames=200)
        biggest = _get_box_center_and_position(page, MODEL)
        assert abs(biggest["scale"] / start["scale"] - 50) < 1e-6
        _zoom(page, 1.0, 0.1, frames=400)
        smallest = _get_box_center_and_position(page, MODEL)
        assert abs(smallest["scale"] / start["scale"] - 0.05) < 1e-6
        assert _close(_pivot(page), pivot)

        # Reset view undoes zoom.
        page.evaluate("() => window.vrPymolResetView()")
        reset = _get_box_center_and_position(page, MODEL)
        assert abs(reset["scale"] / start["scale"] - 1) < 1e-9

        # While held in one hand (model parented to a rotated controller) the
        # zoom still pivots on the model's centre.
        cx, cy, cz = reset["center"]
        _move_controller(page, 0, cx, cy, cz + 1)
        page.evaluate("() => window.vrPymolDebug.onGrabStart(0)")
        assert page.evaluate("() => window.vrPymolDebug.grabbers") == [0]
        page.evaluate(
            """() => {
                const c = window.vrPymolDebug.controllers[0];
                c.rotation.set(0.4, 0.7, -0.3);
                c.updateMatrix();
                c.updateMatrixWorld(true);
            }"""
        )
        held = _get_box_center_and_position(page, MODEL)
        held_pivot = _pivot(page)
        _zoom(page, -1.0, 0.5)
        held_zoomed = _get_box_center_and_position(page, MODEL)
        assert held_zoomed["scale"] > held["scale"] * 1.6
        assert _close(_pivot(page), held_pivot), "zoom while held should not move the centre"

        # During a two-handed grab the hands own the scale: stick is ignored.
        _move_controller(page, 0, cx, cy, cz + 1)
        page.evaluate("() => window.vrPymolResetView()")
        page.evaluate("() => window.vrPymolDebug.onGrabStart(0)")
        _move_controller(page, 1, cx, cy, cz + 1.3)
        page.evaluate("() => window.vrPymolDebug.onGrabStart(1)")
        assert page.evaluate("() => window.vrPymolDebug.grabbers") == [0, 1]
        page.wait_for_timeout(100)
        before = _get_box_center_and_position(page, MODEL)["scale"]
        _zoom(page, -1.0, 0.5)
        assert _get_box_center_and_position(page, MODEL)["scale"] == before

        browser.close()

    assert not page_errors, f"uncaught JS errors: {page_errors}"
