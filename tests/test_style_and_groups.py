"""Per-selection colour and transparency, named groups, and folding chains.

All four live in the page: paint and see-through restyle the loaded layers,
groups are saved selections, and the menu folds each chain's sequence away.
"""

from playwright.sync_api import sync_playwright

from tests.live_server import live_server  # noqa: F401
from tests.test_selection import _aim_controller_at_cell

D = "window.vrPymolDebug"


def _open(p, live_server):
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900}, ignore_https_errors=True)
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(live_server, wait_until="networkidle")
    # The server keeps whatever molecule the previous test left loaded;
    # push this page's own state (1crn, default settings) to it first.
    page.evaluate("() => window.vrPymolApplySelection()")
    page.wait_for_function(f"() => {D}.sequence.join('').length === 46", timeout=10000)
    # ...and start from plain cartoon (after caffeine, which has no cartoon,
    # the page will have fallen back to sticks and carried that over)
    page.evaluate(f"() => {{ {D}.hideRep('sticks'); {D}.showRep('cartoon'); }}")
    page.wait_for_function(f"() => {D}.layerState('cartoon') === 'ready'", timeout=10000)
    page.evaluate("async () => { window.__three_for_tests__ = await import('three'); }")
    return browser, page, errors


def _select_residue(page, atoms, resi):
    x, y, z = next(a["coord"] for a in atoms if a["resi"] == resi)
    page.evaluate(f"() => {D}.selectLocalPoint({x}, {y}, {z})")


def _is_colour(found, wanted, tolerance=4):
    """Hex colours equal to within rounding of 8-bit vertex colours."""
    channels = lambda h: [int(h[i:i + 2], 16) for i in (1, 3, 5)]  # noqa: E731
    return all(abs(a - b) <= tolerance for a, b in zip(channels(found), channels(wanted)))


def test_paint_and_see_through_act_on_the_selection(live_server):
    with sync_playwright() as p:
        browser, page, errors = _open(p, live_server)
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")
        original = page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|10')")
        assert len(original) == 1 and not _is_colour(original[0], "#ff3030")

        # --- paint ARG 10 red: only its part of the cartoon changes ---
        _select_residue(page, atoms, "10")
        page.click("#paint-swatches button[title='red']")
        painted = page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|10')")
        assert len(painted) == 1 and _is_colour(painted[0], "#ff3030"), painted
        assert page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|30')") == original

        # a layer fetched afterwards comes in already painted
        page.evaluate(f"() => {D}.showRep('sticks')")
        page.wait_for_function(f"() => {D}.layerState('sticks') === 'ready'", timeout=10000)
        sticks = page.evaluate(f"() => {D}.residueColors('sticks', 'mol|A|10')")
        assert len(sticks) == 1 and _is_colour(sticks[0], "#ff3030"), sticks

        # the paint survives a change of colouring scheme underneath it
        page.select_option("#color-select", "rainbow")
        page.wait_for_function(
            f"() => {D}.layerState('cartoon') === 'ready' && {D}.layerState('sticks') === 'ready'"
            " && document.getElementById('hud').textContent.startsWith('loaded')",
            timeout=20000,
        )
        painted = page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|10')")
        assert len(painted) == 1 and _is_colour(painted[0], "#ff3030"), painted
        rainbow = page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|30')")
        assert rainbow != original

        # reset gives the residue its scheme colour back
        page.click("#paint-reset")
        reset = page.evaluate(f"() => {D}.residueColors('cartoon', 'mol|A|10')")
        assert not any(_is_colour(c, "#ff3030") for c in reset)

        # --- see-through: the rest of the molecule, so ARG 10 shows through ---
        page.click("#invert-selection")
        before = page.evaluate(f"() => {D}.layerTriangles('cartoon')")
        assert before["transparent"] == 0
        page.click("#opacity-buttons button[data-level='2']")
        after = page.evaluate(f"() => {D}.layerTriangles('cartoon')")
        assert after["visible"] == before["visible"]  # nothing hidden, only restyled
        assert 0 < after["transparent"] < after["visible"]
        ghosts = page.evaluate(
            f"""() => {{
                const found = [];
                {D}.model.traverse((o) => {{
                    if (o.isMesh && o.visible && o.material.transparent && o.name.includes("seethrough")) {{
                        found.push([o.material.opacity, o.material.depthWrite]);
                    }}
                }});
                return found;
            }}"""
        )
        assert ghosts and all(opacity == 0.2 and not depth_write for opacity, depth_write in ghosts)
        page.click("#opacity-buttons button[data-level='0']")
        assert page.evaluate(f"() => {D}.layerTriangles('cartoon')") == before

        browser.close()
    assert not errors, f"uncaught JS errors: {errors}"


def test_groups_save_recall_rename_delete(live_server):
    with sync_playwright() as p:
        browser, page, errors = _open(p, live_server)
        atoms = page.evaluate("async () => (await (await fetch('/api/atoms')).json()).atoms")

        page.click("#save-group")  # nothing selected: refused
        assert page.evaluate(f"() => {D}.groups") == []

        _select_residue(page, atoms, "10")
        _select_residue(page, atoms, "11")
        page.click("#save-group")
        assert page.evaluate(f"() => {D}.groups") == [{"name": "sele1", "size": 2, "active": True}]

        # a second group; recalling the first makes it the selection again
        page.evaluate(f"() => {D}.clearSelection()")
        _select_residue(page, atoms, "30")
        assert page.evaluate(f"() => {D}.saveGroup()") == "sele2"
        page.click("#group-list button:has-text('sele1')")
        assert page.inner_text("#selection-hud") == "chain A and resi 10-11"
        assert [g["active"] for g in page.evaluate(f"() => {D}.groups")] == [True, False]

        # rename through the name box, as the Quest keyboard would fill it:
        # illegal characters become underscores, as PyMOL names require
        page.evaluate(f"() => {D}.startRename()")
        assert page.evaluate("() => document.activeElement.id") == "group-name"
        page.fill("#group-name", "active site")
        page.keyboard.press("Enter")
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["active_site", "sele2"]
        # a name already in use is refused
        assert page.evaluate(f"() => {D}.renameGroup('sele2', 'active_site')") is None
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["active_site", "sele2"]

        # the menu shows a button per group: trigger on "sele2" recalls it
        page.evaluate(f"() => {D}.toggleSequencePanel()")
        page.evaluate(
            f"""() => {{ const b = {D}.menuButton("recallGroup", "sele2"); {D}.sequenceCell = () => b; }}"""
        )
        _aim_controller_at_cell(page, 0, 0)
        page.evaluate(f"() => {D}.onTriggerStart(0)")
        page.evaluate(f"() => {D}.onTriggerEnd(0)")
        assert page.inner_text("#selection-hud") == "chain A and resi 30"

        page.click("#delete-group")
        assert [g["name"] for g in page.evaluate(f"() => {D}.groups")] == ["active_site"]

        # groups belong to the molecule: switching it drops them
        page.select_option("#molecule-select", "caffeine")
        page.wait_for_function(f"() => {D}.sequence.join('') === 'X'", timeout=10000)
        assert page.evaluate(f"() => {D}.groups") == []
        browser.close()
    assert not errors, f"uncaught JS errors: {errors}"


def test_chains_fold_and_only_the_first_starts_open(live_server):
    with sync_playwright() as p:
        browser, page, errors = _open(p, live_server)
        page.select_option("#molecule-select", "4hhb")
        page.wait_for_function(f"() => {D}.sequence.length === 4", timeout=60000)
        lengths = [len(chain) for chain in page.evaluate(f"() => {D}.sequence")]
        assert page.evaluate(f"() => {D}.expandedChains") == ["mol|A"]
        folded_height = page.evaluate(f"() => {D}.menuHeight")

        # unfold chain B with a real click on its bar in the desktop pop-out
        page.click("#toggle-sequence")
        canvas = page.locator("#sequence-canvas")

        def press(kind, key):
            # the pop-out scrolls: bring the button into view, then click
            # where it now is on screen
            b = page.evaluate(f"() => {D}.menuButton('{kind}', '{key}')")
            page.evaluate(
                f"""() => {{
                    const popout = document.getElementById("sequence-popout");
                    const canvas = document.getElementById("sequence-canvas");
                    popout.scrollTop = {b["v"]} * canvas.clientHeight - popout.clientHeight / 2;
                }}"""
            )
            box = canvas.bounding_box()
            page.mouse.click(box["x"] + b["u"] * box["width"], box["y"] + b["v"] * box["height"])

        press("toggleChain", "mol|B")
        assert page.evaluate(f"() => {D}.expandedChains") == ["mol|A", "mol|B"]
        assert page.evaluate(f"() => {D}.menuHeight") > folded_height

        # fold both: the menu is then shorter than with one chain open
        press("toggleChain", "mol|A")
        press("toggleChain", "mol|B")
        assert page.evaluate(f"() => {D}.expandedChains") == []
        assert page.evaluate(f"() => {D}.menuHeight") < folded_height

        # a folded chain can still be selected whole from its bar
        press("selectChain", "mol|C")
        assert len(page.evaluate(f"() => {D}.selectedKeys")) == lengths[2]
        assert page.inner_text("#selection-hud").startswith("chain C and resi 1-")
        browser.close()
    assert not errors, f"uncaught JS errors: {errors}"
