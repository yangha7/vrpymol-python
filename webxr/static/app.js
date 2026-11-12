import * as THREE from "three";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "./vendor/jsm/controls/OrbitControls.js";
import { VRButton } from "./vendor/jsm/webxr/VRButton.js";

const hud = document.getElementById("hud");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x00004d);

// Where the molecule sits in world space. In an immersive session the
// viewer's own head starts at the origin (x=z=0, local-floor height), so the
// model has to sit out in front along -Z -- at z=0 it renders inside/under
// the viewer's head. The desktop camera looks at the same spot.
const MODEL_ANCHOR = new THREE.Vector3(0, 1.2, -0.5);
const DEFAULT_CAMERA_POSITION = new THREE.Vector3(0, 1.4, 1.5);
const DEFAULT_CONTROLS_TARGET = MODEL_ANCHOR.clone();

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  1000,
);
camera.position.copy(DEFAULT_CAMERA_POSITION);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2));
const directional = new THREE.DirectionalLight(0xffffff, 1.0);
directional.position.set(1, 2, 1);
scene.add(directional);

// rotate: left-drag, zoom: scroll, pan: right-drag -- all on by default.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_CONTROLS_TARGET);
controls.update();

let currentModel = null;
let currentFit = null; // {scale, center, position} computed once per molecule, reapplied by "reset view"
const loader = new GLTFLoader();

// --- scene: one layer per representation ---
//
// Each representation (cartoon, sticks, ...) of the current molecule is
// loaded as its own glTF "layer" under one shared root, and the browser
// decides residue by residue which part of each layer is drawn. That is what
// lets part of a molecule be sticks and the rest cartoon without asking
// PyMOL to re-export, so it also works in the static build where there is
// no PyMOL to ask. Layers are fetched the first time something is shown in
// them.
//
// The root (`currentModel`) is what gets fitted, grabbed and zoomed. It is
// only replaced when the set of loaded objects changes, so changing
// representation or colour no longer resets the view.

function fitToAtoms(atoms) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const atom of atoms) box.expandByPoint(point.fromArray(atom.coord));
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2, 2, 2));
  box.expandByScalar(2); // Angstroms: about one atom radius, so spheres fit too
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const targetSize = 0.3; // metres: a comfortable hand-held size
  const scale = targetSize / Math.max(size.x, size.y, size.z);
  return {
    scale,
    // model-local, so it stays valid as the zoom pivot however the model is
    // later moved, rotated, scaled or reparented.
    center,
    position: new THREE.Vector3(
      MODEL_ANCHOR.x - center.x * scale,
      MODEL_ANCHOR.y - center.y * scale,
      MODEL_ANCHOR.z - center.z * scale,
    ),
  };
}

function applyFit(object, fit) {
  // The fit position assumes an unrotated model, so the rotation a grab
  // left behind has to go too, or "reset view" would put the molecule off
  // to one side of where it belongs.
  object.quaternion.identity();
  object.scale.setScalar(fit.scale);
  object.position.copy(fit.position);
}

function startNewModel(atoms) {
  if (currentModel) currentModel.parent?.remove(currentModel);
  // Everything that hung off the old model goes with it.
  grabbers.length = 0;
  twoHand = null;
  measurementGroup = null;
  pendingPicks = [];
  measurements = [];
  measurementLabels = [];
  hoverMarker = null;
  hoverAtom = null;
  measureHud.textContent = " ";
  selectionMarkers = null;
  hbondDashes = null;
  shownHbonds.clear();
  currentModel = new THREE.Group();
  currentModel.name = "molecule";
  currentFit = fitToAtoms(atoms);
  applyFit(currentModel, currentFit);
  scene.add(currentModel);
}

let availableReps = []; // representations this build can draw, in menu order
const shownByRep = new Map(); // rep -> Set of residue keys drawn in that rep
// Colouring scheme per residue: `baseScheme` for the whole scene, with
// per-residue exceptions. A scheme's colours are PyMOL's, baked into the
// layer file, so residues in different schemes are drawn from different
// layers of the same representation -- hence a layer per (rep, scheme).
let baseScheme = "default";
const residueScheme = new Map(); // residue key -> scheme, where it differs from baseScheme
const layers = new Map(); // "rep|scheme" -> {rep, scheme, state: "loading"|"ready"|"missing", root, parts}

function schemeOfKey(key) {
  return residueScheme.get(key) ?? baseScheme;
}

function layersOfRep(rep) {
  return Array.from(layers.values()).filter((layer) => layer.rep === rep);
}
let staleLayers = []; // previous scene's layers, kept on screen until the new ones arrive
let sceneRequestInFlight = false;
// True from the moment a scene change (molecule, colouring, a setting) is
// queued until its reload starts. Representation toggles made meanwhile are
// remembered but fetch nothing: the layer they would fetch belongs to the
// scene that is about to be replaced.
let sceneChangePending = false;

function disposeLayer(layer) {
  if (!layer.root) return;
  layer.root.parent?.remove(layer.root);
  layer.root.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose?.();
  });
}

// Spatial hash over atoms, for "which residue is this triangle part of".
const GRID_CELL = 4; // Angstroms
function gridKey(ix, iy, iz) {
  return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
}

function buildAtomGrid(atoms) {
  const grid = { atoms, cells: new Map() };
  atoms.forEach((atom, i) => {
    const key = gridKey(
      Math.floor(atom.coord[0] / GRID_CELL),
      Math.floor(atom.coord[1] / GRID_CELL),
      Math.floor(atom.coord[2] / GRID_CELL),
    );
    if (!grid.cells.has(key)) grid.cells.set(key, []);
    grid.cells.get(key).push(i);
  });
  return grid;
}

// Calls visit(atom, squaredDistance) for every atom in the cells within
// `reach` cells of the point.
function visitNearbyAtoms(grid, x, y, z, reach, visit) {
  const cx = Math.floor(x / GRID_CELL);
  const cy = Math.floor(y / GRID_CELL);
  const cz = Math.floor(z / GRID_CELL);
  for (let ix = cx - reach; ix <= cx + reach; ix++) {
    for (let iy = cy - reach; iy <= cy + reach; iy++) {
      for (let iz = cz - reach; iz <= cz + reach; iz++) {
        const cell = grid.cells.get(gridKey(ix, iy, iz));
        if (!cell) continue;
        for (const i of cell) {
          const atom = grid.atoms[i];
          const dx = atom.coord[0] - x;
          const dy = atom.coord[1] - y;
          const dz = atom.coord[2] - z;
          visit(atom, dx * dx + dy * dy + dz * dz);
        }
      }
    }
  }
}

function nearestAtom(grid, x, y, z) {
  let best = null;
  let bestDist = Infinity;
  const visit = (atom, dist) => {
    if (dist < bestDist) {
      best = atom;
      bestDist = dist;
    }
  };
  // The nearest atom in the searched block of cells is the true nearest
  // only if it is closer than the block's margin; widen until that holds.
  for (const reach of [1, 2, 4]) {
    visitNearbyAtoms(grid, x, y, z, reach, visit);
    if (bestDist <= (reach * GRID_CELL) ** 2) return best;
  }
  for (const atom of grid.atoms) {
    visit(atom, (atom.coord[0] - x) ** 2 + (atom.coord[1] - y) ** 2 + (atom.coord[2] - z) ** 2);
  }
  return best;
}

// PyMOL's van der Waals radii in Angstroms, for telling whose sphere a
// triangle of the spheres layer belongs to.
const VDW_RADIUS = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8, F: 1.47 };
const VDW_DEFAULT = 1.8;

let atomGrids = null; // built on demand for the current atom table

function getAtomGrids() {
  if (!atomGrids) {
    // Cartoon and ribbon run through the C-alphas, so their triangles are
    // matched against C-alphas only: cuts then fall midway between residues
    // instead of wherever a side chain happens to come close. Residues with
    // no C-alpha (nucleic acids, ligands) keep all their atoms.
    const hasAlphaCarbon = new Set(
      sceneAtoms.filter((atom) => atom.name === "CA").map((atom) => residueKey(atom)),
    );
    atomGrids = {
      all: buildAtomGrid(sceneAtoms),
      backbone: buildAtomGrid(
        sceneAtoms.filter((atom) => atom.name === "CA" || !hasAlphaCarbon.has(residueKey(atom))),
      ),
    };
  }
  return atomGrids;
}

// Returns a function (x, y, z, nx, ny, nz) -> residue ordinal for a
// triangle with that centroid and unit normal, in atom coordinates.
function residueAssigner(rep) {
  const grids = getAtomGrids();
  const ordinalOf = (atom) => (atom ? residueByKey.get(residueKey(atom)).ordinal : -1);
  if (rep === "cartoon" || rep === "ribbon") {
    return (x, y, z) => ordinalOf(nearestAtom(grids.backbone, x, y, z));
  }
  if (rep !== "spheres") {
    return (x, y, z) => ordinalOf(nearestAtom(grids.all, x, y, z));
  }
  // Space-filling spheres overlap, so "nearest atom centre" would hand the
  // part of one atom's sphere that lies inside its neighbour to the
  // neighbour, leaving a hole when only one of the two is shown. The owner
  // is instead the atom whose sphere the triangle actually lies on: at its
  // radius from the centre, facing straight out from it.
  const sphereScale = Number(document.getElementById("sphere-scale").value) || 1;
  return (x, y, z, nx, ny, nz) => {
    let best = null;
    let bestCost = Infinity;
    visitNearbyAtoms(grids.all, x, y, z, 1, (atom, dist2) => {
      const dist = Math.sqrt(dist2) || 1e-6;
      const radius = (VDW_RADIUS[atom.element] || VDW_DEFAULT) * sphereScale;
      const outward =
        ((x - atom.coord[0]) * nx + (y - atom.coord[1]) * ny + (z - atom.coord[2]) * nz) / dist;
      const cost = Math.abs(dist - radius) + (1 - Math.abs(outward)); // Angstroms
      if (cost < bestCost) {
        best = atom;
        bestCost = cost;
      }
    });
    return ordinalOf(best || nearestAtom(grids.all, x, y, z));
  };
}

// Work out which residue every triangle of a freshly loaded layer belongs
// to, and give each mesh an index buffer that can be rewritten to draw any
// subset of them.
function buildLayerParts(root, rep) {
  const assign = residueAssigner(rep);
  const parts = [];
  const vertex = new THREE.Vector3();
  root.updateMatrixWorld(true); // not yet in the scene, so "world" is the atom frame
  root.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry;
    const position = geometry.attributes.position;
    const coords = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      coords[3 * i] = vertex.x;
      coords[3 * i + 1] = vertex.y;
      coords[3 * i + 2] = vertex.z;
    }
    let source;
    if (geometry.index) {
      source = geometry.index.array;
    } else {
      source = new Uint32Array(position.count);
      for (let i = 0; i < source.length; i++) source[i] = i;
    }
    const triangleCount = Math.floor(source.length / 3);
    const owner = new Int32Array(triangleCount);
    for (let t = 0; t < triangleCount; t++) {
      const a = 3 * source[3 * t];
      const b = 3 * source[3 * t + 1];
      const c = 3 * source[3 * t + 2];
      const ux = coords[b] - coords[a];
      const uy = coords[b + 1] - coords[a + 1];
      const uz = coords[b + 2] - coords[a + 2];
      const vx = coords[c] - coords[a];
      const vy = coords[c + 1] - coords[a + 1];
      const vz = coords[c + 2] - coords[a + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      owner[t] = assign(
        (coords[a] + coords[b] + coords[c]) / 3,
        (coords[a + 1] + coords[b + 1] + coords[c + 1]) / 3,
        (coords[a + 2] + coords[b + 2] + coords[c + 2]) / 3,
        nx,
        ny,
        nz,
      );
    }
    // One reusable index buffer per mesh, rewritten in place and trimmed
    // with drawRange, so toggling visibility never allocates GPU buffers.
    const index = new THREE.BufferAttribute(new source.constructor(source.length), 1);
    geometry.setIndex(index);
    // For painting: which residue each vertex belongs to (a vertex shared
    // across a residue boundary goes to whichever triangle claims it
    // first), and the colours PyMOL gave it, to paint over and restore.
    const vertexOwner = new Int32Array(position.count).fill(-1);
    for (let t = 0; t < triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = source[3 * t + k];
        if (vertexOwner[v] < 0) vertexOwner[v] = owner[t];
      }
    }
    const color = geometry.attributes.color;
    parts.push({
      object,
      source,
      owner,
      index,
      vertexOwner,
      baseColors: color ? color.array.slice() : null,
      painted: false,
      ghosts: [], // see-through copies of the mesh, one per opacity level in use
      visibleTriangles: 0,
      transparentTriangles: 0,
    });
  });
  return parts;
}

// A see-through copy of a mesh: the same vertex buffers, its own index
// buffer and a transparent material. Triangles of see-through residues are
// drawn by this copy and left out of the opaque original.
function makeGhost(part, level) {
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(part.object.geometry.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  const index = new THREE.BufferAttribute(new part.source.constructor(part.source.length), 1);
  geometry.setIndex(index);
  const material = part.object.material.clone();
  material.transparent = true;
  material.opacity = OPACITY_LEVELS[level];
  material.depthWrite = false; // or it would hide what is behind it after all
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${part.object.name}-seethrough-${level}`;
  mesh.position.copy(part.object.position);
  mesh.quaternion.copy(part.object.quaternion);
  mesh.scale.copy(part.object.scale);
  part.object.parent.add(mesh);
  return { mesh, index };
}

function paintPart(part, colorByOrdinal) {
  if (!part.baseColors || (!colorByOrdinal && !part.painted)) return;
  const attribute = part.object.geometry.attributes.color;
  attribute.array.set(part.baseColors);
  if (colorByOrdinal) {
    for (let v = 0; v < part.vertexOwner.length; v++) {
      const color = colorByOrdinal[part.vertexOwner[v]];
      // glTF vertex colours are linear, as are THREE.Color's components
      if (color) attribute.setXYZ(v, color.r, color.g, color.b);
    }
  }
  attribute.needsUpdate = true;
  part.painted = Boolean(colorByOrdinal);
}

// Redraw one layer from the current state: which residues it draws (shown
// in its representation and coloured by its scheme), which of them are
// see-through, and which are painted.
function applyLayerMask(layer) {
  const mask = new Uint8Array(allResidues.length);
  for (const key of shownByRep.get(layer.rep)) {
    const residue = residueByKey.get(key);
    if (residue && schemeOfKey(key) === layer.scheme) mask[residue.ordinal] = 1;
  }
  const level = new Uint8Array(allResidues.length);
  for (const [key, value] of residueOpacity) {
    const residue = residueByKey.get(key);
    if (residue) level[residue.ordinal] = value;
  }
  let colorByOrdinal = null;
  if (residueColor.size > 0) {
    colorByOrdinal = new Array(allResidues.length);
    for (const [key, color] of residueColor) {
      const residue = residueByKey.get(key);
      if (residue) colorByOrdinal[residue.ordinal] = color;
    }
  }
  for (const part of layer.parts) {
    // one output per opacity level: [opaque, ghost 1, ghost 2]
    const outputs = [part.index, part.ghosts[1]?.index, part.ghosts[2]?.index];
    const counts = [0, 0, 0];
    for (let t = 0; t < part.owner.length; t++) {
      const ordinal = part.owner[t];
      if (ordinal < 0 || !mask[ordinal]) continue;
      const l = level[ordinal];
      if (l > 0 && !outputs[l]) {
        part.ghosts[l] = makeGhost(part, l);
        outputs[l] = part.ghosts[l].index;
      }
      const out = outputs[l].array;
      out[counts[l]++] = part.source[3 * t];
      out[counts[l]++] = part.source[3 * t + 1];
      out[counts[l]++] = part.source[3 * t + 2];
    }
    const meshes = [part.object, part.ghosts[1]?.mesh, part.ghosts[2]?.mesh];
    meshes.forEach((mesh, l) => {
      if (!mesh) return;
      outputs[l].needsUpdate = true;
      mesh.geometry.setDrawRange(0, counts[l]);
      mesh.visible = counts[l] > 0;
    });
    part.visibleTriangles = (counts[0] + counts[1] + counts[2]) / 3;
    part.transparentTriangles = (counts[1] + counts[2]) / 3;
    paintPart(part, colorByOrdinal);
  }
}

function layerUrl(rep, scheme) {
  if (staticManifest) {
    return staticManifest.files[`${sceneObjects.mol}|${rep}|${scheme}`] || null;
  }
  // cache-bust: the server re-exports on every request
  return `/api/layer?rep=${encodeURIComponent(rep)}&color=${encodeURIComponent(scheme)}&t=${Date.now()}`;
}

function anyLayerLoading() {
  return Array.from(layers.values()).some((layer) => layer.state === "loading");
}

// The live server exports one thing at a time on a single thread, so while
// it is working the controls show as busy instead of quietly queueing more.
function refreshBusy() {
  setControlsBusy(!staticManifest && (sceneRequestInFlight || anyLayerLoading()));
}

function layerSettled() {
  if (!anyLayerLoading()) {
    staleLayers.forEach(disposeLayer);
    staleLayers = [];
  }
  refreshBusy();
  requestSequenceRedraw();
}

// A representation with nothing to draw for this molecule (cartoon of a
// small molecule, nonbonded of a protein with no waters): switch it back
// off, and if that leaves the scene empty fall back to sticks.
function layerMissing(layer) {
  layer.state = "missing";
  shownByRep.get(layer.rep).clear();
  hud.textContent = `${layer.rep}: nothing to draw for this molecule`;
  const nothingShown = availableReps.every((rep) => shownByRep.get(rep).size === 0);
  const sticksMissing = layersOfRep("sticks").some((other) => other.state === "missing");
  if (nothingShown && availableReps.includes("sticks") && !sticksMissing) {
    allResidues.forEach((residue) => shownByRep.get("sticks").add(residue.key));
  }
  layerSettled();
  representationChanged();
}

function loadLayer(rep, scheme) {
  const key = `${rep}|${scheme}`;
  const layer = { rep, scheme, state: "loading", root: null, parts: [] };
  layers.set(key, layer);
  const url = layerUrl(rep, scheme);
  if (!url) {
    layerMissing(layer);
    return;
  }
  hud.textContent = `loading ${url} ...`;
  loader.load(
    url,
    (gltf) => {
      // The scene moved on while this downloaded (baked files can be
      // several MB) -- don't let a stale layer into the new scene.
      if (layers.get(key) !== layer) return;
      layer.root = gltf.scene;
      layer.root.name = `layer-${rep}-${scheme}`;
      layer.parts = buildLayerParts(layer.root, rep);
      currentModel.add(layer.root);
      layer.state = "ready";
      applyLayerMask(layer);
      hud.textContent = `loaded ${url}`;
      layerSettled();
    },
    undefined,
    (error) => {
      if (layers.get(key) !== layer) return;
      console.warn(`no ${rep} layer:`, error);
      layerMissing(layer);
    },
  );
}

// Bring what is drawn in line with the state: fetch layers that are now
// needed, re-mask the ones already loaded, retire the ones no residue uses.
function ensureLayers() {
  const needed = new Map(); // "rep|scheme" -> [rep, scheme]
  for (const rep of availableReps) {
    for (const key of shownByRep.get(rep)) {
      const scheme = schemeOfKey(key);
      needed.set(`${rep}|${scheme}`, [rep, scheme]);
    }
  }
  for (const [key, layer] of layers) {
    if (needed.has(key)) continue;
    // kept on screen (with nothing left to draw, or its last look) until
    // whatever replaces it has arrived, see layerSettled
    if (layer.state === "ready") applyLayerMask(layer);
    staleLayers.push(layer);
    layers.delete(key);
  }
  for (const [key, [rep, scheme]] of needed) {
    const layer = layers.get(key);
    if (!layer) {
      if (!sceneChangePending) loadLayer(rep, scheme);
    } else if (layer.state === "ready") {
      applyLayerMask(layer);
    }
  }
  layerSettled();
}

// Colour by a scheme: the selection, or the whole scene when nothing is
// selected (which also forgets every per-residue exception).
function setScheme(scheme) {
  if (selectedKeys.size === 0) {
    baseScheme = scheme;
    residueScheme.clear();
  } else {
    for (const key of selectedKeys) {
      if (scheme === baseScheme) residueScheme.delete(key);
      else residueScheme.set(key, scheme);
    }
  }
  colorSelect.value = baseScheme;
  representationChanged();
}

function representationChanged() {
  pickableAtoms = null; // what a ray can pick follows what is drawn
  ensureLayers();
  syncRepControls();
  requestSequenceRedraw();
}

// Show and hide act on the selection, or on everything when nothing is
// selected -- the same rule as PyMOL's "show sticks" with and without `sele`.
function targetResidues() {
  return selectedKeys.size > 0 ? selectedResidues() : allResidues;
}

function setRepShown(rep, residues, shown) {
  const keys = shownByRep.get(rep);
  for (const residue of residues) {
    if (shown) keys.add(residue.key);
    else keys.delete(residue.key);
  }
  representationChanged();
}

function hideEverything(residues) {
  for (const keys of shownByRep.values()) {
    for (const residue of residues) keys.delete(residue.key);
  }
  representationChanged();
  if (shownHbonds.size > 0) setHbondsShown(residues, false);
}

// Reload the scene after the molecule, objects, frame, colouring or an
// export setting changed: new atom table, new layers. The view and what is
// shown where are kept when the objects are the same ones as before.
let sceneEpoch = 0;
async function syncScene() {
  const epoch = ++sceneEpoch;
  sceneChangePending = false;
  staleLayers.push(...layers.values());
  layers.clear();
  let atoms;
  let objects;
  if (staticManifest) {
    const molecule = moleculeSelect.value;
    atoms = await loadStaticAtoms(molecule);
    objects = { mol: molecule };
    if (epoch !== sceneEpoch) return;
  } else {
    const data = await (await fetch("/api/atoms")).json();
    if (epoch !== sceneEpoch || !data.ok) return; // a newer sync has taken over
    atoms = data.atoms;
    objects = Object.fromEntries(data.objects.map((o) => [o.name, o.molecule]));
  }
  if (!currentModel || JSON.stringify(objects) !== JSON.stringify(sceneObjects)) {
    startNewModel(atoms);
  }
  setSceneAtoms(atoms, objects);
  representationChanged();
  refreshHbonds();
}

function resetView() {
  if (currentModel && currentFit) {
    // model may currently be parented to a controller (mid-grab) -- always
    // reattach to the scene first so the fit position below is world-space.
    scene.attach(currentModel);
    applyFit(currentModel, currentFit);
    // so a ray cast before the next rendered frame sees the model where
    // it now is, not where it was
    currentModel.updateMatrixWorld(true);
  }
  grabbers.length = 0;
  twoHand = null;
  camera.position.copy(DEFAULT_CAMERA_POSITION);
  controls.target.copy(DEFAULT_CONTROLS_TARGET);
  controls.update();
}

// --- M7: controller grab / rotate / two-handed scale ---
//
// Grabbing is on the grip ("squeeze") button; the trigger is for selecting
// (see "trigger: select" below).
//
// Single-hand grab: `controller.attach(currentModel)` reparents the model
// under the controller *preserving its current world transform* (three.js
// computes the new local transform from controller.matrixWorld), so from
// then on the model simply inherits the controller's own tracked pose each
// frame for free -- no per-frame math needed for one-handed move/rotate.
//
// Two-handed grab: three.js has no built-in helper for this, so when a
// second controller grabs, the model is detached back to the scene (world
// space) and each frame its scale/rotation/position are driven explicitly
// from the vector between the two controllers -- distance ratio for scale,
// twist of that vector for a rotation delta, midpoint delta for translation.
// This mirrors the Unity project's two-handed XRGrabInteractable scaling.

function buildControllerRay() {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x66ccff }));
  line.name = "controller-ray";
  line.scale.z = 5;
  return line;
}

const controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
controllers.forEach((controller) => {
  controller.add(buildControllerRay());
  controller.addEventListener("squeezestart", onGrabStart);
  controller.addEventListener("squeezeend", onGrabEnd);
  scene.add(controller);
});

const raycaster = new THREE.Raycaster();
const grabbers = []; // controllers currently grabbing currentModel, in grab order
let twoHand = null; // {startDistance, startScale, startMidpoint, startPosition, startAngle, startQuaternion}

function controllerModelHit(controller) {
  if (!currentModel) return null;
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
  return raycaster.intersectObject(currentModel, true)[0] || null;
}

function midpoint(a, b) {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

function controllerPositions() {
  return grabbers.map((c) => new THREE.Vector3().setFromMatrixPosition(c.matrixWorld));
}

function onGrabStart(event) {
  const controller = event.target;
  if (grabbers.includes(controller) || !controllerModelHit(controller)) return;
  grabbers.push(controller);

  if (grabbers.length === 1) {
    controller.attach(currentModel);
  } else if (grabbers.length === 2) {
    // switch from one-hand-attached to two-hand explicit tracking: detach
    // back to world space first so the model isn't fighting the controller
    // parent transform while we drive it manually below.
    scene.attach(currentModel);
    const [posA, posB] = controllerPositions();
    twoHand = {
      startDistance: posA.distanceTo(posB) || 1,
      startScale: currentModel.scale.x,
      startMidpoint: midpoint(posA, posB),
      startPosition: currentModel.position.clone(),
      startAngle: Math.atan2(posB.z - posA.z, posB.x - posA.x),
      startQuaternion: currentModel.quaternion.clone(),
    };
  }
}

function onGrabEnd(event) {
  const controller = event.target;
  const index = grabbers.indexOf(controller);
  if (index === -1) return;
  grabbers.splice(index, 1);
  twoHand = null;

  if (grabbers.length === 1) {
    // one controller still grabbing: resume one-hand attach from wherever
    // the model currently sits (no snap -- attach preserves world transform).
    grabbers[0].attach(currentModel);
  } else if (currentModel && currentModel.parent !== scene) {
    scene.attach(currentModel);
  }
}

function updateTwoHandGrab() {
  if (!twoHand || grabbers.length !== 2) return;
  const [posA, posB] = controllerPositions();
  const distance = posA.distanceTo(posB) || 1;
  const scale = twoHand.startScale * (distance / twoHand.startDistance);
  currentModel.scale.setScalar(scale);

  const angle = Math.atan2(posB.z - posA.z, posB.x - posA.x);
  const deltaRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    angle - twoHand.startAngle,
  );
  currentModel.quaternion.multiplyQuaternions(deltaRotation, twoHand.startQuaternion);

  const currentMidpoint = midpoint(posA, posB);
  const midpointDelta = new THREE.Vector3().subVectors(currentMidpoint, twoHand.startMidpoint);
  currentModel.position.addVectors(twoHand.startPosition, midpointDelta);
}

// --- thumbstick zoom ---
//
// Pushing either controller's thumbstick forward/back grows/shrinks the
// model about its own centre, so it stays where it is instead of sliding
// away from the viewer. It works with the model free or held in one hand
// (the pivot math is done in the model's parent space, and uniform scaling
// about a point is the same in any frame); during a two-handed grab the
// hands own the scale, so the stick is ignored.

const ZOOM_DEADZONE = 0.15; // ignore stick drift around centre
const ZOOM_RATE = 1.0; // e-folds per second at full deflection (2x in ~0.7 s)
const ZOOM_MIN_RATIO = 0.05; // limits relative to the fitted size
const ZOOM_MAX_RATIO = 50;

function zoomModel(factor) {
  if (!currentModel || !currentFit || twoHand || factor === 1) return;
  const current = currentModel.scale.x;
  // Limits only stop further stick zoom; a size already outside them (from a
  // two-handed stretch) is left alone rather than snapped back.
  const target =
    factor > 1
      ? Math.min(current * factor, Math.max(current, currentFit.scale * ZOOM_MAX_RATIO))
      : Math.max(current * factor, Math.min(current, currentFit.scale * ZOOM_MIN_RATIO));
  const k = target / current;
  if (k === 1) return;
  currentModel.updateMatrix();
  const pivot = currentFit.center.clone().applyMatrix4(currentModel.matrix);
  currentModel.position.sub(pivot).multiplyScalar(k).add(pivot);
  currentModel.scale.multiplyScalar(k);
}

function stickZoomFactor(stickY, dt) {
  const magnitude = Math.abs(stickY);
  if (magnitude < ZOOM_DEADZONE) return 1;
  const amount = (magnitude - ZOOM_DEADZONE) / (1 - ZOOM_DEADZONE);
  // WebXR gamepads report forward as negative Y: forward zooms in.
  return Math.exp(-Math.sign(stickY) * amount * ZOOM_RATE * dt);
}

function thumbstickY(session) {
  let y = 0;
  for (const source of session.inputSources) {
    const axes = source.gamepad?.axes;
    if (!axes || axes.length < 2) continue;
    // "xr-standard" layout: axes 0/1 are the touchpad, 2/3 the thumbstick.
    const value = axes.length >= 4 ? axes[3] : axes[1];
    if (Math.abs(value) > Math.abs(y)) y = value;
  }
  return y;
}

// --- pointer tools: select, and measure distance / angle / dihedral ---
//
// One tool is active at a time and decides what the trigger (or a desktop
// click) does on the molecule: "select" toggles a residue (further down),
// the three measuring tools collect atoms -- 2, 3 or 4 -- and then draw the
// measurement with its value. Everything is computed from the atom table in
// the browser, so it works the same with the live server and the static
// build; the numbers are the ones PyMOL's get_distance / get_angle /
// get_dihedral give for the same atoms.

const TOOL_ATOM_COUNT = { distance: 2, angle: 3, dihedral: 4 };
const toolSelect = document.getElementById("tool-mode");
const measureHud = document.getElementById("measure-hud");
const clearMeasurementsButton = document.getElementById("clear-measurements");
const MARKER_RADIUS = 0.3; // Angstroms -- small relative to a ~1.5A atom radius
const MEASURE_LINE_RADIUS = 0.06; // Angstroms
const PENDING_COLOR = 0xffee00;
const DONE_COLOR = 0x00e5ff;
const HOVER_COLOR = 0xffffff;
const LABEL_HEIGHT = 0.022; // metres, whatever the zoom: labels stay readable

let toolMode = "select";
let pendingPicks = []; // [{atom, marker}] collected so far for the active tool
let measurements = []; // [{kind, atoms, value, text}]
let measurementLabels = []; // sprites, rescaled every frame to LABEL_HEIGHT
let measurementGroup = null; // THREE.Group, child of currentModel
let hoverAtom = null; // atom under a controller's ray while a measuring tool is active
let hoverMarker = null;
let pickableAtoms = null; // [{atom, radius}] built on demand, see getPickableAtoms

function ensureMeasurementGroup() {
  if (!currentModel) return null;
  if (!measurementGroup || measurementGroup.parent !== currentModel) {
    measurementGroup = new THREE.Group();
    measurementGroup.name = "measurements";
    currentModel.add(measurementGroup);
  }
  return measurementGroup;
}

// depthTest off + high renderOrder throughout: a marker at an atom's exact
// centre is otherwise hidden inside that atom's own sphere, and a line
// between two atoms runs straight through the molecule. Real PyMOL draws
// its own selection indicators and measurement dashes the same way.
function overlayMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false });
}

function addMarker(coord, color) {
  const marker = new THREE.Mesh(new THREE.SphereGeometry(MARKER_RADIUS, 12, 12), overlayMaterial(color));
  marker.position.fromArray(coord);
  marker.renderOrder = 999;
  marker.raycast = () => {}; // never the thing a pointing ray hits
  ensureMeasurementGroup().add(marker);
  return marker;
}

function addRod(coordA, coordB) {
  const a = new THREE.Vector3().fromArray(coordA);
  const b = new THREE.Vector3().fromArray(coordB);
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(MEASURE_LINE_RADIUS, MEASURE_LINE_RADIUS, a.distanceTo(b), 6, 1, true),
    overlayMaterial(DONE_COLOR),
  );
  rod.position.addVectors(a, b).multiplyScalar(0.5);
  // a cylinder's axis is +Y; turn it onto the a -> b direction
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
  rod.renderOrder = 999;
  rod.raycast = () => {};
  ensureMeasurementGroup().add(rod);
  return rod;
}

function addLabel(text, coord) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 40px monospace";
  const width = Math.min(250, ctx.measureText(text).width + 24);
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect((256 - width) / 2, 4, width, 56);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 34, 240);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  label.position.fromArray(coord);
  label.renderOrder = 1000;
  label.raycast = () => {};
  ensureMeasurementGroup().add(label);
  measurementLabels.push(label);
  return label;
}

// Labels live in the model's frame (Angstroms) so they ride along with it,
// but are held at a fixed real-world size so zooming out doesn't shrink
// them to nothing.
function updateLabelScales() {
  if (measurementLabels.length === 0 || !currentModel) return;
  const height = LABEL_HEIGHT / currentModel.getWorldScale(new THREE.Vector3()).x;
  for (const label of measurementLabels) label.scale.set(height * 4, height, 1);
}

function describeAtom(atom) {
  return `${atom.name} (${atom.resn}${atom.resi}${atom.chain ? "/" + atom.chain : ""})`;
}

// Distance in Angstroms, angle (at the middle atom) and dihedral in degrees.
// The dihedral follows the IUPAC sign convention, as PyMOL's get_dihedral.
function measureValue(kind, atoms) {
  const [a, b, c, d] = atoms.map((atom) => new THREE.Vector3().fromArray(atom.coord));
  if (kind === "distance") return a.distanceTo(b);
  if (kind === "angle") return THREE.MathUtils.radToDeg(a.sub(b).angleTo(c.sub(b)));
  const b1 = b.clone().sub(a);
  const b2 = c.clone().sub(b);
  const b3 = d.clone().sub(c);
  const n1 = b1.clone().cross(b2);
  const n2 = b2.clone().cross(b3);
  return THREE.MathUtils.radToDeg(Math.atan2(b2.length() * b1.dot(n2), n1.dot(n2)));
}

function completeMeasurement(kind, picks) {
  const atoms = picks.map((pick) => pick.atom);
  const value = measureValue(kind, atoms);
  const text = kind === "distance" ? `${value.toFixed(2)} Å` : `${value.toFixed(1)}°`;
  picks.forEach((pick) => pick.marker.material.color.setHex(DONE_COLOR));
  for (let i = 0; i + 1 < atoms.length; i++) addRod(atoms[i].coord, atoms[i + 1].coord);
  // the label sits where the quantity lives: mid-bond for a distance, on
  // the middle atom for an angle, on the central bond for a dihedral
  const anchor = new THREE.Vector3();
  if (kind === "angle") {
    anchor.fromArray(atoms[1].coord);
  } else {
    const [p, q] = kind === "distance" ? atoms : [atoms[1], atoms[2]];
    anchor.fromArray(p.coord).add(new THREE.Vector3().fromArray(q.coord)).multiplyScalar(0.5);
  }
  addLabel(text, anchor.toArray());
  measurements.push({ kind, atoms, value, text });
  measureHud.textContent = `${atoms.map(describeAtom).join(" – ")}: ${text}`;
  requestSequenceRedraw();
}

// Feed one atom to the active measuring tool.
function addPick(atom) {
  const kind = TOOL_ATOM_COUNT[toolMode] ? toolMode : "distance";
  if (pendingPicks.some((pick) => pick.atom === atom)) {
    measureHud.textContent = `${describeAtom(atom)} is already picked -- pick a different atom`;
    return;
  }
  pendingPicks.push({ atom, marker: addMarker(atom.coord, PENDING_COLOR) });
  const needed = TOOL_ATOM_COUNT[kind];
  if (pendingPicks.length === needed) {
    const picks = pendingPicks;
    pendingPicks = [];
    completeMeasurement(kind, picks);
  } else {
    measureHud.textContent =
      `${kind}: ${pendingPicks.map((pick) => describeAtom(pick.atom)).join(" – ")}` +
      ` -- pick atom ${pendingPicks.length + 1} of ${needed}`;
    requestSequenceRedraw();
  }
}

function dropPendingPicks() {
  for (const pick of pendingPicks) pick.marker.parent?.remove(pick.marker);
  pendingPicks = [];
}

function clearMeasurements() {
  if (measurementGroup) {
    measurementGroup.parent?.remove(measurementGroup);
    measurementGroup = null;
  }
  pendingPicks = [];
  measurements = [];
  measurementLabels = [];
  hoverMarker = null;
  measureHud.textContent = " ";
  requestSequenceRedraw();
}

function setTool(mode) {
  if (mode === toolMode) return;
  toolMode = mode;
  toolSelect.value = mode;
  dropPendingPicks(); // half a distance can't be finished as an angle
  setHoverAtom(null);
  measureHud.textContent = TOOL_ATOM_COUNT[mode] ? `${mode}: pick ${TOOL_ATOM_COUNT[mode]} atoms` : " ";
  requestSequenceRedraw();
}

// Atoms a ray can pick, each with the radius it presents: its sphere when
// drawn as spheres, a slim target on sticks and lines, and for residues
// drawn only as cartoon just the C-alpha -- so the ray picks what can be
// seen, never an atom of a hidden residue.
function getPickableAtoms() {
  if (pickableAtoms) return pickableAtoms;
  const sphereScale = Number(document.getElementById("sphere-scale").value) || 1;
  const shown = (rep, residue) => shownByRep.get(rep)?.has(residue.key);
  pickableAtoms = [];
  for (const residue of allResidues) {
    const reps = availableReps.filter((rep) => shown(rep, residue));
    if (reps.length === 0) continue;
    const backboneOnly = reps.every((rep) => rep === "cartoon" || rep === "ribbon");
    const hasAlphaCarbon = residue.atoms.some((atom) => atom.name === "CA");
    for (const atom of residue.atoms) {
      if (backboneOnly && hasAlphaCarbon && atom.name !== "CA") continue;
      let radius = backboneOnly ? 1.5 : 0.7;
      if (reps.includes("spheres") || reps.includes("surface")) {
        radius = (VDW_RADIUS[atom.element] || VDW_DEFAULT) * sphereScale;
      }
      pickableAtoms.push({ atom, radius });
    }
  }
  return pickableAtoms;
}

// The first pickable atom a world-space ray runs into, or null.
function atomOnRay(origin, direction) {
  if (!currentModel) return null;
  const toModel = currentModel.matrixWorld.clone().invert();
  const start = origin.clone().applyMatrix4(toModel);
  const along = origin.clone().add(direction).applyMatrix4(toModel).sub(start).normalize();
  let best = null;
  let bestEntry = Infinity;
  for (const { atom, radius } of getPickableAtoms()) {
    const dx = atom.coord[0] - start.x;
    const dy = atom.coord[1] - start.y;
    const dz = atom.coord[2] - start.z;
    const t = dx * along.x + dy * along.y + dz * along.z; // closest approach along the ray
    if (t <= 0) continue;
    const miss2 = dx * dx + dy * dy + dz * dz - t * t;
    if (miss2 > radius * radius) continue;
    const entry = t - Math.sqrt(radius * radius - miss2); // where the ray enters its sphere
    if (entry < bestEntry) {
      best = atom;
      bestEntry = entry;
    }
  }
  return best;
}

function atomUnderController(controller) {
  const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld);
  return atomOnRay(origin, direction);
}

function setHoverAtom(atom) {
  if (atom === hoverAtom) return;
  hoverAtom = atom;
  if (atom) {
    if (!hoverMarker || hoverMarker.parent !== ensureMeasurementGroup()) {
      hoverMarker = addMarker(atom.coord, HOVER_COLOR);
    }
    hoverMarker.position.fromArray(atom.coord);
    hoverMarker.visible = true;
  } else if (hoverMarker) {
    hoverMarker.visible = false;
  }
  requestSequenceRedraw();
}

// While a measuring tool is active, show which atom the trigger would pick.
function updateToolHover() {
  if (!TOOL_ATOM_COUNT[toolMode]) return;
  let atom = null;
  for (const controller of controllers) {
    if (panelItemAt(controller) !== undefined) continue; // pointing at the menu
    atom = atom || atomUnderController(controller);
  }
  setHoverAtom(atom);
}

toolSelect.addEventListener("change", () => setTool(toolSelect.value));
clearMeasurementsButton.addEventListener("click", clearMeasurements);

// --- H-bonds (polar contacts) ---
//
// Which atom pairs are hydrogen bonded is PyMOL's call, not the browser's:
// the pairs come from PyMOL's own finder (`/api/hbonds`, or a file baked
// per molecule for the static build). The browser only decides which of
// them to draw: "show" adds every bond with an end in the target residues,
// "hide" removes them, following the same selection-or-everything rule as
// the representations.

const hbondCheckbox = document.getElementById("show-hbonds");
const HBOND_COLOR = 0xffe14d;
const HBOND_RADIUS = 0.07; // Angstroms
const HBOND_DASH = 0.35; // dash and gap length, Angstroms
const HBOND_GEOMETRY = new THREE.CylinderGeometry(HBOND_RADIUS, HBOND_RADIUS, 1, 6, 1, false);
const HBOND_MATERIAL = new THREE.MeshBasicMaterial({ color: HBOND_COLOR });

let hbondPairs = null; // [{key, a, b}] for the current scene; null until fetched
const shownHbonds = new Set(); // keys of the pairs currently drawn
let hbondDashes = null; // THREE.InstancedMesh, child of currentModel

async function loadHbondPairs() {
  if (hbondPairs) return hbondPairs;
  const epoch = sceneEpoch;
  const url = staticManifest ? staticManifest.hbonds?.[sceneObjects.mol] : "/api/hbonds";
  if (!url) {
    hud.textContent = "H-bonds are not available in this build";
    return [];
  }
  const data = await (await fetch(url)).json();
  if (epoch !== sceneEpoch) return []; // the scene changed while this was in flight
  const atomByIndex = new Map(sceneAtoms.map((atom) => [`${atom.object}|${atom.index}`, atom]));
  hbondPairs = (staticManifest ? data : data.pairs)
    .map(([objectA, indexA, objectB, indexB]) => ({
      key: `${objectA}|${indexA}|${objectB}|${indexB}`,
      a: atomByIndex.get(`${objectA}|${indexA}`),
      b: atomByIndex.get(`${objectB}|${indexB}`),
    }))
    .filter((pair) => pair.a && pair.b);
  return hbondPairs;
}

function rebuildHbondDashes() {
  if (hbondDashes) {
    hbondDashes.parent?.remove(hbondDashes);
    hbondDashes.dispose();
    hbondDashes = null;
  }
  const pairs = (hbondPairs || []).filter((pair) => shownHbonds.has(pair.key));
  if (!currentModel || pairs.length === 0) return;
  const matrices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const size = new THREE.Vector3(1, HBOND_DASH, 1);
  for (const pair of pairs) {
    a.fromArray(pair.a.coord);
    b.fromArray(pair.b.coord);
    const length = a.distanceTo(b);
    direction.subVectors(b, a).normalize();
    turn.setFromUnitVectors(up, direction);
    // dashes centred on the bond, so both ends look the same
    const count = Math.max(1, Math.round(length / (2 * HBOND_DASH)));
    const first = (length - (2 * count - 1) * HBOND_DASH) / 2 + HBOND_DASH / 2;
    for (let i = 0; i < count; i++) {
      const centre = a.clone().addScaledVector(direction, first + 2 * i * HBOND_DASH);
      matrices.push(new THREE.Matrix4().compose(centre, turn, size));
    }
  }
  hbondDashes = new THREE.InstancedMesh(HBOND_GEOMETRY, HBOND_MATERIAL, matrices.length);
  matrices.forEach((matrix, i) => hbondDashes.setMatrixAt(i, matrix));
  hbondDashes.name = "hbonds";
  hbondDashes.frustumCulled = false;
  hbondDashes.raycast = () => {};
  currentModel.add(hbondDashes);
}

function syncHbondControl() {
  const total = hbondPairs ? hbondPairs.length : 0;
  hbondCheckbox.checked = shownHbonds.size > 0;
  hbondCheckbox.indeterminate = shownHbonds.size > 0 && shownHbonds.size < total;
}

async function setHbondsShown(residues, shown) {
  const pairs = await loadHbondPairs();
  const keys = new Set(residues.map((residue) => residue.key));
  for (const pair of pairs) {
    if (!keys.has(residueKey(pair.a)) && !keys.has(residueKey(pair.b))) continue;
    if (shown) shownHbonds.add(pair.key);
    else shownHbonds.delete(pair.key);
  }
  rebuildHbondDashes();
  syncHbondControl();
  requestSequenceRedraw();
}

// After the scene reloaded: the pair list is refetched (objects and frames
// move atoms) and bonds that no longer exist are dropped.
async function refreshHbonds() {
  hbondPairs = null;
  if (shownHbonds.size > 0) {
    const current = new Set((await loadHbondPairs()).map((pair) => pair.key));
    for (const key of Array.from(shownHbonds)) {
      if (!current.has(key)) shownHbonds.delete(key);
    }
  }
  rebuildHbondDashes();
  syncHbondControl();
}

hbondCheckbox.addEventListener("change", () => {
  setHbondsShown(targetResidues(), hbondCheckbox.checked);
});

// --- residue selection: by pointing, and by sequence ---
//
// The whole feature runs on an atom table held in the browser (the same
// per-atom records /api/pick returns, fetched once per scene from /api/atoms
// or, in the static build, from the baked atom file), so a pick is a local
// nearest-atom search with no server round trip per trigger pull, and the
// serverless build gets selection for free. Residues are the unit of
// selection, like real PyMOL's default mouse selection mode.

const ONE_LETTER = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G",
  HIS: "H", ILE: "I", LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S",
  THR: "T", TRP: "W", TYR: "Y", VAL: "V", MSE: "M", SEC: "U", PYL: "O",
  DA: "A", DC: "C", DG: "G", DT: "T", DU: "U", A: "A", C: "C", G: "G", U: "U", T: "T",
};
const WATER_NAMES = new Set(["HOH", "WAT", "H2O", "DOD"]);

const selectionHud = document.getElementById("selection-hud");
const clearSelectionButton = document.getElementById("clear-selection");
const toggleSequenceButton = document.getElementById("toggle-sequence");
const sequencePopout = document.getElementById("sequence-popout");

let sceneAtoms = [];
let sceneObjects = {}; // object name -> molecule id, to tell when a selection is stale
let residueByKey = new Map(); // every residue, waters included
let allResidues = []; // the same, as a list; residue.ordinal is its position here
let sequenceResidues = []; // the ones shown in the sequence, in display order
let sequenceChains = []; // [{key, object, chain, residues}]
let expandedChains = new Set(); // keys of the chains whose sequence is unfolded in the menu
const selectedKeys = new Set();
let selectionMarkers = null; // THREE.InstancedMesh, child of currentModel

function residueKey(atom) {
  return `${atom.object}|${atom.chain}|${atom.resi}`;
}

function describeResidue(residue) {
  return `${residue.resn} ${residue.resi}${residue.chain ? " /" + residue.chain : ""}`;
}

function buildResidues() {
  residueByKey = new Map();
  const chains = new Map();
  for (const atom of sceneAtoms) {
    const key = residueKey(atom);
    let residue = residueByKey.get(key);
    if (!residue) {
      residue = {
        key,
        object: atom.object,
        chain: atom.chain,
        resi: atom.resi,
        resn: atom.resn,
        letter: ONE_LETTER[atom.resn] || "X",
        atoms: [],
        index: -1,
      };
      residueByKey.set(key, residue);
      // Waters stay selectable by pointing but would swamp the sequence.
      if (!WATER_NAMES.has(atom.resn)) {
        const chainKey = `${atom.object}|${atom.chain}`;
        if (!chains.has(chainKey)) {
          chains.set(chainKey, { key: chainKey, object: atom.object, chain: atom.chain, residues: [] });
        }
        chains.get(chainKey).residues.push(residue);
      }
    }
    residue.atoms.push(atom);
  }
  sequenceChains = Array.from(chains.values());
  sequenceResidues = sequenceChains.flatMap((chain) => chain.residues);
  sequenceResidues.forEach((residue, index) => {
    residue.index = index;
  });
  allResidues = Array.from(residueByKey.values());
  allResidues.forEach((residue, ordinal) => {
    residue.ordinal = ordinal;
  });
}

// Install a new atom table. The selection, and what is shown in which
// representation, carry over for residues of objects that are still the
// same molecule. A representation that covered the whole scene keeps
// covering it, so "everything as spheres" survives switching molecule.
function setSceneAtoms(atoms, objects) {
  const previousCount = allResidues.length;
  const coveredEverything = new Set(
    availableReps.filter((rep) => previousCount > 0 && shownByRep.get(rep).size === previousCount),
  );
  const objectsChanged = JSON.stringify(objects) !== JSON.stringify(sceneObjects);
  sceneAtoms = atoms;
  atomGrids = null;
  buildResidues();
  const isStale = (key) => {
    const objectName = key.split("|")[0];
    return objects[objectName] !== sceneObjects[objectName] || !residueByKey.has(key);
  };
  const keySets = [selectedKeys, ...groups.map((group) => group.keys)];
  for (const keys of [...keySets, residueColor, residueOpacity, residueScheme]) {
    for (const key of Array.from(keys.keys())) {
      if (isStale(key)) keys.delete(key);
    }
  }
  groups = groups.filter((group) => group.keys.size > 0);
  if (!groups.includes(activeGroup)) activeGroup = null;
  // Long chains would bury the menu, so only the first starts expanded.
  if (objectsChanged) expandedChains = new Set(sequenceChains.slice(0, 1).map((chain) => chain.key));
  for (const rep of availableReps) {
    const keys = shownByRep.get(rep);
    for (const key of Array.from(keys)) {
      if (isStale(key)) keys.delete(key);
    }
    if (coveredEverything.has(rep)) allResidues.forEach((residue) => keys.add(residue.key));
  }
  if (objectsChanged && availableReps.every((rep) => shownByRep.get(rep).size === 0)) {
    const initial = availableReps.includes("cartoon") ? "cartoon" : availableReps[0];
    allResidues.forEach((residue) => shownByRep.get(initial).add(residue.key));
  }
  sceneObjects = objects;
  groupsChanged(); // also lays the menu out again
  selectionChanged();
}

function selectedResidues() {
  return Array.from(selectedKeys, (key) => residueByKey.get(key)).filter(Boolean);
}

// The selection written the way real PyMOL would take it, so it can be read
// at a glance and pasted into a PyMOL session.
function selectionExpression() {
  const multipleObjects = Object.keys(sceneObjects).length > 1;
  const groups = new Map();
  const add = (residue) => {
    const groupKey = `${residue.object}|${residue.chain}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { residue, runs: [] });
    const runs = groups.get(groupKey).runs;
    const number = /^\d+$/.test(residue.resi) ? Number(residue.resi) : null;
    const last = runs[runs.length - 1];
    if (last && number !== null && last.end === number - 1) {
      last.end = number;
    } else {
      runs.push({ start: residue.resi, end: number });
    }
  };
  // sequence order first, so runs of neighbours collapse into ranges
  sequenceResidues.filter((r) => selectedKeys.has(r.key)).forEach(add);
  selectedResidues().filter((r) => r.index === -1).forEach(add);
  if (groups.size === 0) return "nothing selected";
  const parts = Array.from(groups.values(), ({ residue, runs }) => {
    const resi = runs
      .map((run) => {
        // PyMOL reads a bare "-" as a range, so negative numbers are escaped
        const start = String(run.start).replace(/^-/, "\\-");
        return run.end !== null && String(run.end) !== String(run.start)
          ? `${start}-${run.end}`
          : start;
      })
      .join("+");
    return (
      (multipleObjects ? `${residue.object} and ` : "") +
      (residue.chain ? `chain ${residue.chain} and ` : "") +
      `resi ${resi}`
    );
  });
  return parts.length === 1 ? parts[0] : parts.map((part) => `(${part})`).join(" or ");
}

const SELECTION_MARKER_GEOMETRY = new THREE.SphereGeometry(0.4, 8, 6); // radius in Angstroms
// depthTest off for the same reason as the measurement markers: a marker at
// an atom's centre is otherwise hidden inside that atom's own sphere.
const SELECTION_MARKER_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xff66cc,
  transparent: true,
  opacity: 0.85,
  depthTest: false,
});

function rebuildSelectionMarkers() {
  if (selectionMarkers) {
    selectionMarkers.parent?.remove(selectionMarkers);
    selectionMarkers.dispose();
    selectionMarkers = null;
  }
  if (!currentModel) return;
  const atoms = selectedResidues().flatMap((residue) => residue.atoms);
  if (atoms.length === 0) return;
  // Atom coordinates are the model's own local frame (see click-to-measure),
  // so as a child of the model the markers follow every grab, zoom and reset.
  selectionMarkers = new THREE.InstancedMesh(
    SELECTION_MARKER_GEOMETRY,
    SELECTION_MARKER_MATERIAL,
    atoms.length,
  );
  const matrix = new THREE.Matrix4();
  atoms.forEach((atom, i) => {
    selectionMarkers.setMatrixAt(i, matrix.makeTranslation(atom.coord[0], atom.coord[1], atom.coord[2]));
  });
  selectionMarkers.name = "selection";
  selectionMarkers.renderOrder = 998;
  selectionMarkers.frustumCulled = false;
  // Markers must not catch the pointing ray, or picks would land on them
  // instead of on the molecule behind.
  selectionMarkers.raycast = () => {};
  currentModel.add(selectionMarkers);
}

function selectionChanged() {
  rebuildSelectionMarkers();
  selectionHud.textContent = selectionExpression();
  requestSequenceRedraw();
}

function setResiduesSelected(list, selected) {
  let changed = false;
  for (const residue of list) {
    if (selectedKeys.has(residue.key) === selected) continue;
    if (selected) selectedKeys.add(residue.key);
    else selectedKeys.delete(residue.key);
    changed = true;
  }
  if (changed) selectionChanged();
}

function clearSelection() {
  if (selectedKeys.size === 0) return;
  selectedKeys.clear();
  selectionChanged();
}

function invertSelection() {
  for (const residue of allResidues) {
    if (selectedKeys.has(residue.key)) selectedKeys.delete(residue.key);
    else selectedKeys.add(residue.key);
  }
  selectionChanged();
}

// Point is in the model's local frame (Angstroms). Toggles the residue that
// owns the nearest atom and returns it.
function selectLocalPoint(x, y, z) {
  let best = null;
  let bestDist = Infinity;
  for (const atom of sceneAtoms) {
    const dist = (atom.coord[0] - x) ** 2 + (atom.coord[1] - y) ** 2 + (atom.coord[2] - z) ** 2;
    if (dist < bestDist) {
      best = atom;
      bestDist = dist;
    }
  }
  if (!best) return null;
  const residue = residueByKey.get(residueKey(best));
  setResiduesSelected([residue], !selectedKeys.has(residue.key));
  return { key: residue.key, resn: residue.resn, resi: residue.resi, chain: residue.chain };
}

function selectWorldPoint(point) {
  const local = currentModel.worldToLocal(point.clone());
  return selectLocalPoint(local.x, local.y, local.z);
}

// Desktop: a click uses the active tool, a drag still orbits -- told apart
// by how far the pointer travelled, so no tool has to switch orbiting off.
let pointerDownAt = null;
renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerDownAt = [event.clientX, event.clientY];
});
renderer.domElement.addEventListener("click", (event) => {
  if (!currentModel || !pointerDownAt) return;
  if (Math.hypot(event.clientX - pointerDownAt[0], event.clientY - pointerDownAt[1]) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  if (TOOL_ATOM_COUNT[toolMode]) {
    const atom = atomOnRay(raycaster.ray.origin, raycaster.ray.direction);
    if (atom) addPick(atom);
    return;
  }
  const hits = raycaster.intersectObject(currentModel, true);
  if (hits.length > 0) selectWorldPoint(hits[0].point);
});
clearSelectionButton.addEventListener("click", clearSelection);
document.getElementById("select-all").addEventListener("click", () => {
  setResiduesSelected(allResidues, true);
});
document.getElementById("invert-selection").addEventListener("click", invertSelection);

// --- per-residue colour and transparency ---
//
// Both are done in the browser on the loaded layers, like show/hide: a
// colour is written over the vertex colours of the triangles a residue
// owns, and see-through residues are drawn by a second, transparent copy
// of the mesh that shares its vertices. The colouring scheme (by chain,
// rainbow, ...) underneath is still PyMOL's, baked into the layer.

const PAINT_COLORS = [
  ["red", "#ff3030"],
  ["orange", "#ff8c1a"],
  ["yellow", "#ffe14d"],
  ["green", "#33cc55"],
  ["cyan", "#33cccc"],
  ["blue", "#3366ff"],
  ["magenta", "#cc44cc"],
  ["white", "#f2f2f2"],
  ["grey", "#808080"],
];
const COLOR_SCHEMES = [
  ["default", "element"],
  ["chain", "chain"],
  ["rainbow", "rainbow"],
  ["secondary-structure", "2nd struct"],
  ["b-factor", "b-factor"],
];
// Index 0 is opaque; 1 and 2 are the two see-through settings.
const OPACITY_LEVELS = [1, 0.5, 0.2];
const OPACITY_LABELS = ["none", "50%", "80%"];

const residueColor = new Map(); // residue key -> THREE.Color painted over the scheme
const residueOpacity = new Map(); // residue key -> 1 or 2 (index into OPACITY_LEVELS)

function restyleLayers() {
  for (const layer of layers.values()) {
    if (layer.state === "ready") applyLayerMask(layer);
  }
  requestSequenceRedraw();
}

// `hex` null removes the paint, giving the residues back their scheme colour.
function paintResidues(residues, hex) {
  for (const residue of residues) {
    if (hex) residueColor.set(residue.key, new THREE.Color(hex));
    else residueColor.delete(residue.key);
  }
  restyleLayers();
}

function setResidueOpacity(residues, level) {
  for (const residue of residues) {
    if (level > 0) residueOpacity.set(residue.key, level);
    else residueOpacity.delete(residue.key);
  }
  restyleLayers();
}

// --- named groups of residues ---
//
// PyMOL's named selections: the current selection can be saved under a
// name, recalled later (it becomes the selection again, so every button
// acts on it), renamed and deleted. Names are restricted to what PyMOL
// accepts for a selection name.

const MAX_GROUPS = 8;
const groupNameInput = document.getElementById("group-name");
const groupList = document.getElementById("group-list");
let groups = []; // [{name, keys: Set of residue keys}]
let activeGroup = null; // the one rename and delete act on

function groupsChanged() {
  groupList.innerHTML = "";
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${group.name} (${group.keys.size})`;
    button.className = group === activeGroup ? "active" : "";
    button.addEventListener("click", () => recallGroup(group));
    groupList.appendChild(button);
  }
  groupNameInput.value = activeGroup ? activeGroup.name : "";
  groupNameInput.disabled = !activeGroup;
  layoutSequence(); // the menu has one button per group
}

function saveGroup() {
  if (selectedKeys.size === 0) {
    hud.textContent = "nothing selected to save as a group";
    return null;
  }
  if (groups.length >= MAX_GROUPS) {
    hud.textContent = `at most ${MAX_GROUPS} groups -- delete one first`;
    return null;
  }
  let n = 1;
  while (groups.some((group) => group.name === `sele${n}`)) n += 1;
  activeGroup = { name: `sele${n}`, keys: new Set(selectedKeys) };
  groups.push(activeGroup);
  groupsChanged();
  return activeGroup;
}

function recallGroup(group) {
  activeGroup = group;
  selectedKeys.clear();
  group.keys.forEach((key) => selectedKeys.add(key));
  selectionChanged();
  groupsChanged();
}

// Returns the name actually given, or null if it was refused.
function renameGroup(group, requested) {
  const name = requested.trim().replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
  if (!name || groups.some((other) => other !== group && other.name === name)) return null;
  group.name = name;
  groupsChanged();
  return name;
}

function deleteGroup(group) {
  groups = groups.filter((other) => other !== group);
  if (activeGroup === group) activeGroup = null;
  groupsChanged();
}

// Typing a name. On desktop the name box in the side panel is simply
// edited. In the headset there is no keyboard of our own: focusing a text
// input during an immersive session makes the Meta Quest Browser bring up
// its system keyboard, and the typed text arrives in the input when the
// keyboard is dismissed.
function startRename() {
  if (!activeGroup) {
    hud.textContent = "save or pick a group first";
    return;
  }
  const session = renderer.xr.getSession();
  if (session && session.isSystemKeyboardSupported === false) {
    hud.textContent = "this browser has no system keyboard in VR -- rename on the web page instead";
  }
  groupNameInput.value = activeGroup.name;
  groupNameInput.focus();
  groupNameInput.select();
}

function commitRename() {
  if (!activeGroup || groupNameInput.value === activeGroup.name) return;
  if (!renameGroup(activeGroup, groupNameInput.value)) {
    hud.textContent = "that name is empty or already used";
    groupNameInput.value = activeGroup.name;
  }
}

groupNameInput.addEventListener("change", commitRename);
groupNameInput.addEventListener("blur", commitRename);
document.getElementById("save-group").addEventListener("click", saveGroup);
document.getElementById("delete-group").addEventListener("click", () => {
  if (activeGroup) deleteGroup(activeGroup);
});

// Side-panel versions of the colour and see-through buttons.
const paintSwatches = document.getElementById("paint-swatches");
for (const [name, hex] of PAINT_COLORS) {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.title = name;
  swatch.dataset.color = hex;
  swatch.style.background = hex;
  swatch.addEventListener("click", () => paintResidues(targetResidues(), hex));
  paintSwatches.appendChild(swatch);
}
document.getElementById("paint-reset").addEventListener("click", () => {
  paintResidues(targetResidues(), null);
});
document.querySelectorAll("#opacity-buttons button").forEach((button) => {
  button.addEventListener("click", () => {
    setResidueOpacity(targetResidues(), Number(button.dataset.level));
  });
});

// --- menu window: show/hide buttons and the sequence ---
//
// One canvas, used twice: as an ordinary element in the desktop pop-out, and
// as the texture of a board in the 3D scene -- an immersive session shows
// only what WebGL draws, so an HTML pop-up would be invisible in the
// headset. Layout, drawing and hit-testing are shared; only the pointer
// differs (mouse position vs. where a controller ray meets the board).

const SEQ_WIDTH = 1024; // layout units; the canvas has SEQ_PIXEL_RATIO pixels per unit
const SEQ_PIXEL_RATIO = 2;
const SEQ_MAX_HEIGHT = 1024;
const SEQ_PAD = 14;
const SEQ_ROW_SHOW = 76; // top of each button row
const SEQ_ROW_HIDE = 112;
const SEQ_ROW_SELECT = 148; // shared with the pointer tool
const SEQ_ROW_COLOR = 184;
const SEQ_ROW_OPACITY = 220;
const SEQ_ROW_GROUPS = 256;
const SEQ_ROW_HEIGHT = 30;
const SEQ_ROW_LABEL = 70; // width of the row labels
const SEQ_BUTTON_GAP = 6;
const SEQ_HEADER = 298; // where the sequence starts
const SEQ_CHAIN_HEADER = 26; // height of a chain's fold/unfold bar
// No scrolling in VR, so long sequences get more (smaller) letters per row
// until the whole thing fits on one board.
const SEQ_COLUMN_CHOICES = [40, 50, 60, 80, 100, 150];
const SEQ_SELECTED_COLOR = "#ff66cc";

const PANEL_WIDTH = 0.7; // metres
const PANEL_DISTANCE = 0.45; // in front of the viewer
const PANEL_DROP = 0.7; // below eye level, clear of the molecule
const PANEL_TILT = (55 * Math.PI) / 180; // leaned back to face the eyes

const seqCanvas = document.getElementById("sequence-canvas");
const seqContext = seqCanvas.getContext("2d");
const seqTexture = new THREE.CanvasTexture(seqCanvas);
seqTexture.colorSpace = THREE.SRGBColorSpace;
seqTexture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // read at a slant
const seqPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: seqTexture, side: THREE.DoubleSide, toneMapped: false }),
);
seqPanel.name = "sequence-panel";
seqPanel.visible = false;
scene.add(seqPanel);

let seqLayout = { height: SEQ_HEADER + SEQ_PAD, cellW: 0, cellH: 0, rowLabels: [], ticks: [] };
let seqItems = []; // hit targets: {x, y, w, h, residue} or {x, y, w, h, action: {kind, rep, label}}
let seqHover = null;
let seqDrag = null; // {source, add, lastIndex} while a sweep is in progress
let seqDirty = true;

function requestSequenceRedraw() {
  seqDirty = true;
}

function layoutSequenceWith(columns) {
  const cellW = (SEQ_WIDTH - 2 * SEQ_PAD) / columns;
  const cellH = Math.min(34, Math.max(14, cellW * 1.5));
  const tickSize = Math.min(13, Math.max(9, cellW * 0.6));
  const multipleObjects = Object.keys(sceneObjects).length > 1;
  const menu = menuButtons();
  const items = menu.items;
  const ticks = [];
  let y = SEQ_HEADER;
  for (const chain of sequenceChains) {
    // Each chain has a bar that folds its sequence away or unfolds it, and
    // a button that selects the whole chain.
    const expanded = expandedChains.has(chain.key);
    const name = chain.chain || "-";
    const title = multipleObjects ? `${chain.object}, chain ${name}` : `chain ${name}`;
    const count = chain.residues.length;
    items.push({
      x: SEQ_PAD,
      y,
      w: SEQ_WIDTH - 2 * SEQ_PAD - 96 - SEQ_BUTTON_GAP,
      h: SEQ_CHAIN_HEADER,
      action: {
        kind: "toggleChain",
        chain,
        label: `${expanded ? "-" : "+"} ${title}   ${count} residue${count === 1 ? "" : "s"}`,
        align: "left",
      },
    });
    items.push({
      x: SEQ_WIDTH - SEQ_PAD - 96,
      y,
      w: 96,
      h: SEQ_CHAIN_HEADER,
      action: { kind: "selectChain", chain, label: "select" },
    });
    y += SEQ_CHAIN_HEADER + 4;
    if (!expanded) continue;
    let tickFreeFrom = 0;
    chain.residues.forEach((residue, i) => {
      const column = i % columns;
      if (i > 0 && column === 0) {
        y += tickSize + cellH + 4;
        tickFreeFrom = 0;
      }
      const x = SEQ_PAD + column * cellW;
      const numbered = i === 0 || (/^-?\d+$/.test(residue.resi) && Number(residue.resi) % 10 === 0);
      if (numbered && x >= tickFreeFrom) {
        ticks.push({ text: residue.resi, x, y: y + tickSize - 2 });
        tickFreeFrom = x + residue.resi.length * tickSize * 0.62 + 3;
      }
      items.push({ x, y: y + tickSize, w: cellW, h: cellH, residue });
    });
    y += tickSize + cellH + 10;
  }
  return {
    layout: { height: y + SEQ_PAD, cellW, cellH, tickSize, rowLabels: menu.labels, ticks },
    items,
  };
}

function repLabel(rep) {
  return rep === "ball_and_stick" ? "ball+stick" : rep;
}

// The button rows, PyMOL's S/H/C menus flattened onto a board: show and
// hide per representation and for H-bonds; selection helpers and the
// pointer tool; colouring; see-through; named groups.
function menuButtons() {
  const items = [];
  const labels = [];
  const left = SEQ_PAD + SEQ_ROW_LABEL;
  const right = SEQ_WIDTH - SEQ_PAD;
  const rowLabel = (text, y, x = SEQ_PAD) => labels.push({ text, x, y: y + SEQ_ROW_HEIGHT / 2 + 1 });
  // lay buttons out left to right from `x`, returning where the row got to
  const place = (x, y, width, actions) => {
    for (const action of actions) {
      items.push({ x, y, w: width, h: SEQ_ROW_HEIGHT, action });
      x += width + SEQ_BUTTON_GAP;
    }
    return x;
  };

  const slots = availableReps.length + 2; // plus "h-bonds", and "everything" on the hide row
  const repWidth = (right - left + SEQ_BUTTON_GAP) / slots - SEQ_BUTTON_GAP;
  rowLabel("show", SEQ_ROW_SHOW);
  place(left, SEQ_ROW_SHOW, repWidth, [
    ...availableReps.map((rep) => ({ kind: "show", rep, label: repLabel(rep) })),
    { kind: "showHbonds", label: "h-bonds" },
  ]);
  rowLabel("hide", SEQ_ROW_HIDE);
  place(left, SEQ_ROW_HIDE, repWidth, [
    ...availableReps.map((rep) => ({ kind: "hide", rep, label: repLabel(rep) })),
    { kind: "hideHbonds", label: "h-bonds" },
    { kind: "hideAll", label: "everything" },
  ]);

  rowLabel("select", SEQ_ROW_SELECT);
  let x = place(left, SEQ_ROW_SELECT, 76, [
    { kind: "selectAll", label: "all" },
    { kind: "invert", label: "invert" },
    { kind: "clear", label: "none" },
  ]);
  rowLabel("tool", SEQ_ROW_SELECT, x + 14);
  x = place(x + 60, SEQ_ROW_SELECT, 92, ["select", "distance", "angle", "dihedral"].map(
    (tool) => ({ kind: "tool", tool, label: tool }),
  ));
  place(x + 8, SEQ_ROW_SELECT, right - x - 8, [{ kind: "clearMeasurements", label: "clear measurements" }]);

  rowLabel("colour", SEQ_ROW_COLOR);
  x = place(left, SEQ_ROW_COLOR, 92, COLOR_SCHEMES.map(
    ([scheme, label]) => ({ kind: "scheme", scheme, label }),
  ));
  x = place(x + 14, SEQ_ROW_COLOR, 32, PAINT_COLORS.map(
    ([name, hex]) => ({ kind: "paint", name, hex, label: "" }),
  ));
  place(x + 8, SEQ_ROW_COLOR, right - x - 8, [{ kind: "unpaint", label: "reset" }]);

  rowLabel("fade", SEQ_ROW_OPACITY); // how see-through: none, 50% or 80%
  place(left, SEQ_ROW_OPACITY, 76, OPACITY_LABELS.map(
    (label, level) => ({ kind: "opacity", level, label }),
  ));

  rowLabel("groups", SEQ_ROW_GROUPS);
  x = place(left, SEQ_ROW_GROUPS, 76, [
    { kind: "saveGroup", label: "save" },
    { kind: "renameGroup", label: "rename" },
    { kind: "deleteGroup", label: "delete" },
  ]);
  if (groups.length > 0) {
    const width = Math.min(130, (right - x - 14 + SEQ_BUTTON_GAP) / groups.length - SEQ_BUTTON_GAP);
    place(x + 14, SEQ_ROW_GROUPS, width, groups.map(
      (group) => ({ kind: "recallGroup", group, label: group.name }),
    ));
  }
  return { items, labels };
}

function describeTarget() {
  const count = selectedKeys.size;
  return count > 0 ? `the selection (${count} residue${count === 1 ? "" : "s"})` : "the whole molecule";
}

function describeAction(action) {
  switch (action.kind) {
    case "show":
      return `show ${describeTarget()} as ${repLabel(action.rep)}`;
    case "hide":
      return `hide ${repLabel(action.rep)} of ${describeTarget()}`;
    case "hideAll":
      return `hide ${describeTarget()} completely`;
    case "showHbonds":
      return `show H-bonds of ${describeTarget()}`;
    case "hideHbonds":
      return `hide H-bonds of ${describeTarget()}`;
    case "tool":
      return action.tool === "select"
        ? "trigger on the molecule selects a residue"
        : `trigger on the molecule picks ${TOOL_ATOM_COUNT[action.tool]} atoms to measure a ${action.tool}`;
    case "clearMeasurements":
      return "remove every measurement";
    case "scheme":
      return `colour ${describeTarget()} by ${action.label}`;
    case "paint":
      return `colour ${describeTarget()} ${action.name}`;
    case "unpaint":
      return `give ${describeTarget()} back its scheme colour`;
    case "opacity":
      return action.level === 0
        ? `make ${describeTarget()} solid`
        : `make ${describeTarget()} ${action.label} see-through`;
    case "saveGroup":
      return "save the selection as a named group";
    case "renameGroup":
      return activeGroup ? `rename ${activeGroup.name}` : "rename a group (save or pick one first)";
    case "deleteGroup":
      return activeGroup ? `delete group ${activeGroup.name}` : "delete a group (pick one first)";
    case "recallGroup":
      return `select group ${action.group.name} (${action.group.keys.size} residues)`;
    case "toggleChain":
      return expandedChains.has(action.chain.key) ? "fold this chain's sequence away" : "unfold this chain's sequence";
    case "selectChain":
      return "select this whole chain (again to deselect)";
    case "selectAll":
      return "select every residue";
    case "invert":
      return "swap selected and unselected";
    default:
      return "clear the selection";
  }
}

function runMenuAction(action) {
  switch (action.kind) {
    case "show":
      setRepShown(action.rep, targetResidues(), true);
      break;
    case "hide":
      setRepShown(action.rep, targetResidues(), false);
      break;
    case "hideAll":
      hideEverything(targetResidues());
      break;
    case "showHbonds":
      setHbondsShown(targetResidues(), true);
      break;
    case "hideHbonds":
      setHbondsShown(targetResidues(), false);
      break;
    case "tool":
      setTool(action.tool);
      break;
    case "clearMeasurements":
      clearMeasurements();
      break;
    case "scheme":
      setScheme(action.scheme);
      break;
    case "paint":
      paintResidues(targetResidues(), action.hex);
      break;
    case "unpaint":
      paintResidues(targetResidues(), null);
      break;
    case "opacity":
      setResidueOpacity(targetResidues(), action.level);
      break;
    case "saveGroup":
      saveGroup();
      break;
    case "renameGroup":
      startRename();
      break;
    case "deleteGroup":
      if (activeGroup) deleteGroup(activeGroup);
      break;
    case "recallGroup":
      recallGroup(action.group);
      break;
    case "toggleChain":
      if (!expandedChains.delete(action.chain.key)) expandedChains.add(action.chain.key);
      layoutSequence();
      break;
    case "selectChain": {
      const residues = action.chain.residues;
      setResiduesSelected(residues, !residues.every((residue) => selectedKeys.has(residue.key)));
      break;
    }
    case "selectAll":
      setResiduesSelected(allResidues, true);
      break;
    case "invert":
      invertSelection();
      break;
    default:
      clearSelection();
  }
}

function layoutSequence() {
  let result;
  for (const columns of SEQ_COLUMN_CHOICES) {
    result = layoutSequenceWith(columns);
    if (result.layout.height <= SEQ_MAX_HEIGHT) break;
  }
  seqLayout = result.layout;
  seqItems = result.items;
  seqHover = null;
  seqDrag = null;
  requestSequenceRedraw();
}

function drawSequence() {
  seqDirty = false;
  const pixelWidth = SEQ_WIDTH * SEQ_PIXEL_RATIO;
  const pixelHeight = Math.round(seqLayout.height * SEQ_PIXEL_RATIO);
  if (seqCanvas.width !== pixelWidth || seqCanvas.height !== pixelHeight) {
    seqCanvas.width = pixelWidth;
    seqCanvas.height = pixelHeight;
    seqTexture.dispose(); // a GPU texture can't change size in place
    seqPanel.scale.set(PANEL_WIDTH, (PANEL_WIDTH * seqLayout.height) / SEQ_WIDTH, 1);
  }
  const ctx = seqContext;
  ctx.setTransform(SEQ_PIXEL_RATIO, 0, 0, SEQ_PIXEL_RATIO, 0, 0);
  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, SEQ_WIDTH, seqLayout.height);
  ctx.strokeStyle = "#5a6a9a";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, SEQ_WIDTH - 2, seqLayout.height - 2);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 24px monospace";
  ctx.fillText("Menu", SEQ_PAD, 28);
  ctx.font = "18px monospace";
  ctx.fillStyle = SEQ_SELECTED_COLOR;
  const count = selectedResidues().length;
  let status;
  if (seqHover?.residue) status = describeResidue(seqHover.residue);
  else if (seqHover?.action) status = describeAction(seqHover.action);
  else if (anyLayerLoading()) status = "loading ...";
  else if (TOOL_ATOM_COUNT[toolMode]) {
    // while measuring: the atom the trigger would pick, else progress so far
    status = hoverAtom
      ? `${describeAtom(hoverAtom)} -- atom ${pendingPicks.length + 1} of ${TOOL_ATOM_COUNT[toolMode]}`
      : measureHud.textContent.trim() || `${toolMode}: pick ${TOOL_ATOM_COUNT[toolMode]} atoms`;
  }
  else if (sequenceResidues.length === 0) status = "no sequence loaded";
  else if (count === 0) status = "nothing selected -- buttons act on the whole molecule";
  else status = `${count} residue${count === 1 ? "" : "s"} selected -- buttons act on the selection`;
  ctx.fillText(status, SEQ_PAD + 90, 28, SEQ_WIDTH - 2 * SEQ_PAD - 90);
  ctx.font = "14px monospace";
  ctx.fillStyle = "#9aa6cc";
  ctx.fillText(
    "trigger: use the tool on the molecule, press a button or residue here | grip: grab | stick: zoom | A/B: hide",
    SEQ_PAD,
    56,
  );

  ctx.font = "16px monospace";
  ctx.fillStyle = "#c8d0ee";
  for (const label of seqLayout.rowLabels) ctx.fillText(label.text, label.x, label.y);
  const target = targetResidues();

  ctx.font = `${seqLayout.tickSize}px monospace`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8090b8";
  for (const tick of seqLayout.ticks) ctx.fillText(tick.text, tick.x, tick.y);

  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const letterSize = Math.min(seqLayout.cellH * 0.75, seqLayout.cellW * 1.3);
  for (const item of seqItems) {
    if (item.action) {
      const action = item.action;
      if (action.kind === "paint") {
        ctx.fillStyle = action.hex;
        ctx.fillRect(item.x, item.y, item.w, item.h);
        if (item === seqHover) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          ctx.strokeRect(item.x, item.y, item.w, item.h);
        }
        continue;
      }
      // lit: this is the current state of (some of) what the buttons act on
      const lit =
        (action.kind === "show" && target.some((r) => shownByRep.get(action.rep).has(r.key))) ||
        (action.kind === "showHbonds" && shownHbonds.size > 0) ||
        (action.kind === "tool" && action.tool === toolMode) ||
        (action.kind === "scheme" && target.some((r) => schemeOfKey(r.key) === action.scheme)) ||
        (action.kind === "opacity" &&
          action.level > 0 &&
          target.some((r) => residueOpacity.get(r.key) === action.level)) ||
        (action.kind === "recallGroup" && action.group === activeGroup);
      const chainBar = action.kind === "toggleChain";
      ctx.fillStyle = item === seqHover ? "#5a6a9a" : lit ? "#2f7d5b" : chainBar ? "#1b2444" : "#2a3558";
      ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.fillStyle = "#ffffff";
      ctx.font = "15px monospace";
      if (action.align === "left") {
        ctx.textAlign = "left";
        ctx.fillText(action.label, item.x + 8, item.y + item.h / 2 + 1, item.w - 16);
        ctx.textAlign = "center";
      } else {
        ctx.fillText(action.label, item.x + item.w / 2, item.y + item.h / 2 + 1, item.w - 6);
      }
      continue;
    }
    const selected = selectedKeys.has(item.residue.key);
    if (selected) {
      ctx.fillStyle = SEQ_SELECTED_COLOR;
      ctx.fillRect(item.x, item.y, item.w, item.h);
    }
    ctx.fillStyle = selected ? "#000000" : "#e8ecff";
    ctx.font = `bold ${letterSize}px monospace`;
    ctx.fillText(item.residue.letter, item.x + item.w / 2, item.y + item.h / 2 + 1);
  }
  if (seqHover?.residue) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(seqHover.x, seqHover.y, seqHover.w, seqHover.h);
  }
  seqTexture.needsUpdate = true;
}

function sequenceItemAt(x, y) {
  for (const item of seqItems) {
    if (x >= item.x && x < item.x + item.w && y >= item.y && y < item.y + item.h) return item;
  }
  return null;
}

function setSequenceHover(item) {
  if (item === seqHover) return;
  seqHover = item;
  requestSequenceRedraw();
}

// `source` identifies who is pressing (a controller, or "mouse"), so one
// hand hovering can't interfere with a sweep the other hand started.
function sequencePointerDown(item, source) {
  if (!item) return;
  if (item.action) {
    runMenuAction(item.action);
    return;
  }
  // The first residue decides the whole sweep: starting on an unselected
  // residue selects everything swept over, starting on a selected one
  // deselects -- the same rule real PyMOL's sequence viewer uses.
  const add = !selectedKeys.has(item.residue.key);
  seqDrag = { source, add, lastIndex: item.residue.index };
  setResiduesSelected([item.residue], add);
}

function sequencePointerMove(item, source) {
  if (!seqDrag || seqDrag.source !== source || !item?.residue) return;
  const index = item.residue.index;
  if (index === seqDrag.lastIndex) return;
  // fill the gap too: a fast sweep skips over cells between two frames
  const from = Math.min(index, seqDrag.lastIndex);
  const to = Math.max(index, seqDrag.lastIndex);
  setResiduesSelected(sequenceResidues.slice(from, to + 1), seqDrag.add);
  seqDrag.lastIndex = index;
}

function sequencePointerUp(source) {
  if (seqDrag && seqDrag.source === source) seqDrag = null;
}

function sequenceItemFromMouse(event) {
  const rect = seqCanvas.getBoundingClientRect();
  return sequenceItemAt(
    ((event.clientX - rect.left) / rect.width) * SEQ_WIDTH,
    ((event.clientY - rect.top) / rect.height) * seqLayout.height,
  );
}

seqCanvas.addEventListener("pointerdown", (event) => {
  sequencePointerDown(sequenceItemFromMouse(event), "mouse");
});
seqCanvas.addEventListener("pointermove", (event) => {
  const item = sequenceItemFromMouse(event);
  setSequenceHover(item);
  sequencePointerMove(item, "mouse");
});
seqCanvas.addEventListener("pointerleave", () => setSequenceHover(null));
window.addEventListener("pointerup", () => sequencePointerUp("mouse"));
toggleSequenceButton.addEventListener("click", () => {
  sequencePopout.hidden = !sequencePopout.hidden;
  toggleSequenceButton.textContent = sequencePopout.hidden
    ? "show menu and sequence"
    : "hide menu and sequence";
});

// What a controller's ray is on: `undefined` when it misses the board (or
// the board is hidden), `null` on the board but between targets, else the
// residue cell or button under it.
function panelItemAt(controller) {
  if (!seqPanel.visible) return undefined;
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
  const hit = raycaster.intersectObject(seqPanel, false)[0];
  if (!hit) return undefined;
  return sequenceItemAt(hit.uv.x * SEQ_WIDTH, (1 - hit.uv.y) * seqLayout.height);
}

function updatePanelPointers() {
  if (!seqPanel.visible) return;
  let hover = null;
  for (const controller of controllers) {
    const item = panelItemAt(controller);
    if (!item) continue;
    hover = hover || item;
    sequencePointerMove(item, controller);
  }
  setSequenceHover(hover);
}

// Put the board below the viewer's line of sight, leaned back to face them,
// squared up to whichever way they are currently looking.
function showSequencePanel() {
  const viewer = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const head = viewer.getWorldPosition(new THREE.Vector3());
  const forward = viewer.getWorldDirection(new THREE.Vector3());
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1); // looking straight up or down
  forward.normalize();
  seqPanel.position.copy(head).addScaledVector(forward, PANEL_DISTANCE);
  seqPanel.position.y = Math.max(head.y - PANEL_DROP, 0.4);
  seqPanel.rotation.set(-PANEL_TILT, Math.atan2(-forward.x, -forward.z), 0, "YXZ");
  seqPanel.visible = true;
  requestSequenceRedraw();
}

function toggleSequencePanel() {
  if (seqPanel.visible) {
    seqPanel.visible = false;
    seqDrag = null;
  } else {
    showSequencePanel();
  }
}

// A/B on the right controller, X/Y on the left: buttons 4 and 5 of the
// "xr-standard" gamepad layout.
const menuButtonWasDown = new WeakMap();
function pollMenuButtons(session) {
  for (const source of session.inputSources) {
    const buttons = source.gamepad?.buttons;
    if (!buttons) continue;
    const down = Boolean(buttons[4]?.pressed || buttons[5]?.pressed);
    if (down && !menuButtonWasDown.get(source)) toggleSequencePanel();
    menuButtonWasDown.set(source, down);
  }
}

// The board opens by itself on entering VR, since nothing else in the
// headset says it exists. The head pose isn't known until the session has
// delivered a frame, so placement waits for the first tracked one.
let panelPlacementFramesLeft = 0;
renderer.xr.addEventListener("sessionstart", () => {
  panelPlacementFramesLeft = 30;
});
renderer.xr.addEventListener("sessionend", () => {
  panelPlacementFramesLeft = 0;
  seqPanel.visible = false;
});
function placePanelOnEnteringVr() {
  if (panelPlacementFramesLeft === 0) return;
  panelPlacementFramesLeft -= 1;
  const head = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
  if (head.lengthSq() > 0.01 || panelPlacementFramesLeft === 0) {
    panelPlacementFramesLeft = 0;
    showSequencePanel();
  }
}

// --- trigger: select ---
//
// On the menu board the trigger presses whatever the ray is on; on the
// molecule it uses the active tool: select the residue the ray hits, or
// pick the atom under the ray for a measurement.
function onTriggerStart(event) {
  const controller = event.target;
  const item = panelItemAt(controller);
  if (item !== undefined) {
    sequencePointerDown(item, controller);
    return;
  }
  if (TOOL_ATOM_COUNT[toolMode]) {
    const atom = atomUnderController(controller);
    if (atom) addPick(atom);
    return;
  }
  const hit = controllerModelHit(controller);
  if (hit) selectWorldPoint(hit.point);
}

function onTriggerEnd(event) {
  sequencePointerUp(event.target);
}

controllers.forEach((controller) => {
  controller.addEventListener("selectstart", onTriggerStart);
  controller.addEventListener("selectend", onTriggerEnd);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastFrameTime = null;

renderer.setAnimationLoop((time) => {
  // capped so a stalled frame (scene reload, tab switch) can't cause a jump
  const dt = lastFrameTime === null ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1);
  lastFrameTime = time;
  controls.update();
  updateTwoHandGrab();
  const session = renderer.xr.getSession();
  if (session) {
    zoomModel(stickZoomFactor(thumbstickY(session), dt));
    pollMenuButtons(session);
    placePanelOnEnteringVr();
  }
  updatePanelPointers();
  updateToolHover();
  updateLabelScales();
  if (seqDirty) drawSequence();
  renderer.render(scene, camera);
});

window.vrPymolResetView = resetView;
// for Playwright tests to introspect/drive view + grab state without a real
// WebXR session (no XR device is available in headless Chromium): tests
// position controllers manually and call the grab/trigger handlers directly.
window.vrPymolDebug = {
  renderer,
  camera,
  controls,
  scene,
  controllers,
  onGrabStart: (i) => onGrabStart({ target: controllers[i] }),
  onGrabEnd: (i) => onGrabEnd({ target: controllers[i] }),
  onTriggerStart: (i) => onTriggerStart({ target: controllers[i] }),
  onTriggerEnd: (i) => onTriggerEnd({ target: controllers[i] }),
  selectLocalPoint,
  clearSelection,
  // show/hide a representation for the selection (or everything), exactly
  // as the menu buttons and side-panel checkboxes do
  showRep: (rep) => setRepShown(rep, targetResidues(), true),
  hideRep: (rep) => setRepShown(rep, targetResidues(), false),
  shownCount: (rep) => shownByRep.get(rep).size,
  // state of a representation across the schemes it is drawn in
  layerState(rep) {
    const states = layersOfRep(rep).map((layer) => layer.state);
    if (states.length === 0) return "unloaded";
    return ["loading", "missing"].find((state) => states.includes(state)) ?? "ready";
  },
  setScheme,
  schemeOf: (key) => schemeOfKey(key),
  // {total, visible, transparent} triangle counts of a loaded layer
  // (`visible` includes the see-through ones)
  layerTriangles(rep) {
    const parts = layersOfRep(rep).flatMap((layer) => layer.parts);
    return {
      total: parts.reduce((sum, part) => sum + part.owner.length, 0),
      visible: parts.reduce((sum, part) => sum + part.visibleTriangles, 0),
      transparent: parts.reduce((sum, part) => sum + part.transparentTriangles, 0),
    };
  },
  // paint / see-through / groups, on the selection (or everything), as the
  // menu buttons do
  paint: (hex) => paintResidues(targetResidues(), hex),
  setOpacity: (level) => setResidueOpacity(targetResidues(), level),
  // distinct colours ("#rrggbb", as displayed) of a residue's vertices in a layer
  residueColors(rep, key) {
    const ordinal = residueByKey.get(key).ordinal;
    const found = new Set();
    const color = new THREE.Color();
    for (const part of layers.get(`${rep}|${schemeOfKey(key)}`)?.parts ?? []) {
      const attribute = part.object.geometry.attributes.color;
      for (let v = 0; v < part.vertexOwner.length; v++) {
        if (part.vertexOwner[v] !== ordinal) continue;
        color.setRGB(attribute.getX(v), attribute.getY(v), attribute.getZ(v));
        found.add(`#${color.getHexString()}`);
      }
    }
    return Array.from(found);
  },
  saveGroup: () => saveGroup()?.name ?? null,
  recallGroup: (name) => recallGroup(groups.find((group) => group.name === name)),
  renameGroup: (name, to) => renameGroup(groups.find((group) => group.name === name), to),
  deleteGroup: (name) => deleteGroup(groups.find((group) => group.name === name)),
  startRename,
  get groups() {
    return groups.map((group) => ({
      name: group.name,
      size: group.keys.size,
      active: group === activeGroup,
    }));
  },
  get expandedChains() {
    return Array.from(expandedChains);
  },
  get menuHeight() {
    return seqLayout.height;
  },
  // where a menu button is drawn, in the same form as sequenceCell
  menuButton(kind, rep) {
    const item = seqItems.find(
      (it) =>
        it.action &&
        it.action.kind === kind &&
        (it.action.rep ?? it.action.tool ?? it.action.chain?.key ?? it.action.group?.name) === rep,
    );
    const u = (item.x + item.w / 2) / SEQ_WIDTH;
    const v = (item.y + item.h / 2) / seqLayout.height;
    seqPanel.updateMatrixWorld(true);
    const world = seqPanel.localToWorld(new THREE.Vector3(u - 0.5, 0.5 - v, 0));
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(seqPanel.matrixWorld);
    return { u, v, world: world.toArray(), normal: normal.toArray() };
  },
  selectionExpression,
  toggleSequencePanel,
  get selectedKeys() {
    return Array.from(selectedKeys);
  },
  get selectionMarkerCount() {
    return selectionMarkers ? selectionMarkers.count : 0;
  },
  // one string of one-letter codes per chain, as the sequence window shows it
  get sequence() {
    return sequenceChains.map((c) => c.residues.map((r) => r.letter).join(""));
  },
  get sequencePanel() {
    return seqPanel;
  },
  // where residue `index` (sequence order) is drawn: as a fraction of the
  // canvas (for mouse tests) and as a world point on the 3D board
  sequenceCell(index) {
    const item = seqItems.find((it) => it.residue && it.residue.index === index);
    const u = (item.x + item.w / 2) / SEQ_WIDTH;
    const v = (item.y + item.h / 2) / seqLayout.height;
    seqPanel.updateMatrixWorld(true);
    const world = seqPanel.localToWorld(new THREE.Vector3(u - 0.5, 0.5 - v, 0));
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(seqPanel.matrixWorld);
    return { u, v, world: world.toArray(), normal: normal.toArray() };
  },
  get grabbers() {
    return grabbers.map((c) => controllers.indexOf(c));
  },
  // what one frame of holding the thumbstick at `stickY` for `dt` seconds does
  stickZoom: (stickY, dt) => zoomModel(stickZoomFactor(stickY, dt)),
  get model() {
    return currentModel;
  },
  // world position of the point zoom scales about (the molecule's centre)
  get zoomPivot() {
    return currentModel.localToWorld(currentFit.center.clone()).toArray();
  },
  // Deterministic measurement testing without raycasts: feed the active
  // measuring tool the atom nearest a point given in real atom coordinates.
  pickLocalPoint(x, y, z) {
    const atom = nearestAtom(getAtomGrids().all, x, y, z);
    if (!atom) return { ok: false, error: "no atoms loaded" };
    addPick(atom);
    return { ok: true, ...atom };
  },
  // what a controller's ray would pick right now, as "NAME (RESN123/A)"
  atomUnderController(i) {
    const atom = atomUnderController(controllers[i]);
    return atom ? describeAtom(atom) : null;
  },
  setTool,
  clearMeasurements,
  get tool() {
    return toolMode;
  },
  get measureHud() {
    return measureHud.textContent;
  },
  get pendingAtom() {
    return pendingPicks.length > 0 ? pendingPicks[0].atom : null;
  },
  get measurements() {
    return measurements.map((m) => ({
      kind: m.kind,
      value: m.value,
      text: m.text,
      atoms: m.atoms.map(describeAtom),
    }));
  },
  get measurementGroup() {
    return measurementGroup;
  },
  // H-bonds of the selection (or everything); both return a promise
  showHbonds: () => setHbondsShown(targetResidues(), true),
  hideHbonds: () => setHbondsShown(targetResidues(), false),
  get hbonds() {
    return {
      pairs: hbondPairs ? hbondPairs.length : null,
      shown: shownHbonds.size,
      dashes: hbondDashes ? hbondDashes.count : 0,
      shownPairs: (hbondPairs || [])
        .filter((pair) => shownHbonds.has(pair.key))
        .map((pair) => [describeAtom(pair.a), describeAtom(pair.b)]),
    };
  },
  addObject,
  removeObject,
  refreshObjects,
};

const moleculeSelect = document.getElementById("molecule-select");
const repCheckboxes = Array.from(
  document.querySelectorAll("#rep-checkboxes input[type=checkbox]"),
);
const showHydrogens = document.getElementById("show-hydrogens");
const showWaters = document.getElementById("show-waters");
const colorSelect = document.getElementById("color-select");
const stickRadius = document.getElementById("stick-radius");
const stickRadiusValue = document.getElementById("stick-radius-value");
const sphereScale = document.getElementById("sphere-scale");
const sphereScaleValue = document.getElementById("sphere-scale-value");
const cartoonFlatSheets = document.getElementById("cartoon-flat-sheets");
const cartoonSmoothLoops = document.getElementById("cartoon-smooth-loops");
const bgColor = document.getElementById("bg-color");
const resetViewButton = document.getElementById("reset-view");
const addObjectSelect = document.getElementById("add-object-select");
const addObjectButton = document.getElementById("add-object-button");
const objectList = document.getElementById("object-list");
const frameSection = document.getElementById("frame-section");
const frameSlider = document.getElementById("frame-slider");
const frameValue = document.getElementById("frame-value");

// Background is a pure display setting -- real PyMOL's bg_color never
// affects exported geometry either, so this is applied client-side only,
// instantly, with no server round trip.
bgColor.addEventListener("input", () => {
  scene.background = new THREE.Color(bgColor.value);
});

stickRadius.addEventListener("input", () => {
  stickRadiusValue.textContent = Number(stickRadius.value).toFixed(2);
});
sphereScale.addEventListener("input", () => {
  sphereScaleValue.textContent = Number(sphereScale.value).toFixed(2);
});

// The server (webxr/server.py) is single-threaded and serializes every
// /api/scene call behind one global lock -- and some representations
// (surface/mesh/dots) are genuinely slow to export. Firing a request on
// every single checkbox's own "change" event, with no cancellation, meant
// rapidly toggling several boxes (e.g. "select all") queued up a long
// backlog of expensive rebuilds: every response -- even stale ones from
// choices already superseded by later clicks -- unconditionally overwrote
// the view, so unchecking things (or switching molecule, which goes through
// this same function) just joined the back of the same queue and appeared
// to do nothing until the whole backlog finally drained. Fixed with three
// pieces together: (1) debounce coalesces a burst of rapid changes into one
// request for the *final* state instead of one request per intermediate
// state; (2) aborting the previous in-flight fetch when a new request
// starts stops the client waiting on/acting on a request that's already
// been superseded; (3) the sequence-number guard is the actual correctness
// backstop -- even if an old request's response arrives after a newer one
// (e.g. the old fetch was already too far along on the server to actually
// cancel), it gets discarded instead of clobbering the newer, correct state.
let sceneRequestSeq = 0;
let sceneRequestController = null;
let debounceTimer = null;
const APPLY_DEBOUNCE_MS = 300;

// The server can't actually be interrupted mid-render by a client-side abort
// (its single Python thread keeps executing the current /api/scene call to
// completion regardless of whether anyone's still listening for the
// response) -- so if several rebuilds are already genuinely queued (e.g. a
// user deliberately combining every representation, including the
// explicitly-slow surface/mesh/dots, really can take a long time to render:
// confirmed live, not assumed -- a fully-combined 1crn request left the
// server at 100% CPU for well over a minute, unresponsive to *any* other
// request meanwhile, not just scene ones), the honest thing to do is show
// that the app is genuinely busy and stop the user piling on more work,
// rather than pretending the controls are live when clicking them wouldn't
// visibly do anything until the backlog drains anyway.
const allControls = [
  moleculeSelect,
  ...repCheckboxes,
  showHydrogens,
  showWaters,
  colorSelect,
  stickRadius,
  sphereScale,
  cartoonFlatSheets,
  cartoonSmoothLoops,
  addObjectSelect,
  addObjectButton,
  frameSlider,
];

function setControlsBusy(busy) {
  allControls.forEach((el) => {
    el.disabled = busy;
  });
}

// --- multi-object support ---
//
// "molecule" (above) stays the single *primary* object ("mol" server-side,
// full-scene-reset semantics unchanged from before this feature existed --
// see webxr/server.py's api_scene). This section adds *additional* objects
// on top of it via `/api/objects`, so more than one molecule can be viewed
// (and grabbed/rotated together, since they're all children of the same
// glTF scene root) at once. Real PyMOL has no auto-layout for this; the
// server auto-arranges new objects along a simple world-space grid so they
// don't render on top of each other (real PDB coordinate frames are
// independent per structure and often overlap near the origin by chance).

function renderObjectList(objects) {
  objectList.innerHTML = "";
  for (const obj of objects) {
    if (obj.name === "mol") continue; // the primary object has its own dropdown, not a remove button
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${obj.molecule} (${obj.name})`;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "remove";
    removeButton.addEventListener("click", () => removeObject(obj.name));
    li.appendChild(label);
    li.appendChild(removeButton);
    objectList.appendChild(li);
  }
}

function applyObjectsAndFrame(data) {
  if (!data.objects) return;
  renderObjectList(data.objects);
  const maxStates = data.max_states || 1;
  frameSection.hidden = maxStates <= 1;
  frameSlider.max = maxStates;
  const frame = Math.min(Number(frameSlider.value) || 1, maxStates);
  frameSlider.value = frame;
  frameValue.textContent = `${frame} / ${maxStates}`;
}

async function refreshObjects() {
  if (staticManifest) return;
  const response = await fetch("/api/objects");
  const data = await response.json();
  if (data.ok) applyObjectsAndFrame(data);
}

async function addObject() {
  setControlsBusy(true);
  hud.textContent = `adding ${addObjectSelect.value} ...`;
  try {
    const response = await fetch("/api/objects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ molecule: addObjectSelect.value }),
    });
    const data = await response.json();
    if (!data.ok) {
      hud.textContent = `failed to add object: ${data.error}`;
      return;
    }
    applyObjectsAndFrame(data);
    await syncScene();
  } finally {
    refreshBusy();
  }
}

async function removeObject(name) {
  setControlsBusy(true);
  hud.textContent = `removing ${name} ...`;
  try {
    const response = await fetch(`/api/objects/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await response.json();
    if (!data.ok) {
      hud.textContent = `failed to remove object: ${data.error}`;
      return;
    }
    applyObjectsAndFrame(data);
    await syncScene();
  } finally {
    refreshBusy();
  }
}

addObjectButton.addEventListener("click", addObject);
frameSlider.addEventListener("input", () => {
  frameValue.textContent = `${frameSlider.value} / ${frameSlider.max}`;
});
frameSlider.addEventListener("change", scheduleApplySelection);

function scheduleApplySelection() {
  sceneChangePending = true;
  hud.textContent = "queued...";
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applySelection, APPLY_DEBOUNCE_MS);
}

// --- static (serverless) mode ---
//
// When served without webxr/server.py -- e.g. from GitHub Pages -- there is
// no /api to export scenes on demand. webxr/bake_static.py pre-exports a
// fixed grid of molecule x representation x color through the same real
// PyMOL pipeline and writes baked/manifest.json, pointed to by a meta tag
// in its copy of index.html; that switches the page to loading those files. Only controls with a baked equivalent
// stay visible: the baked representations, color scheme, background,
// selection, measure, reset view.
let staticManifest = null;
const staticAtomCache = new Map();

// bake_static.py marks its copy of index.html with this meta tag, so the
// live-server page never makes a probing request that would 404.
async function detectStaticMode() {
  const meta = document.querySelector('meta[name="vrpymol-static-manifest"]');
  if (!meta) return null;
  const response = await fetch(meta.content);
  return await response.json();
}

function setUpStaticControls(manifest) {
  document.querySelectorAll("[data-server-only]").forEach((el) => {
    el.hidden = true;
  });
  for (const option of Array.from(moleculeSelect.options)) {
    if (!manifest.molecules.includes(option.value)) option.remove();
  }
  for (const checkbox of repCheckboxes) {
    if (!manifest.reps.includes(checkbox.value)) checkbox.closest("label").remove();
  }
}

async function loadStaticAtoms(molecule) {
  if (!staticAtomCache.has(molecule)) {
    const response = await fetch(staticManifest.atoms[molecule]);
    staticAtomCache.set(molecule, await response.json());
  }
  return staticAtomCache.get(molecule);
}

async function applySelection() {
  if (staticManifest) {
    await syncScene();
    return;
  }
  const molecule = moleculeSelect.value;
  const hydrogens = showHydrogens.checked ? 1 : 0;
  const waters = showWaters.checked ? 1 : 0;
  const color = baseScheme;
  const cartoonFlatSheetsVal = cartoonFlatSheets.checked ? 1 : 0;
  const cartoonSmoothLoopsVal = cartoonSmoothLoops.checked ? 1 : 0;
  const frame = frameSlider.value;

  const mySeq = ++sceneRequestSeq;
  if (sceneRequestController) {
    sceneRequestController.abort();
  }
  sceneRequestController = new AbortController();
  // Stays busy until *this* (the latest) request's real response arrives --
  // not cleared on an abort, since an abort only means the client gave up
  // waiting for an older request; the server is still working through its
  // backlog up to and including whatever request is current now, and only
  // that request's own response proves the server has actually caught up.
  sceneRequestInFlight = true;
  refreshBusy();

  hud.textContent = `switching to ${molecule} ...`;
  let response;
  try {
    response = await fetch(
      // export=0: only update the PyMOL session; each representation is
      // then exported on its own by /api/layer as the scene needs it
      `/api/scene?export=0&molecule=${encodeURIComponent(molecule)}` +
        `&hydrogens=${hydrogens}&waters=${waters}` +
        `&color=${encodeURIComponent(color)}` +
        `&stick_radius=${stickRadius.value}&sphere_scale=${sphereScale.value}` +
        `&cartoon_flat_sheets=${cartoonFlatSheetsVal}&cartoon_smooth_loops=${cartoonSmoothLoopsVal}` +
        `&frame=${frame}`,
      { signal: sceneRequestController.signal },
    );
  } catch (error) {
    if (error.name === "AbortError") return; // superseded by a newer request
    sceneRequestInFlight = false;
    sceneChangePending = false;
    ensureLayers(); // the scene stays as it was: fetch what was held back
    hud.textContent = `failed to switch: ${error}`;
    return;
  }
  // A newer request has since been issued (and its own response may already
  // have loaded) -- this one is stale, don't let it overwrite newer state.
  if (mySeq !== sceneRequestSeq) return;
  sceneRequestInFlight = false;
  refreshBusy();
  if (!response.ok) {
    sceneChangePending = false;
    ensureLayers();
    hud.textContent = `failed to switch: ${response.status}`;
    return;
  }
  const data = await response.json();
  applyObjectsAndFrame(data);
  await syncScene();
}

// A representation checkbox shows or hides that representation for the
// selection, or for everything when nothing is selected. Nothing is sent to
// the server for this beyond fetching a layer the first time it is needed.
function syncRepControls() {
  for (const checkbox of repCheckboxes) {
    const count = shownByRep.get(checkbox.value)?.size ?? 0;
    checkbox.checked = count > 0;
    checkbox.indeterminate = count > 0 && count < allResidues.length; // only part of the scene
  }
}

moleculeSelect.addEventListener("change", scheduleApplySelection);
repCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => setRepShown(cb.value, targetResidues(), cb.checked));
});
showHydrogens.addEventListener("change", scheduleApplySelection);
showWaters.addEventListener("change", scheduleApplySelection);
// The dropdown shows the scene's scheme. Picking from it colours the
// selection if there is one (and then snaps back, since the scene's own
// scheme hasn't changed), otherwise the whole scene.
colorSelect.addEventListener("change", () => setScheme(colorSelect.value));
// "change" (commits on release), not "input" (fires every drag pixel) --
// rebuilding the scene re-exports the whole molecule server-side, too
// expensive to do on every intermediate slider value.
stickRadius.addEventListener("change", scheduleApplySelection);
sphereScale.addEventListener("change", scheduleApplySelection);
cartoonFlatSheets.addEventListener("change", scheduleApplySelection);
cartoonSmoothLoops.addEventListener("change", scheduleApplySelection);
resetViewButton.addEventListener("click", resetView);
window.vrPymolApplySelection = applySelection;

staticManifest = await detectStaticMode();
if (staticManifest) setUpStaticControls(staticManifest);
availableReps = repCheckboxes
  .map((checkbox) => checkbox.value)
  .filter((rep) => !staticManifest || staticManifest.reps.includes(rep));
availableReps.forEach((rep) => shownByRep.set(rep, new Set()));
await syncScene();
if (!staticManifest) refreshObjects();
