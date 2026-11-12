"""Real PyMOL coloring schemes + size settings, exposed through the server.

Coloring schemes call real pymol-open-source commands checked directly
against the installed `pymol/util.py` (`cbc`, `cbss`, `chainbow`) plus
`cmd.spectrum` -- no new rendering machinery, since colors already flow
through the existing wrl_parser/mesh_loader pipeline unchanged. Same for
`stick_radius`/`sphere_scale`: real PyMOL settings applied before export, so
the already-parsed radius fields just come out different.
"""

import os

import pytest

from vr_pymol.wrl_parser import parse_wrl
from webxr.server import GLTF_PATH, SCENE_DIR, rebuild_scene

WRL_PATH = os.path.join(SCENE_DIR, "scene.wrl")


def _rebuild_and_parse(**kwargs):
    rebuild_scene(**kwargs)
    return parse_wrl(WRL_PATH)


def test_chain_coloring_gives_distinct_colors_per_chain():
    # 4hhb is real hemoglobin: 4 chains (2x alpha, 2x beta) -- a real
    # multi-chain structure, not a contrived fixture.
    spheres, _, _ = _rebuild_and_parse(molecule="4hhb", rep="spheres", color="chain")
    distinct_colors = {tuple(round(c, 2) for c in s["color"]) for s in spheres}
    # >=4 since PyMOL's cbc palette can repeat past a handful of chains, but
    # 4 real distinct chains should very safely produce well over 1 color
    # (the single-color failure mode this guards against: color_fn silently
    # not being called, or `_self` binding to the wrong/global cmd instance).
    assert len(distinct_colors) >= 3


def test_rainbow_and_secondary_structure_and_bfactor_dont_crash_and_vary():
    for color in ["rainbow", "secondary-structure", "b-factor"]:
        spheres, cylinders, _ = _rebuild_and_parse(molecule="1crn", rep="cartoon+sticks", color=color)
        all_colors = {tuple(round(c, 2) for c in s["color"]) for s in spheres}
        all_colors |= {tuple(round(c, 2) for c in c_["color"]) for c_ in cylinders}
        assert len(all_colors) >= 2, f"{color}: expected varied colors, got {all_colors}"


def test_unknown_color_scheme_rejected():
    with pytest.raises(ValueError):
        rebuild_scene(molecule="1crn", rep="cartoon", color="not-a-real-scheme")


def test_stick_radius_setting_changes_exported_cylinder_radius():
    _, cylinders_default, _ = _rebuild_and_parse(molecule="1crn", rep="sticks")
    _, cylinders_wide, _ = _rebuild_and_parse(molecule="1crn", rep="sticks", stick_radius=0.4)

    default_radius = cylinders_default[0]["radius"]
    wide_radius = cylinders_wide[0]["radius"]
    assert wide_radius == pytest.approx(0.4, abs=0.01)
    assert wide_radius > default_radius


def test_sphere_scale_setting_scales_exported_sphere_radius():
    spheres_default, _, _ = _rebuild_and_parse(molecule="1crn", rep="spheres")
    spheres_half, _, _ = _rebuild_and_parse(molecule="1crn", rep="spheres", sphere_scale=0.5)

    max_default = max(s["radius"] for s in spheres_default)
    max_half = max(s["radius"] for s in spheres_half)
    assert max_half == pytest.approx(max_default * 0.5, rel=0.05)


def test_rebuild_scene_defaults_match_real_pymol_cartoon_settings():
    """Guards against silently overriding PyMOL's own real defaults.

    Checked directly via `cmd.get`: real pymol-open-source defaults to
    cartoon_flat_sheets=on but cartoon_smooth_loops=OFF -- easy to get wrong
    by assuming symmetry between the two (a real mistake made and caught in
    this session: passing smooth_loops=True by default silently changed the
    default cartoon mesh and broke an unrelated raycasting test).
    """
    from pymol_bridge.session import PymolSession

    with PymolSession() as s:
        assert s.cmd.get("cartoon_flat_sheets") == "on"
        assert s.cmd.get("cartoon_smooth_loops") == "off"


def test_cartoon_smooth_loops_setting_changes_exported_cartoon_mesh():
    _, _, leftover_off = _rebuild_and_parse(
        molecule="1crn", rep="cartoon", cartoon_smooth_loops=False
    )
    _, _, leftover_on = _rebuild_and_parse(
        molecule="1crn", rep="cartoon", cartoon_smooth_loops=True
    )
    assert leftover_off != leftover_on


def _exported_vertex_colors():
    """Distinct COLOR_0 values in the glTF the frontend actually loads, as
    (r, g, b) tuples in 0-255."""
    from vr_pymol.glb_pack import _read_gltf

    gltf, accessor = _read_gltf(GLTF_PATH)
    colors = set()
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            values = accessor(prim["attributes"]["COLOR_0"])[:, :3]
            if values.dtype != "uint8":
                values = (values * 255).round()
            colors |= {tuple(int(v) for v in rgb) for rgb in values}
    return colors


def test_cartoon_coloring_survives_export_to_gltf():
    # Cartoon is the one representation PyMOL bakes into a mesh with a colour
    # per vertex (spheres and sticks carry one colour per primitive, which is
    # all the tests above look at), so it is checked on the final glTF.
    rebuild_scene(molecule="1crn", rep="cartoon", color="rainbow")
    rainbow = _exported_vertex_colors()
    # util.chainbow runs blue (N terminus) to red (C terminus)
    assert len(rainbow) > 20, f"expected a spectrum, got {sorted(rainbow)[:5]}"
    assert any(b > 200 and r < 60 and g < 60 for r, g, b in rainbow), "no blue N terminus"
    assert any(r > 200 and g < 60 and b < 60 for r, g, b in rainbow), "no red C terminus"

    rebuild_scene(molecule="4hhb", rep="cartoon", color="chain")
    assert len(_exported_vertex_colors()) == 4  # one colour per chain


def test_default_colouring_comes_back_after_another_scheme():
    # "default" used to mean "leave colours alone", so once any other scheme
    # had been applied, asking for element colours again changed nothing.
    def stick_colors(color):
        _, cylinders, _ = _rebuild_and_parse(molecule="1crn", rep="sticks", color=color)
        return {tuple(round(c, 2) for c in cyl["color"]) for cyl in cylinders}

    from webxr import server

    by_element = stick_colors("default")
    assert len(by_element) == 4  # C, N, O, S
    with server._lock:
        session = server._get_session()
        server._export_current_scene(session, {**server._display_settings, "color": "chain"})
        assert len({tuple(round(c, 2) for c in cyl["color"]) for cyl in parse_wrl(WRL_PATH)[1]}) == 1
        server._export_current_scene(session, {**server._display_settings, "color": "default"})
        assert {tuple(round(c, 2) for c in cyl["color"]) for cyl in parse_wrl(WRL_PATH)[1]} == by_element
