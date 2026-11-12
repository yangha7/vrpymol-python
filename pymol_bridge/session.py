"""Thin wrapper around real pymol-open-source's Python API (pymol2), headless."""

import os
import re

import pymol2


class PymolSession:
    def __init__(self):
        self._pymol = pymol2.PyMOL()
        self._pymol.start()
        self.cmd = self._pymol.cmd
        self.cmd.feedback("disable", "all", "everything")
        self._next_x = 0.0  # world-space cursor for _arrange, see add_object

    def load(self, path, object_name="mol"):
        self.cmd.delete("all")
        # PyMOL hands each newly loaded object the next carbon colour in its
        # auto_color cycle (green, cyan, light magenta, ...) and deleting
        # objects does not rewind it. This load starts a fresh scene, so the
        # cycle starts over too: the first object always gets green carbons,
        # as in a newly started PyMOL. Objects added later still cycle.
        self.cmd.set("auto_color_next", 0)
        self.cmd.load(path, object_name)
        self._next_x = 0.0
        return object_name

    def add_object(self, path, base_name=None, margin=5.0):
        """Load `path` as an ADDITIONAL object, keeping whatever's already loaded.

        Real PDB coordinate frames are independent per structure and often
        overlap near the origin by coincidence, so unlike `load` this also
        auto-arranges the new object along a simple world-space grid (via
        real `cmd.translate(..., camera=0)`, verified directly to be a
        model-space move unaffected by the current camera/view) so multiple
        objects render side by side instead of on top of each other -- real
        PyMOL itself has no auto-layout, this is this project's own UX
        addition on top of it.
        """
        if base_name is None:
            base_name = os.path.splitext(os.path.basename(path))[0]
        base_name = re.sub(r"[^A-Za-z0-9_]", "_", base_name) or "obj"
        existing = set(self.cmd.get_object_list())
        name = base_name
        n = 2
        while name in existing:
            name = f"{base_name}_{n}"
            n += 1

        self.cmd.load(path, name)
        (minx, _, minz), (maxx, _, maxz) = self.cmd.get_extent(name)
        width = maxx - minx
        cx = (minx + maxx) / 2
        cz = (minz + maxz) / 2
        dx = self._next_x + width / 2 - cx
        self.cmd.translate([dx, 0, -cz], selection=name, camera=0)
        self._next_x += width + margin
        return name

    def remove_object(self, name):
        self.cmd.delete(name)
        if not self.cmd.get_object_list():
            self._next_x = 0.0

    def list_objects(self):
        return self.cmd.get_object_list()

    def atom_count(self, selection="all"):
        return self.cmd.count_atoms(selection)

    def bond_count(self, selection="all"):
        model = self.cmd.get_model(selection)
        return len(model.bond)

    def close(self):
        self._pymol.stop()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
