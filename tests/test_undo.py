"""Undo and redo of everything the menu can change, including selection."""

from playwright.sync_api import sync_playwright

from tests.live_server import live_server  # noqa: F401
from tests.test_style_and_groups import _open, _select_residue

D = "window.vrPymolDebug"


def _history(page):
    return page.evaluate(f"() => {D}.history")


def _press(page, index):
    """One press-and-release of gamepad button `index` on an XR controller,
    fed to the same polling function the animation loop calls."""
    page.evaluate(
        f"""() => {{
            const source = window.__testSource ??= {{ gamepad: {{ buttons: [] }} }};
            const frame = (pressed) => {{
                source.gamepad.buttons = Array.from({{ length: 6 }}, (_, i) => ({{ pressed: pressed && i === {index} }}));
                {D}.pollMenuButtons({{ inputSources: [source] }});
            }};
            frame(true);
            frame(true);  // still held on the next frame: must not repeat
            frame(false);
        }}"""
    )


def test_undo_and_redo_walk_back_through_every_kind_of_change(live_server):
    with sync_playwright() as p:
        browser, page, errors = _open(p, live_server)
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        by_name = {(a["resi"], a["name"]): a for a in atoms}
        # start from a clean history whatever the fixture's setup did
        page.evaluate(f"() => {{ {D}.clearSelection(); }}")
        start = _history(page)["at"]

        def expression():
            return page.inner_text("#selection-hud")

        # --- selection ---
        _select_residue(page, atoms, "10")
        assert expression() == "chain A and resi 10"
        page.click("#undo")
        assert expression() == "nothing selected"
        page.click("#redo")
        assert expression() == "chain A and resi 10"

        # a sweep across the sequence is one step, not one per residue
        page.evaluate(f"() => {D}.clearSelection()")
        page.click("#toggle-sequence")
        box = page.locator("#sequence-canvas").bounding_box()

        def cell_xy(index):
            cell = page.evaluate(f"() => {D}.sequenceCell({index})")
            return box["x"] + cell["u"] * box["width"], box["y"] + cell["v"] * box["height"]

        page.mouse.move(*cell_xy(4))
        page.mouse.down()
        page.mouse.move(*cell_xy(9), steps=5)
        page.mouse.up()
        assert expression() == "chain A and resi 5-10"
        page.click("#undo")
        assert expression() == "nothing selected"
        page.click("#redo")
        page.click("#toggle-sequence")

        # --- representation, colour, opacity, scheme: one step each ---
        page.evaluate(f"() => {D}.showRep('sticks')")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        page.evaluate(f"() => {D}.hideRep('cartoon')")
        page.click("#paint-swatches button[title='red']")
        page.click("#opacity-buttons button[data-level='2']")
        page.select_option("#color-select", "rainbow")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)

        def snapshot():
            return page.evaluate(
                f"""() => ({{
                    sticks: {D}.shownCount('sticks'),
                    cartoon: {D}.shownCount('cartoon'),
                    scheme: {D}.schemeOf('mol|A|7'),
                    see_through: {D}.layerTriangles('sticks').transparent > 0,
                    red: {D}.residueColors('sticks', 'mol|A|7').length === 1,
                }})"""
            )

        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        assert snapshot() == {"sticks": 6, "cartoon": 40, "scheme": "rainbow", "see_through": True, "red": True}
        expected = [
            {"sticks": 6, "cartoon": 40, "scheme": "default", "see_through": True, "red": True},  # scheme undone
            {"sticks": 6, "cartoon": 40, "scheme": "default", "see_through": False, "red": True},  # opacity
            {"sticks": 6, "cartoon": 40, "scheme": "default", "see_through": False, "red": False},  # paint
            {"sticks": 6, "cartoon": 46, "scheme": "default", "see_through": False, "red": False},  # hide cartoon
        ]
        for state in expected:
            page.click("#undo")
            page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
            assert snapshot() == state
        page.click("#undo")  # show sticks
        assert page.evaluate(f"() => {D}.shownCount('sticks')") == 0
        assert expression() == "chain A and resi 5-10"  # the selection was not part of those steps

        # redo all five, then a new change: nothing is left to redo
        for _ in range(5):
            page.click("#redo")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        assert snapshot() == {"sticks": 6, "cartoon": 40, "scheme": "rainbow", "see_through": True, "red": True}
        assert not _history(page)["canRedo"]
        page.click("#undo")
        assert _history(page)["canRedo"]
        page.evaluate(f"() => {D}.clearSelection()")
        assert not _history(page)["canRedo"]
        assert page.is_disabled("#redo")

        # --- groups: save, rename ---
        _select_residue(page, atoms, "20")
        page.evaluate(f"() => {D}.saveGroup()")
        page.evaluate(f"() => {D}.renameGroup('sele1', 'loop')")
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["loop"]
        page.click("#undo")
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["sele1"]
        page.click("#undo")
        assert page.evaluate(f"() => {D}.groups") == []
        page.click("#redo")
        page.click("#redo")
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["loop"]

        # --- measurements and H-bonds ---
        page.select_option("#tool-mode", "distance")
        for key in (("7", "O"), ("11", "N")):
            x, y, z = by_name[key]["coord"]
            page.evaluate(f"() => {D}.pickLocalPoint({x}, {y}, {z})")
        measured = page.evaluate(f"() => {D}.measurements")
        assert len(measured) == 1
        page.click("#undo")
        assert page.evaluate(f"() => {D}.measurements") == []
        page.click("#redo")
        assert page.evaluate(f"() => {D}.measurements") == measured
        assert page.evaluate(f"() => {D}.measurementGroup.children.length") == 4  # drawn again too

        page.evaluate(f"() => {D}.showHbonds()")
        shown = page.evaluate(f"() => {D}.hbonds.shown")
        assert shown > 0
        page.click("#undo")
        page.wait_for_function(f"() => {D}.hbonds.dashes === 0", timeout=5000)
        assert page.evaluate(f"() => {D}.hbonds.shown") == 0

        # --- B (or Y) on a controller undoes; A (or X) is the menu, not undo ---
        before = _history(page)["at"]
        _press(page, 5)
        assert _history(page)["at"] == before - 1, "one press is one undo, however long it is held"
        _press(page, 4)
        assert _history(page)["at"] == before - 1
        assert page.evaluate(f"() => {D}.sequencePanel.visible")

        # --- Ctrl+Z / Ctrl+Shift+Z ---
        page.keyboard.press("Control+z")
        assert _history(page)["at"] == before - 2
        page.keyboard.press("Control+Shift+z")
        assert _history(page)["at"] == before - 1

        # --- undo stops at the molecule as it was loaded, and a different
        # molecule starts over ---
        for _ in range(60):
            if not page.evaluate(f"() => {D}.undo()"):
                break
        assert _history(page)["at"] == 0 and page.is_disabled("#undo")
        assert start >= 0
        page.select_option("#molecule-select", "caffeine")
        page.wait_for_function(f"() => {D}.sequence.join('') === 'X'", timeout=10000)
        page.wait_for_function("() => document.getElementById('hud').textContent.startsWith('loaded')", timeout=10000)
        page.wait_for_timeout(200)
        assert _history(page) == {"steps": 1, "at": 0, "canUndo": False, "canRedo": False}
        browser.close()
    assert not errors, f"uncaught JS errors: {errors}"
