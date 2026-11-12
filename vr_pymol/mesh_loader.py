"""Load a PyMOL-exported VRML2 (.wrl) scene into VTK actors.

Batches the per-atom Sphere and per-bond Cylinder nodes (see
`vr_pymol.wrl_parser`) into two actors via `vtkGlyph3D`/manual transforms
instead of letting `vtkVRMLImporter` create one vtkActor per node -- see
`wrl_parser` for why (profiled bottleneck: the importer's own `Update()`,
~70s for 4hhb's 8782 nodes). Everything else (cartoon's baked mesh, lights,
viewpoint) still goes through `vtkVRMLImporter` on the small leftover file,
unchanged from before.
"""

import math
import tempfile

import vtk

from vr_pymol.wrl_parser import parse_wrl


def _color_array(colors_0_1, name="Colors"):
    arr = vtk.vtkUnsignedCharArray()
    arr.SetNumberOfComponents(3)
    arr.SetName(name)
    for r, g, b in colors_0_1:
        arr.InsertNextTuple3(
            round(r * 255), round(g * 255), round(b * 255)
        )
    return arr


def _direct_color_mapper(polydata):
    mapper = vtk.vtkPolyDataMapper()
    mapper.SetInputData(polydata)
    # UsePointFieldData (not UsePointData) is required for SelectColorArray's
    # name lookup to actually take effect -- UsePointData instead uses
    # whatever the *active* scalars happen to be, which for the sphere actor
    # is vtkGlyph3D's own auto-generated scale-factor array, not "Colors"
    # (checked directly: using UsePointData rendered every sphere in
    # grayscale shades tracking radius, not real per-atom color).
    mapper.SetScalarModeToUsePointFieldData()
    mapper.SelectColorArray("Colors")
    mapper.SetColorModeToDirectScalars()
    return mapper


# A headset GPU (Quest 3 in a browser, drawing every triangle twice for
# stereo) comfortably handles very roughly 0.5-1M triangles per frame. At
# 16x16 (~450 triangles per sphere) a few thousand atoms already blow past
# that -- 4HHB as spheres was ~2.1M triangles -- so large scenes drop to
# 10x8 (~140 per sphere). Small molecules keep the smoother spheres, since
# they're cheap and get viewed up close.
LARGE_SPHERE_COUNT = 2000
# Spheres this small (Angstroms) are the balls of ball-and-stick or dots,
# not space-filling atoms: a facet on them is a fraction of a stick's width,
# so 8x6 (~60 triangles) looks the same as 16x16 at an eighth of the size.
SMALL_SPHERE_RADIUS = 0.8


def _sphere_resolution(count, largest_radius):
    if largest_radius <= SMALL_SPHERE_RADIUS:
        return (8, 6)
    return (10, 8) if count > LARGE_SPHERE_COUNT else (16, 16)


def _sphere_actor(spheres):
    """One glyphed actor for every atom sphere, batched via `vtkGlyph3D`.

    Spheres are orientation-independent, so uniform per-instance scale
    (`ScaleModeToScaleByScalar`) is all that's needed on top of the source's
    unit sphere -- no orientation/anisotropic-scale complications like
    cylinders have.
    """
    points = vtk.vtkPoints()
    radii = vtk.vtkFloatArray()
    radii.SetName("radius")
    for s in spheres:
        points.InsertNextPoint(*s["center"])
        radii.InsertNextValue(s["radius"])

    poly = vtk.vtkPolyData()
    poly.SetPoints(points)
    poly.GetPointData().SetScalars(radii)
    poly.GetPointData().AddArray(_color_array(s["color"] for s in spheres))

    source = vtk.vtkSphereSource()
    source.SetRadius(1.0)
    theta, phi = _sphere_resolution(len(spheres), max(s["radius"] for s in spheres))
    source.SetThetaResolution(theta)
    source.SetPhiResolution(phi)

    glyph = vtk.vtkGlyph3D()
    glyph.SetInputData(poly)
    glyph.SetSourceConnection(source.GetOutputPort())
    glyph.SetScaleModeToScaleByScalar()
    glyph.Update()

    actor = vtk.vtkActor()
    actor.SetMapper(_direct_color_mapper(glyph.GetOutput()))
    return actor


def _cylinder_actor(cylinders):
    """One actor merging every bond cylinder, transformed individually.

    `vtkGlyph3D`'s vector-orient mode can't cleanly combine "orient by
    direction" with "anisotropic per-instance scale" here (radius vs. height
    would need two different arrays sharing the same vector slot -- checked
    empirically, not just assumed), so each cylinder gets its own exact
    `vtkTransform` instead: PyMOL's own VRML `rotation`/`translation` fields,
    replayed verbatim (`vtkTransform` defaults to PreMultiply, so calling
    `Translate` then `RotateWXYZ` composes as world = T + R*local, matching
    VRML's Transform semantics -- verified against the expected matrix
    directly before relying on it). Results are merged with
    `vtkAppendPolyData` into one real mesh, unlike a glyph mapper's
    instance-only geometry, so it survives `vtkGLTFExporter` (which was
    checked to silently emit an empty file for `vtkGlyph3DMapper` actors).
    """
    append = vtk.vtkAppendPolyData()

    for cyl in cylinders:
        source = vtk.vtkCylinderSource()
        source.SetRadius(cyl["radius"])
        source.SetHeight(cyl["height"])
        source.SetResolution(8)
        source.Update()

        transform = vtk.vtkTransform()
        transform.Translate(*cyl["center"])
        transform.RotateWXYZ(cyl["angle_deg"], *cyl["axis"])

        transform_filter = vtk.vtkTransformFilter()
        transform_filter.SetTransform(transform)
        transform_filter.SetInputData(source.GetOutput())
        transform_filter.Update()

        instance = vtk.vtkPolyData()
        instance.ShallowCopy(transform_filter.GetOutput())
        n_points = instance.GetNumberOfPoints()
        colors = vtk.vtkUnsignedCharArray()
        colors.SetNumberOfComponents(3)
        colors.SetName("Colors")
        r, g, b = cyl["color"]
        rgb = (round(r * 255), round(g * 255), round(b * 255))
        for _ in range(n_points):
            colors.InsertNextTuple3(*rgb)
        instance.GetPointData().SetScalars(colors)
        instance.GetPointData().SetActiveScalars("Colors")

        append.AddInputData(instance)

    append.Update()

    actor = vtk.vtkActor()
    actor.SetMapper(_direct_color_mapper(append.GetOutput()))
    return actor


def _bake_vertex_colors(actor):
    """Give an imported mesh actor its per-vertex colours as direct RGB.

    PyMOL writes cartoon/surface meshes with `colorPerVertex TRUE` and one
    colour per vertex. `vtkVRMLImporter` turns that into a lookup table with
    one entry per vertex, but leaves the mapper's scalar range at (0, 1) and
    the index array inactive, so every vertex resolves to the same table
    entry and `vtkGLTFExporter` writes the whole mesh in one colour. Copying
    table entry i onto vertex i as a plain "Colors" array is the same form
    the sphere and stick actors already use.
    """
    mapper = actor.GetMapper()
    polydata = mapper.GetInput() if mapper is not None else None
    table = mapper.GetLookupTable() if mapper is not None else None
    if polydata is None or not isinstance(table, vtk.vtkLookupTable):
        return
    n_points = polydata.GetNumberOfPoints()
    # Only the one-entry-per-vertex case is understood; anything else (a
    # mesh with a single material colour has no such table) is left alone.
    if n_points == 0 or table.GetNumberOfTableValues() != n_points:
        return
    polydata.GetPointData().AddArray(
        _color_array(table.GetTableValue(i)[:3] for i in range(n_points))
    )
    actor.SetMapper(_direct_color_mapper(polydata))


def load_actors(wrl_path):
    """Return the list of vtkActors baked into a PyMOL VRML2 export."""
    spheres, cylinders, leftover_text = parse_wrl(wrl_path)

    actors = []
    if spheres:
        actors.append(_sphere_actor(spheres))
    if cylinders:
        actors.append(_cylinder_actor(cylinders))

    fd, leftover_path = tempfile.mkstemp(suffix=".wrl")
    import os

    with os.fdopen(fd, "w") as f:
        f.write(leftover_text)

    importer = vtk.vtkVRMLImporter()
    importer.SetFileName(leftover_path)
    importer.Update()
    imported = list(importer.GetImportedActors())
    renderer = importer.GetRenderer()
    # Detach actors from the importer's own throwaway renderer so callers can
    # add them to a renderer of their own (VR window, desktop preview, ...).
    for actor in imported:
        renderer.RemoveActor(actor)
        _bake_vertex_colors(actor)
    actors.extend(imported)

    os.remove(leftover_path)
    return actors
