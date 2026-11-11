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
  pendingAtom = null;
  measureHud.textContent = " ";
  selectionMarkers = null;
  currentModel = new THREE.Group();
  currentModel.name = "molecule";
  currentFit = fitToAtoms(atoms);
  applyFit(currentModel, currentFit);
  scene.add(currentModel);
}

let availableReps = []; // representations this build can draw, in menu order
const shownByRep = new Map(); // rep -> Set of residue keys drawn in that rep
const layers = new Map(); // rep -> {rep, state: "loading"|"ready"|"missing", root, parts}
let staleLayers = []; // previous scene's layers, kept on screen until the new ones arrive
let sceneRequestInFlight = false;

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
    parts.push({ object, source, owner, index, visibleTriangles: 0 });
  });
  return parts;
}

function applyLayerMask(layer) {
  const mask = new Uint8Array(allResidues.length);
  for (const key of shownByRep.get(layer.rep)) {
    const residue = residueByKey.get(key);
    if (residue) mask[residue.ordinal] = 1;
  }
  for (const part of layer.parts) {
    const out = part.index.array;
    let n = 0;
    for (let t = 0; t < part.owner.length; t++) {
      const ordinal = part.owner[t];
      if (ordinal < 0 || !mask[ordinal]) continue;
      out[n++] = part.source[3 * t];
      out[n++] = part.source[3 * t + 1];
      out[n++] = part.source[3 * t + 2];
    }
    part.index.needsUpdate = true;
    part.object.geometry.setDrawRange(0, n);
    part.object.visible = n > 0;
    part.visibleTriangles = n / 3;
  }
}

function layerUrl(rep) {
  if (staticManifest) {
    return staticManifest.files[`${sceneObjects.mol}|${rep}|${colorSelect.value}`] || null;
  }
  // cache-bust: the server re-exports on every request
  return `/api/layer?rep=${encodeURIComponent(rep)}&t=${Date.now()}`;
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
  if (nothingShown && availableReps.includes("sticks") && layers.get("sticks")?.state !== "missing") {
    allResidues.forEach((residue) => shownByRep.get("sticks").add(residue.key));
  }
  layerSettled();
  representationChanged();
}

function loadLayer(rep) {
  const layer = { rep, state: "loading", root: null, parts: [] };
  layers.set(rep, layer);
  const url = layerUrl(rep);
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
      if (layers.get(rep) !== layer) return;
      layer.root = gltf.scene;
      layer.root.name = `layer-${rep}`;
      layer.parts = buildLayerParts(layer.root, rep);
      currentModel.add(layer.root);
      layer.state = "ready";
      applyLayerMask(layer);
      hud.textContent = `loaded ${url}`;
      layerSettled();
    },
    undefined,
    (error) => {
      if (layers.get(rep) !== layer) return;
      console.warn(`no ${rep} layer:`, error);
      layerMissing(layer);
    },
  );
}

// Bring what is drawn in line with `shownByRep`: fetch layers that are now
// needed, and re-mask the ones already loaded.
function ensureLayers() {
  for (const rep of availableReps) {
    const layer = layers.get(rep);
    if (!layer) {
      if (shownByRep.get(rep).size > 0) loadLayer(rep);
    } else if (layer.state === "ready") {
      applyLayerMask(layer);
    }
  }
  layerSettled();
}

function representationChanged() {
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
}

// Reload the scene after the molecule, objects, frame, colouring or an
// export setting changed: new atom table, new layers. The view and what is
// shown where are kept when the objects are the same ones as before.
let sceneEpoch = 0;
async function syncScene() {
  const epoch = ++sceneEpoch;
  staleLayers.push(...layers.values());
  layers.clear();
  let atoms;
  let objects;
  if (staticManifest) {
    const molecule = moleculeSelect.value;
    staticAtoms = null; // never pick against the previous molecule's atoms
    atoms = await loadStaticAtoms(molecule);
    objects = { mol: molecule };
    if (epoch !== sceneEpoch) return;
    staticAtoms = atoms;
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

// --- click-to-measure ---
//
// Real per-atom picking without threading a custom atom-ID through the
// batched glyph geometry/glTF export (a real risk not worth taking: the
// mesh_loader pipeline already found vtkGLTFExporter silently drops things
// it doesn't understand, e.g. vtkGlyph3DMapper actors export as empty).
// Instead a raycast hit's *world* point is inverted back into the model's
// own local space via `worldToLocal` -- glTF export bakes real absolute
// PyMOL/PDB Angstrom coordinates straight into vertex positions with no
// extra node transform in between, so this recovers real molecule-space
// coordinates regardless of the model's current fit/grab/scale transform --
// and the server (`/api/pick`) finds the real nearest atom from that point.
//
// Exclusive with orbit-drag rather than trying to distinguish a click from
// a drag-release: toggling measure mode on disables OrbitControls, so every
// click on the canvas is unambiguously a measurement pick.

const measureToggle = document.getElementById("measure-mode");
const measureHud = document.getElementById("measure-hud");
const clearMeasurementsButton = document.getElementById("clear-measurements");
const MARKER_RADIUS = 0.3; // Angstroms -- small relative to a ~1.5A atom radius
const PENDING_COLOR = 0xffee00;
const DONE_COLOR = 0x00e5ff;

let pendingAtom = null; // {index, name, resn, resi, coord, marker}
let measurementGroup = null; // THREE.Group, child of currentModel

function ensureMeasurementGroup() {
  if (!currentModel) return null;
  if (!measurementGroup || measurementGroup.parent !== currentModel) {
    measurementGroup = new THREE.Group();
    measurementGroup.name = "measurements";
    currentModel.add(measurementGroup);
  }
  return measurementGroup;
}

function addMarker(coord, color) {
  const group = ensureMeasurementGroup();
  const geometry = new THREE.SphereGeometry(MARKER_RADIUS, 12, 12);
  // depthTest off + high renderOrder: a marker at an atom's exact center is
  // otherwise always fully enclosed by (and invisible inside) that atom's
  // own much larger sphere, regardless of camera angle. Real PyMOL's own
  // selection indicators are small dots drawn the same way -- ignoring the
  // depth buffer so they show through solid geometry -- not a workaround
  // invented for this project.
  const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.set(coord[0], coord[1], coord[2]);
  marker.renderOrder = 999;
  group.add(marker);
  return marker;
}

function addLine(coordA, coordB) {
  const group = ensureMeasurementGroup();
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...coordA),
    new THREE.Vector3(...coordB),
  ]);
  // Same depthTest-off reasoning as addMarker -- a line between two atom
  // centers otherwise runs straight through the molecule's own opaque
  // geometry and would be mostly hidden.
  const material = new THREE.LineBasicMaterial({ color: DONE_COLOR, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 999;
  group.add(line);
  return line;
}

function describeAtom(atom) {
  return `${atom.name} (${atom.resn}${atom.resi}${atom.chain ? "/" + atom.chain : ""})`;
}

async function fetchDistance(a, b) {
  if (staticManifest) {
    // Same quantity real PyMOL's cmd.get_distance returns for two atoms:
    // plain Euclidean distance between their coordinates.
    const distance = Math.hypot(
      a.coord[0] - b.coord[0],
      a.coord[1] - b.coord[1],
      a.coord[2] - b.coord[2],
    );
    measureHud.textContent = `${describeAtom(a)} ↔ ${describeAtom(b)}: ${distance.toFixed(2)} Å`;
    return;
  }
  const response = await fetch(`/api/distance?atom1=${a.index}&atom2=${b.index}`);
  const data = await response.json();
  if (!data.ok) {
    measureHud.textContent = `distance lookup failed: ${data.error}`;
    return;
  }
  measureHud.textContent = `${describeAtom(a)} ↔ ${describeAtom(b)}: ${data.distance.toFixed(2)} Å`;
}

function handlePickedAtom(atom) {
  if (pendingAtom && pendingAtom.index === atom.index) {
    measureHud.textContent = `${describeAtom(atom)} selected -- click a different atom to measure`;
    return;
  }
  if (!pendingAtom) {
    const marker = addMarker(atom.coord, PENDING_COLOR);
    pendingAtom = { ...atom, marker };
    measureHud.textContent = `${describeAtom(atom)} selected -- click a second atom`;
    return;
  }
  pendingAtom.marker.material.color.setHex(DONE_COLOR);
  addMarker(atom.coord, DONE_COLOR);
  addLine(pendingAtom.coord, atom.coord);
  fetchDistance(pendingAtom, atom);
  pendingAtom = null;
}

// Static mode's stand-in for /api/pick: same nearest-atom search, over the
// real PyMOL atom table baked alongside the molecule (webxr/bake_static.py).
function pickNearestBakedAtom(x, y, z) {
  if (!staticAtoms || staticAtoms.length === 0) {
    return { ok: false, error: "atom table not loaded yet" };
  }
  let best = null;
  let bestDist = Infinity;
  for (const atom of staticAtoms) {
    const [ax, ay, az] = atom.coord;
    const dist = (ax - x) ** 2 + (ay - y) ** 2 + (az - z) ** 2;
    if (dist < bestDist) {
      best = atom;
      bestDist = dist;
    }
  }
  return { ok: true, ...best };
}

async function pickLocalPoint(x, y, z) {
  let atom;
  if (staticManifest) {
    atom = pickNearestBakedAtom(x, y, z);
  } else {
    const response = await fetch(`/api/pick?x=${x}&y=${y}&z=${z}`);
    atom = await response.json();
  }
  if (!atom.ok) {
    measureHud.textContent = `pick failed: ${atom.error}`;
    return null;
  }
  handlePickedAtom(atom);
  return atom;
}

function onCanvasClick(event) {
  if (!measureToggle.checked || !currentModel) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(currentModel, true);
  if (hits.length === 0) return;
  const localPoint = currentModel.worldToLocal(hits[0].point.clone());
  pickLocalPoint(localPoint.x, localPoint.y, localPoint.z);
}

function clearMeasurements() {
  if (measurementGroup) {
    measurementGroup.parent?.remove(measurementGroup);
    measurementGroup = null;
  }
  pendingAtom = null;
  measureHud.textContent = " ";
}

renderer.domElement.addEventListener("click", onCanvasClick);
measureToggle.addEventListener("change", () => {
  controls.enabled = !measureToggle.checked;
  if (!measureToggle.checked && pendingAtom) {
    pendingAtom.marker.material.color.setHex(DONE_COLOR);
    pendingAtom = null;
  }
});
clearMeasurementsButton.addEventListener("click", clearMeasurements);

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

const selectToggle = document.getElementById("select-mode");
const selectionHud = document.getElementById("selection-hud");
const clearSelectionButton = document.getElementById("clear-selection");
const toggleSequenceButton = document.getElementById("toggle-sequence");
const sequencePopout = document.getElementById("sequence-popout");

let sceneAtoms = [];
let sceneObjects = {}; // object name -> molecule id, to tell when a selection is stale
let residueByKey = new Map(); // every residue, waters included
let allResidues = []; // the same, as a list; residue.ordinal is its position here
let sequenceResidues = []; // the ones shown in the sequence, in display order
let sequenceChains = []; // [{object, chain, residues}]
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
          chains.set(chainKey, { object: atom.object, chain: atom.chain, residues: [] });
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
  for (const key of Array.from(selectedKeys)) {
    if (isStale(key)) selectedKeys.delete(key);
  }
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
  layoutSequence();
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

// Desktop: a click selects, a drag still orbits -- told apart by how far the
// pointer travelled, so select mode doesn't have to switch orbiting off.
let pointerDownAt = null;
renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerDownAt = [event.clientX, event.clientY];
});
renderer.domElement.addEventListener("click", (event) => {
  if (!selectToggle.checked || !currentModel || !pointerDownAt) return;
  if (Math.hypot(event.clientX - pointerDownAt[0], event.clientY - pointerDownAt[1]) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(currentModel, true);
  if (hits.length > 0) selectWorldPoint(hits[0].point);
});
// One click can't mean both "measure" and "select".
selectToggle.addEventListener("change", () => {
  if (selectToggle.checked && measureToggle.checked) measureToggle.click();
});
measureToggle.addEventListener("change", () => {
  if (measureToggle.checked) selectToggle.checked = false;
});
clearSelectionButton.addEventListener("click", clearSelection);
document.getElementById("select-all").addEventListener("click", () => {
  setResiduesSelected(allResidues, true);
});
document.getElementById("invert-selection").addEventListener("click", invertSelection);

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
const SEQ_ROW_HIDE = 114;
const SEQ_ROW_SELECT = 152;
const SEQ_ROW_HEIGHT = 32;
const SEQ_ROW_LABEL = 70; // width of the "show"/"hide"/"select" labels
const SEQ_BUTTON_GAP = 6;
const SEQ_HEADER = 204; // where the sequence starts
const SEQ_GUTTER = 84;
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

let seqLayout = { height: SEQ_HEADER + SEQ_PAD, cellW: 0, cellH: 0, labels: [], ticks: [] };
let seqItems = []; // hit targets: {x, y, w, h, residue} or {x, y, w, h, action: {kind, rep, label}}
let seqHover = null;
let seqDrag = null; // {source, add, lastIndex} while a sweep is in progress
let seqDirty = true;

function requestSequenceRedraw() {
  seqDirty = true;
}

function layoutSequenceWith(columns) {
  const cellW = (SEQ_WIDTH - 2 * SEQ_PAD - SEQ_GUTTER) / columns;
  const cellH = Math.min(34, Math.max(14, cellW * 1.5));
  const tickSize = Math.min(13, Math.max(9, cellW * 0.6));
  const multipleObjects = Object.keys(sceneObjects).length > 1;
  const items = [];
  const labels = [];
  const ticks = [];
  const left = SEQ_PAD + SEQ_GUTTER;
  let y = SEQ_HEADER;
  for (const chain of sequenceChains) {
    const name = chain.chain || "-";
    labels.push({
      text: multipleObjects ? `${chain.object}:${name}` : `chain ${name}`,
      y: y + tickSize + cellH / 2,
    });
    let tickFreeFrom = 0;
    chain.residues.forEach((residue, i) => {
      const column = i % columns;
      if (i > 0 && column === 0) {
        y += tickSize + cellH + 4;
        tickFreeFrom = 0;
      }
      const x = left + column * cellW;
      const numbered = i === 0 || (/^-?\d+$/.test(residue.resi) && Number(residue.resi) % 10 === 0);
      if (numbered && x >= tickFreeFrom) {
        ticks.push({ text: residue.resi, x, y: y + tickSize - 2 });
        tickFreeFrom = x + residue.resi.length * tickSize * 0.62 + 3;
      }
      items.push({ x, y: y + tickSize, w: cellW, h: cellH, residue });
    });
    y += tickSize + cellH + 12;
  }
  items.push(...menuButtons());
  return { layout: { height: y + SEQ_PAD, cellW, cellH, tickSize, labels, ticks }, items };
}

// The button rows: show and hide per representation (PyMOL's S and H
// menus), then the selection helpers.
function menuButtons() {
  const items = [];
  const left = SEQ_PAD + SEQ_ROW_LABEL;
  const slots = availableReps.length + 1; // the hide row has one extra: "everything"
  const width = (SEQ_WIDTH - SEQ_PAD - left + SEQ_BUTTON_GAP) / slots - SEQ_BUTTON_GAP;
  const button = (slot, y, w, action) => ({
    x: left + slot * (w + SEQ_BUTTON_GAP),
    y,
    w,
    h: SEQ_ROW_HEIGHT,
    action,
  });
  availableReps.forEach((rep, i) => {
    items.push(button(i, SEQ_ROW_SHOW, width, { kind: "show", rep, label: rep }));
    items.push(button(i, SEQ_ROW_HIDE, width, { kind: "hide", rep, label: rep }));
  });
  items.push(button(availableReps.length, SEQ_ROW_HIDE, width, { kind: "hideAll", label: "everything" }));
  ["selectAll", "invert", "clear"].forEach((kind, i) => {
    const label = { selectAll: "all", invert: "invert", clear: "none" }[kind];
    items.push(button(i, SEQ_ROW_SELECT, 110, { kind, label }));
  });
  return items;
}

function describeTarget() {
  const count = selectedKeys.size;
  return count > 0 ? `the selection (${count} residue${count === 1 ? "" : "s"})` : "the whole molecule";
}

function describeAction(action) {
  switch (action.kind) {
    case "show":
      return `show ${describeTarget()} as ${action.rep}`;
    case "hide":
      return `hide ${action.rep} of ${describeTarget()}`;
    case "hideAll":
      return `hide ${describeTarget()} completely`;
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
  ctx.fillText("Sequence", SEQ_PAD, 28);
  ctx.font = "18px monospace";
  ctx.fillStyle = SEQ_SELECTED_COLOR;
  const count = selectedResidues().length;
  let status;
  if (seqHover?.residue) status = describeResidue(seqHover.residue);
  else if (seqHover?.action) status = describeAction(seqHover.action);
  else if (anyLayerLoading()) status = "loading ...";
  else if (sequenceResidues.length === 0) status = "no sequence loaded";
  else status = `${count} residue${count === 1 ? "" : "s"} selected`;
  ctx.fillText(status, SEQ_PAD + 150, 28);
  ctx.font = "14px monospace";
  ctx.fillStyle = "#9aa6cc";
  ctx.fillText(
    "trigger: press a button or a residue, sweep for a range | grip: grab | stick: zoom | A/B: hide this window",
    SEQ_PAD,
    56,
  );

  ctx.font = "16px monospace";
  ctx.fillStyle = "#c8d0ee";
  const rowMiddle = SEQ_ROW_HEIGHT / 2 + 1;
  ctx.fillText("show", SEQ_PAD, SEQ_ROW_SHOW + rowMiddle);
  ctx.fillText("hide", SEQ_PAD, SEQ_ROW_HIDE + rowMiddle);
  ctx.fillText("select", SEQ_PAD, SEQ_ROW_SELECT + rowMiddle);
  ctx.fillStyle = "#9aa6cc";
  ctx.fillText(
    `show and hide act on ${describeTarget()}`,
    SEQ_PAD + SEQ_ROW_LABEL + 3 * (110 + SEQ_BUTTON_GAP) + 10,
    SEQ_ROW_SELECT + rowMiddle,
  );
  const target = targetResidues();

  ctx.fillStyle = "#c8d0ee";
  for (const label of seqLayout.labels) ctx.fillText(label.text, SEQ_PAD, label.y, SEQ_GUTTER - 8);
  ctx.font = `${seqLayout.tickSize}px monospace`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8090b8";
  for (const tick of seqLayout.ticks) ctx.fillText(tick.text, tick.x, tick.y);

  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const letterSize = Math.min(seqLayout.cellH * 0.75, seqLayout.cellW * 1.3);
  for (const item of seqItems) {
    if (item.action) {
      // a "show" button is lit while any of the target is drawn that way
      const lit =
        item.action.kind === "show" &&
        target.some((residue) => shownByRep.get(item.action.rep).has(residue.key));
      ctx.fillStyle = item === seqHover ? "#5a6a9a" : lit ? "#2f7d5b" : "#2a3558";
      ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.fillStyle = "#ffffff";
      ctx.font = "15px monospace";
      ctx.fillText(item.action.label, item.x + item.w / 2, item.y + item.h / 2 + 1, item.w - 6);
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
// On the sequence board the trigger presses whatever the ray is on;
// otherwise it selects the residue the ray hits on the molecule.
function onTriggerStart(event) {
  const controller = event.target;
  const item = panelItemAt(controller);
  if (item !== undefined) {
    sequencePointerDown(item, controller);
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
  layerState: (rep) => layers.get(rep)?.state ?? "unloaded",
  // {total, visible} triangle counts of a loaded layer
  layerTriangles(rep) {
    const parts = layers.get(rep)?.parts ?? [];
    return {
      total: parts.reduce((sum, part) => sum + part.owner.length, 0),
      visible: parts.reduce((sum, part) => sum + part.visibleTriangles, 0),
    };
  },
  // where a menu button is drawn, in the same form as sequenceCell
  menuButton(kind, rep) {
    const item = seqItems.find((it) => it.action && it.action.kind === kind && it.action.rep === rep);
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
  // deterministic measurement testing, bypassing real mouse-event/raycast
  // coordinate math (which real clicks still exercise via onCanvasClick):
  // tests can pass known real PyMOL atom-space coordinates directly.
  pickLocalPoint,
  clearMeasurements,
  get measureHud() {
    return measureHud.textContent;
  },
  get pendingAtom() {
    return pendingAtom ? { ...pendingAtom, marker: undefined } : null;
  },
  get measurementGroup() {
    return measurementGroup;
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
let staticAtoms = null;
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
  const color = colorSelect.value;
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
    refreshBusy();
    hud.textContent = `failed to switch: ${error}`;
    return;
  }
  // A newer request has since been issued (and its own response may already
  // have loaded) -- this one is stale, don't let it overwrite newer state.
  if (mySeq !== sceneRequestSeq) return;
  sceneRequestInFlight = false;
  refreshBusy();
  if (!response.ok) {
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
colorSelect.addEventListener("change", scheduleApplySelection);
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
