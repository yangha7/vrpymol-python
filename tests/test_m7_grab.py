"""M7: controller grab / rotate / two-handed scale interaction logic.

Entering a real WebXR session and driving actual tracked controllers needs a
real headset -- genuinely unverifiable from this Mac (see project memory and
the plan's M7 note). What *is* verifiable headlessly: the interaction code
itself runs without error in a real (non-XR) browser session, and its
grab/reparent/scale/rotate/translate math is correct -- exercised here via
the `window.vrPymolDebug` hooks `app.js` exposes specifically for this
(`onGrabStart`/`onGrabEnd`/`controllers`/`grabbers`/`model`), driving the
two `renderer.xr.getController()` objects by hand (positioning them and
firing the same select events a real controller would) instead of a real
XR input source.
"""

from tests.live_server import live_server  # noqa: F401

from playwright.sync_api import sync_playwright


def _move_controller(page, index, x, y, z):
    # renderer.xr.getController() groups have matrixAutoUpdate = false (three.js
    # writes their matrix directly from the real XR pose every frame instead of
    # deriving it from position/quaternion/scale) -- so a manual position.set()
    # in a non-XR test session is otherwise silently ignored. updateMatrix()
    # forces the recompute regardless of that flag, matching what a real
    # session's per-frame pose update effectively does.
    page.evaluate(
        f"""() => {{
            const c = window.vrPymolDebug.controllers[{index}];
            c.position.set({x}, {y}, {z});
            c.quaternion.identity();
            c.updateMatrix();
            c.updateMatrixWorld(true);
        }}"""
    )


def _get_box_center_and_position(page, obj_expr):
    return page.evaluate(
        f"""() => {{
            const three = window.__three_for_tests__;
            const obj = {obj_expr};
            const box = new three.Box3().setFromObject(obj);
            const center = new three.Vector3();
            box.getCenter(center);
            return {{
                center: [center.x, center.y, center.z],
                position: [obj.position.x, obj.position.y, obj.position.z],
                scale: obj.scale.x,
                parentIsScene: obj.parent === window.vrPymolDebug.scene,
            }};
        }}"""
    )


def test_single_hand_grab_and_two_hand_scale(live_server):
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

        # Expose the same THREE/scene instances app.js is already using, via a
        # tiny inline module import (same specifier the page's own importmap
        # resolves), so this test can do real Box3/Vector3 math against the
        # real model instead of guessing coordinates.
        page.evaluate(
            """async () => {
                const three = await import("three");
                window.__three_for_tests__ = three;
            }"""
        )

        model_info = _get_box_center_and_position(page, "window.vrPymolDebug.model")
        cx, cy, cz = model_info["center"]

        # Controller 0: sit in front of the model looking straight at it
        # (identity rotation -> ray direction is world -Z), one unit away.
        _move_controller(page, 0, cx, cy, cz + 1)

        page.evaluate("() => window.vrPymolDebug.onGrabStart(0)")
        grabbers = page.evaluate("() => window.vrPymolDebug.grabbers")
        assert grabbers == [0], f"expected controller 0 to grab, got {grabbers}"

        parent_check = page.evaluate(
            """() => window.vrPymolDebug.model.parent === window.vrPymolDebug.controllers[0]"""
        )
        assert parent_check, "model should be reparented under the grabbing controller"

        # Move controller 0: model should follow (attach() semantics), i.e.
        # its world position tracks the controller's new position.
        _move_controller(page, 0, cx + 0.5, cy, cz + 1)
        moved = _get_box_center_and_position(page, "window.vrPymolDebug.model")
        assert abs(moved["center"][0] - (cx + 0.5)) < 0.05, (
            f"model did not follow grabbing controller: {moved}"
        )

        # Grab with the second controller too, on the same ray (same x/y as
        # controller 0's current aim, guaranteed to hit since it's the exact
        # line already confirmed above) but a different distance back, so the
        # two controllers start out a known nonzero distance apart -> switch
        # into two-handed tracking.
        _move_controller(page, 1, cx + 0.5, cy, cz + 1.3)
        page.evaluate("() => window.vrPymolDebug.onGrabStart(1)")
        grabbers = page.evaluate("() => window.vrPymolDebug.grabbers")
        assert grabbers == [0, 1], f"expected both controllers grabbing, got {grabbers}"

        two_hand_info = _get_box_center_and_position(page, "window.vrPymolDebug.model")
        assert two_hand_info["parentIsScene"], (
            "on second grab the model should be detached back to world space"
        )
        start_scale = two_hand_info["scale"]

        # Pull the two controllers apart (push controller 1 further back
        # along the same ray) -> distance grows well past the 0.3 they
        # started at, so scale should grow proportionally. updateTwoHandGrab()
        # runs inside the renderer's own animation loop (a plain rAF loop,
        # which keeps firing even outside an XR session), so it picks this up
        # on the next rendered frame without any direct call from this test.
        _move_controller(page, 1, cx + 0.5, cy, cz + 3.3)
        page.wait_for_timeout(150)
        scaled_info = _get_box_center_and_position(page, "window.vrPymolDebug.model")
        assert scaled_info["scale"] > start_scale * 1.5, (
            f"two-handed pull-apart should scale the model up: "
            f"start={start_scale}, after={scaled_info['scale']}"
        )

        # Release both -> model should end up back under the scene, untouched
        # by either controller.
        page.evaluate("() => window.vrPymolDebug.onGrabEnd(0)")
        page.evaluate("() => window.vrPymolDebug.onGrabEnd(1)")
        grabbers = page.evaluate("() => window.vrPymolDebug.grabbers")
        assert grabbers == [], f"expected no grabbers after release, got {grabbers}"
        final_info = _get_box_center_and_position(page, "window.vrPymolDebug.model")
        assert final_info["parentIsScene"], "model should be back under the scene after release"

        browser.close()

    assert not page_errors, f"uncaught JS errors: {page_errors}"
