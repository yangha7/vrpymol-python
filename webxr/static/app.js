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
let currentFit = null; // {scale, position} computed once per load, reapplied by "reset view"
const loader = new GLTFLoader();

// Fit whatever PyMOL exported (arbitrary molecule size, arbitrary offset from
// its own camera-relative export) to a comfortable hand-held scale in front
// of the viewer. Computed once from the model's own (untransformed) bounds
// right after loading, then just reapplied verbatim on "reset view" -- no
// need to recompute from the model's current (already-transformed) state.
function computeFit(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const targetSize = 0.3;
  const scale = targetSize / maxDim;
  return {
    scale,
    // model-local (the freshly loaded model still has an identity transform
    // here), so it stays valid as the zoom pivot however the model is later
    // moved, rotated, scaled or reparented.
    center,
    position: new THREE.Vector3(
      MODEL_ANCHOR.x - center.x * scale,
      MODEL_ANCHOR.y - center.y * scale,
      MODEL_ANCHOR.z - center.z * scale,
    ),
  };
}

function applyFit(object, fit) {
  object.scale.setScalar(fit.scale);
  object.position.copy(fit.position);
}

let loadSeq = 0;

function loadScene(url) {
  const mySeq = ++loadSeq;
  hud.textContent = `loading ${url} ...`;
  loader.load(
    url,
    (gltf) => {
      // A newer load was started while this one downloaded (baked files can
      // be several MB) -- don't let the stale one replace it.
      if (mySeq !== loadSeq) return;
      if (currentModel) {
        currentModel.parent?.remove(currentModel);
      }
      grabbers.length = 0;
      twoHand = null;
      // Measurements are children of the old model (see ensureMeasurementGroup)
      // and get discarded along with it -- rebuilding the scene (molecule/rep/
      // color/setting change) always clears any in-progress or completed
      // measurement, same as it already resets grab/fit state above.
      measurementGroup = null;
      pendingAtom = null;
      if (measureHud) measureHud.textContent = " ";
      currentModel = gltf.scene;
      currentFit = computeFit(currentModel);
      applyFit(currentModel, currentFit);
      scene.add(currentModel);
      // Selection markers were children of the old model too. The static
      // build already has this molecule's atoms; the live server is asked
      // again, since objects and frames move atoms between scenes.
      selectionMarkers = null;
      if (staticManifest) rebuildSelectionMarkers();
      else refreshSceneAtoms(mySeq);
      hud.textContent = `loaded ${url}`;
    },
    undefined,
    (error) => {
      hud.textContent = `failed to load ${url}: ${error}`;
      console.error(error);
    },
  );
}

function resetView() {
  if (currentModel && currentFit) {
    // model may currently be parented to a controller (mid-grab) -- always
    // reattach to the scene first so the fit position below is world-space.
    scene.attach(currentModel);
    applyFit(currentModel, currentFit);
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
}

// `atoms` null means "between scenes": the table is emptied but the
// selection is kept, so it can be restored if the next scene is the same
// molecule (a representation or colour change).
function setSceneAtoms(atoms, objects) {
  sceneAtoms = atoms || [];
  buildResidues();
  if (atoms) {
    for (const key of Array.from(selectedKeys)) {
      const objectName = key.split("|")[0];
      if (objects[objectName] !== sceneObjects[objectName] || !residueByKey.has(key)) {
        selectedKeys.delete(key);
      }
    }
    sceneObjects = objects;
  }
  layoutSequence();
  selectionChanged();
}

async function refreshSceneAtoms(mySeq) {
  const response = await fetch("/api/atoms");
  const data = await response.json();
  if (mySeq !== loadSeq || !data.ok) return; // a newer scene has replaced this one
  setSceneAtoms(data.atoms, Object.fromEntries(data.objects.map((o) => [o.name, o.molecule])));
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

// --- sequence window ---
//
// One canvas, used twice: as an ordinary element in the desktop pop-out, and
// as the texture of a board in the 3D scene -- an immersive session shows
// only what WebGL draws, so an HTML pop-up would be invisible in the
// headset. Layout, drawing and hit-testing are shared; only the pointer
// differs (mouse position vs. where a controller ray meets the board).

const SEQ_WIDTH = 1024; // layout units; the canvas has SEQ_PIXEL_RATIO pixels per unit
const SEQ_PIXEL_RATIO = 2;
const SEQ_MAX_HEIGHT = 900;
const SEQ_PAD = 14;
const SEQ_HEADER = 78;
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
let seqItems = []; // hit targets: {x, y, w, h, residue} or {x, y, w, h, action}
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
  items.push({ x: SEQ_WIDTH - SEQ_PAD - 96, y: 10, w: 96, h: 34, action: "clear" });
  return { layout: { height: y + SEQ_PAD, cellW, cellH, tickSize, labels, ticks }, items };
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
  const status = seqHover?.residue
    ? describeResidue(seqHover.residue)
    : sequenceResidues.length === 0
      ? "no sequence loaded"
      : `${count} residue${count === 1 ? "" : "s"} selected`;
  ctx.fillText(status, SEQ_PAD + 150, 28);
  ctx.font = "14px monospace";
  ctx.fillStyle = "#9aa6cc";
  ctx.fillText(
    "trigger: select, sweep for a range | grip: grab | stick: zoom | A/B: hide this window",
    SEQ_PAD,
    58,
  );

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
      ctx.fillStyle = item === seqHover ? "#5a6a9a" : "#2a3558";
      ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.fillStyle = "#ffffff";
      ctx.font = "18px monospace";
      ctx.fillText(item.action, item.x + item.w / 2, item.y + item.h / 2);
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
  if (item.action === "clear") {
    clearSelection();
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
  toggleSequenceButton.textContent = sequencePopout.hidden ? "show sequence" : "hide sequence";
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

// Exposed so the Flask-served page (and Playwright tests) can trigger loads
// without a full page reload -- also used by the molecule/rep switcher below.
window.vrPymolLoadScene = loadScene;
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
    loadScene(`/scene.gltf?t=${Date.now()}`);
  } finally {
    setControlsBusy(false);
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
    loadScene(`/scene.gltf?t=${Date.now()}`);
  } finally {
    setControlsBusy(false);
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
// stay visible: one representation preset at a time (instead of free
// combination), color scheme, background, measure, reset view.
let staticManifest = null;
let staticAtoms = null;
const staticAtomCache = new Map();
let staticRepSelect = null;

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
  const repContainer = document.getElementById("rep-checkboxes");
  repContainer.hidden = true;
  document.getElementById("rep-heading").textContent = "representation";
  staticRepSelect = document.createElement("select");
  staticRepSelect.id = "rep-select";
  for (const rep of manifest.reps) {
    const option = document.createElement("option");
    option.value = rep;
    option.textContent = rep.replace("+", " + ");
    staticRepSelect.appendChild(option);
  }
  repContainer.after(staticRepSelect);
  staticRepSelect.addEventListener("change", scheduleApplySelection);
  allControls.push(staticRepSelect);
}

async function loadStaticAtoms(molecule) {
  if (!staticAtomCache.has(molecule)) {
    const response = await fetch(staticManifest.atoms[molecule]);
    staticAtomCache.set(molecule, await response.json());
  }
  return staticAtomCache.get(molecule);
}

async function applyStaticSelection() {
  const molecule = moleculeSelect.value;
  const rep = staticRepSelect.value;
  const color = colorSelect.value;
  const url = staticManifest.files[`${molecule}|${rep}|${color}`];
  if (!url) {
    hud.textContent = `${molecule} has nothing to show as ${rep} -- try another representation`;
    return;
  }
  const mySeq = ++sceneRequestSeq;
  staticAtoms = null; // never pick against the previous molecule's atoms
  setSceneAtoms(null);
  loadScene(url);
  const atoms = await loadStaticAtoms(molecule);
  if (mySeq === sceneRequestSeq) {
    staticAtoms = atoms;
    setSceneAtoms(atoms, { mol: molecule });
  }
}

async function applySelection() {
  if (staticManifest) {
    await applyStaticSelection();
    return;
  }
  const molecule = moleculeSelect.value;
  const reps = repCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  if (reps.length === 0) {
    hud.textContent = "select at least one representation";
    return;
  }
  const rep = reps.join("+");
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
  setControlsBusy(true);

  const SLOW_REPS = ["surface", "mesh", "dots"];
  const includesSlowRep = reps.some((r) => SLOW_REPS.includes(r));
  hud.textContent = includesSlowRep
    ? `switching to ${molecule} / ${rep} ... (surface/mesh/dots can take a while, controls disabled until it finishes)`
    : `switching to ${molecule} / ${rep} ...`;
  let response;
  try {
    response = await fetch(
      `/api/scene?molecule=${encodeURIComponent(molecule)}` +
        `&rep=${encodeURIComponent(rep)}` +
        `&hydrogens=${hydrogens}&waters=${waters}` +
        `&color=${encodeURIComponent(color)}` +
        `&stick_radius=${stickRadius.value}&sphere_scale=${sphereScale.value}` +
        `&cartoon_flat_sheets=${cartoonFlatSheetsVal}&cartoon_smooth_loops=${cartoonSmoothLoopsVal}` +
        `&frame=${frame}`,
      { signal: sceneRequestController.signal },
    );
  } catch (error) {
    if (error.name === "AbortError") return; // superseded by a newer request
    setControlsBusy(false);
    hud.textContent = `failed to switch: ${error}`;
    return;
  }
  // A newer request has since been issued (and its own response may already
  // have loaded) -- this one is stale, don't let it overwrite newer state.
  if (mySeq !== sceneRequestSeq) return;
  setControlsBusy(false);
  if (!response.ok) {
    hud.textContent = `failed to switch: ${response.status}`;
    return;
  }
  const data = await response.json();
  applyObjectsAndFrame(data);
  // cache-bust: the server overwrites the same path each time, and the
  // no-store header on /scene.gltf covers most browsers, but GLTFLoader's
  // internal fetch caching is bypassed reliably with a query param too.
  loadScene(`/scene.gltf?t=${Date.now()}`);
}

moleculeSelect.addEventListener("change", scheduleApplySelection);
repCheckboxes.forEach((cb) => cb.addEventListener("change", scheduleApplySelection));
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
if (staticManifest) {
  setUpStaticControls(staticManifest);
  await applyStaticSelection();
} else {
  loadScene("/scene.gltf");
  refreshObjects();
}
