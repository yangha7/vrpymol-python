"""Regression test for a real reported bug: rapidly toggling several
representation checkboxes (e.g. "select all") queued one /api/scene request
per checkbox change on a single-threaded, globally-locked server -- some
representations (surface/mesh/dots) are genuinely slow to export, so this
made the page appear to hang, and every response (even stale ones from
choices already superseded by later clicks) unconditionally overwrote the
view. That made unchecking things, and switching molecule (same code path),
appear completely stuck until the whole backlog of queued requests drained.

Fixed in app.js with a debounce (coalesce a burst of rapid changes into one
request for the final state) plus an abort + sequence-number guard (a
response that's no longer current gets discarded instead of clobbering
newer state). This test verifies the actual fixed mechanism: rapid toggling
produces far fewer real network requests than user actions, and the final
state is the one the user actually landed on, not a stale intermediate one.
"""

from tests.live_server import live_server  # noqa: F401

from playwright.sync_api import sync_playwright


def test_rapid_checkbox_toggling_coalesces_into_one_request(live_server):
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

        # Count real /api/scene requests from here on.
        page.evaluate(
            """() => {
                window.__sceneRequestCount = 0;
                const realFetch = window.fetch;
                window.fetch = (...args) => {
                    if (String(args[0]).includes('/api/scene')) {
                        window.__sceneRequestCount += 1;
                    }
                    return realFetch(...args);
                };
            }"""
        )

        # Check several boxes back to back, like a user clicking through
        # "select all". Each representation is now its own layer, fetched
        # once from /api/layer, so toggling them must not touch /api/scene
        # (which reloads the whole scene) at all.
        reps = ["sticks", "spheres", "lines", "ribbon", "surface"]
        for value in reps:
            page.check(f"#rep-checkboxes input[value='{value}']")

        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=15000,
        )

        request_count = page.evaluate("() => window.__sceneRequestCount")
        assert request_count == 0, (
            f"representation toggles made {request_count} /api/scene requests"
        )
        page.wait_for_function(
            f"() => {reps!r}.every((rep) => window.vrPymolDebug.layerState(rep) === 'ready')",
            timeout=15000,
        )
        for value in reps:
            assert page.is_checked(f"#rep-checkboxes input[value='{value}']")
            triangles = page.evaluate(f"() => window.vrPymolDebug.layerTriangles('{value}')")
            assert triangles["visible"] == triangles["total"] > 0, (value, triangles)

        browser.close()


def test_unchecking_after_rapid_checking_actually_takes_effect(live_server):
    """The literal reported symptom: check a box, then quickly uncheck it --
    the final state must reflect "unchecked", not get stuck showing
    "checked" forever behind a backlog of stale in-flight responses."""
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

        page.check("#rep-checkboxes input[value='spheres']")
        page.uncheck("#rep-checkboxes input[value='spheres']")

        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=15000,
        )
        # give any stale in-flight response a chance to (wrongly) land
        page.wait_for_timeout(500)

        assert page.is_checked("#rep-checkboxes input[value='cartoon']")
        assert not page.is_checked("#rep-checkboxes input[value='spheres']")

        browser.close()


def test_controls_disabled_while_a_request_is_in_flight(live_server):
    """The server can't actually be interrupted mid-render (its single Python
    thread keeps running to completion regardless of client-side aborts) --
    confirmed live: a fully-combined representation set left the real server
    at 100% CPU, unresponsive to anything, for well over a minute. So while
    a request is genuinely in flight, controls must show as busy/disabled
    rather than looking interactive but silently doing nothing until a
    backlog drains -- and must become interactive again once it resolves."""
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

        assert not page.eval_on_selector("#molecule-select", "el => el.disabled")

        page.check("#rep-checkboxes input[value='surface']")
        # the layer request goes out at once, so controls are disabled
        # straight away, before the (comparatively slow) surface export
        # can finish.
        assert page.eval_on_selector("#molecule-select", "el => el.disabled"), (
            "expected controls to be disabled while a scene request is in flight"
        )

        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=30000,
        )
        assert not page.eval_on_selector("#molecule-select", "el => el.disabled"), (
            "expected controls to be re-enabled once the request finished"
        )

        browser.close()


def test_switching_molecule_after_rapid_rep_toggling_still_works(live_server):
    """The second reported symptom: switching molecule (same applySelection
    code path) must not get stuck behind a backlog of earlier rep changes."""
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

        for value in ["sticks", "spheres", "lines"]:
            page.check(f"#rep-checkboxes input[value='{value}']")
        page.select_option("#molecule-select", "caffeine")

        page.wait_for_function(
            "document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=15000,
        )
        page.wait_for_timeout(500)

        assert page.evaluate("() => document.getElementById('molecule-select').value") == "caffeine"
        hud_text = page.evaluate("() => document.getElementById('hud').textContent")
        assert "loaded" in hud_text

        browser.close()
