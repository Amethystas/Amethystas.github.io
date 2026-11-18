import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeRepeatedSegments } from './engineering-lines';
import { normalizeId, readModelId } from './model-id';

type View = 'front' | 'left' | 'top' | 'iso';
type ModelEntry = {
  id: string; version: string; glb: string; edges: string;
  deflectionMM: number;
  bounds: { min: number[]; max: number[] };
  views: Record<View, { url: string; projection: number[][] }>;
};
type Catalog = { models: ModelEntry[] };
const views: View[] = ['front', 'left', 'top', 'iso'];
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main aria-label="模型展示">
    <div id="canvas" hidden></div><div id="lines" aria-hidden="true"></div>
    <img id="error-image" alt="" hidden>
  </main>
  <nav aria-label="视图方向">
    <button data-view="front" aria-pressed="false" disabled>主视图</button>
    <button data-view="left" aria-pressed="false" disabled>左视图</button>
    <button data-view="top" aria-pressed="false" disabled>俯视图</button>
    <button data-view="iso" aria-pressed="false" disabled>轴测图</button>
  </nav>`;
const viewport = document.querySelector('main')!;
const host = document.querySelector<HTMLDivElement>('#canvas')!;
const lines = document.querySelector<HTMLDivElement>('#lines')!;
const errorImage = document.querySelector<HTMLImageElement>('#error-image')!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
const base = new URL(import.meta.env.BASE_URL, location.href);
const target = new THREE.Vector3();
const directions: Record<View, THREE.Vector3> = {
  front: new THREE.Vector3(0, -1, 0), left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, 0, 1), iso: new THREE.Vector3(-1.1, -1.5, 1).normalize(),
};
let catalogPromise: Promise<Catalog> | undefined;
let selected: ModelEntry | undefined;
let currentView: View | null = null;
let fitHeight = 100;
let diagonal = 100;
let hasWebGL = true;
let renderer: THREE.WebGLRenderer;
let graphicsReady = false;
let camera: THREE.OrthographicCamera;
let scene: THREE.Scene;
let controls: OrbitControls;
let modelGroup: THREE.Group | undefined;
let wires: THREE.Group | undefined;
let drawings: Partial<Record<View, string>> = {};
let modelLoading = false;
let overlayReady = false;
let linesDirty = true;
let loadSequence = 0;
let pendingFetch: AbortController | undefined;
let transition: { start: number; from: THREE.Vector3; to: THREE.Vector3; upFrom: THREE.Vector3; upTo: THREE.Vector3 } | null = null;

function asset(url: string, model: ModelEntry) {
  const result = new URL(url, base);
  result.searchParams.set('v', model.version);
  return result.href;
}
function updateButtons() {
  buttons.forEach(button => {
    button.disabled = !selected || modelLoading;
    button.setAttribute('aria-pressed', String(button.dataset.view === currentView));
  });
  if (wires) wires.visible = !overlayReady;
}
function invalidateLines() {
  linesDirty = true;
  if (!hasWebGL) showLines();
}
function hideLines() {
  overlayReady = false;
  lines.innerHTML = '';
  linesDirty = true;
}
function poseMatches(view: View) {
  if (!selected) return false;
  const normal = camera.position.clone().sub(controls.target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, normal).normalize();
  const down = new THREE.Vector3().crossVectors(normal, right).negate();
  const p = selected.views[view].projection;
  // OrbitControls在极点附近保留微小偏移；同时检查方向和画面旋转。
  return right.distanceTo(new THREE.Vector3(...p[0] as [number, number, number])) < 1e-5
    && down.distanceTo(new THREE.Vector3(...p[1] as [number, number, number])) < 1e-5;
}
function showLines() {
  lines.innerHTML = '';
  lines.classList.toggle('fallback', !hasWebGL);
  if (!selected || modelLoading || !currentView || transition || !drawings[currentView]) return;
  if (!hasWebGL) {
    const doc = new DOMParser().parseFromString(drawings[currentView]!, 'image/svg+xml');
    removeRepeatedSegments(doc);
    lines.innerHTML = doc.documentElement.outerHTML;
    return;
  }
  if (!overlayReady) return;
  const scale = viewport.clientHeight / fitHeight * camera.zoom;
  const p = selected.views[currentView].projection;
  const focus = controls.target.toArray();
  const x = p[0].reduce((sum, value, i) => sum + value * focus[i], 0);
  const y = p[1].reduce((sum, value, i) => sum + value * focus[i], 0);
  const doc = new DOMParser().parseFromString(drawings[currentView]!, 'image/svg+xml');
  removeRepeatedSegments(doc);
  doc.querySelectorAll('.center, rect').forEach(node => node.remove());
  doc.querySelectorAll('path').forEach(path => path.setAttribute('vector-effect', 'non-scaling-stroke'));
  doc.querySelector('.visible')?.setAttribute('stroke-width', '1.5');
  const hidden = doc.querySelector('.hidden');
  hidden?.setAttribute('stroke-width', '.75');
  hidden?.setAttribute('stroke-dasharray', '8 5');
  hidden?.setAttribute('stroke-linecap', 'butt');
  lines.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${viewport.clientWidth} ${viewport.clientHeight}" fill="none" stroke="#202020"><g transform="translate(${viewport.clientWidth / 2 - x * scale} ${viewport.clientHeight / 2 - y * scale}) scale(${scale})">${doc.documentElement.innerHTML}</g></svg>`;
}
function resize() {
  if (!hasWebGL) { showLines(); return; }
  if (!graphicsReady) return;
  const width = Math.max(1, viewport.clientWidth), height = Math.max(1, viewport.clientHeight);
  const aspect = width / height;
  // 四个方向共用包围球和正交比例，切换方向时不重新适配尺寸。
  fitHeight = diagonal * 1.15 * Math.max(1, 1 / aspect);
  controls.maxZoom = Math.max(1, Math.min(10, .25 * fitHeight / ((selected?.deflectionMM ?? .002) * height)));
  camera.zoom = Math.min(camera.zoom, controls.maxZoom);
  camera.left = -fitHeight * aspect / 2; camera.right = -camera.left;
  camera.top = fitHeight / 2; camera.bottom = -camera.top;
  camera.updateProjectionMatrix(); renderer.setSize(width, height); invalidateLines();
}
function setView(view: View, immediate = false) {
  if (!selected || modelLoading) return;
  // 等三维画面转到目标方向后，再叠加对应的工程线。
  hideLines();
  if (hasWebGL) { controls.enableDamping = false; controls.update(); controls.enableDamping = true; }
  currentView = view; lines.innerHTML = '';
  if (!hasWebGL) { updateButtons(); showLines(); return; }
  // 只在换模型时居中；方向按钮保留用户的缩放和平移。
  if (immediate) { camera.zoom = 1; controls.target.copy(target); resize(); }
  const distance = immediate ? diagonal * 3 + 100 : camera.position.distanceTo(controls.target);
  const destination = controls.target.clone().addScaledVector(directions[view], distance);
  const up = view === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  if (immediate) {
    transition = null; camera.position.copy(destination); camera.up.copy(up); controls.update();
  } else transition = { start: performance.now(), from: camera.position.clone(), to: destination, upFrom: camera.up.clone(), upTo: up };
  updateButtons();
}
function animate() {
  requestAnimationFrame(animate);
  if (transition) {
    const t = Math.min(1, (performance.now() - transition.start) / 450);
    const s = t * t * (3 - 2 * t);
    camera.position.lerpVectors(transition.from, transition.to, s);
    camera.up.lerpVectors(transition.upFrom, transition.upTo, s).normalize();
    if (t === 1) transition = null;
  }
  controls.update();
  const ready = !!selected && !modelLoading && !transition && currentView !== null && poseMatches(currentView);
  if (overlayReady !== ready) { overlayReady = ready; linesDirty = true; updateButtons(); }
  renderer.render(scene, camera);
  // 先渲染实体，再呈现同一相机位置的SVG。
  if (linesDirty) { showLines(); linesDirty = false; }
}
function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse(node => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
      geometries.add(node.geometry);
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => materials.add(material));
    }
  });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
}
async function fetchOK(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
function clearModel() {
  if (modelGroup) {
    scene.remove(modelGroup);
    disposeObject(modelGroup);
    modelGroup = undefined;
  }
  selected = undefined;
  wires = undefined;
  transition = null;
  drawings = {};
  currentView = null;
  modelLoading = false;
  host.hidden = true;
  errorImage.hidden = true;
  hideLines();
  updateButtons();
}

function showError(error: unknown) {
  console.error(error);
  clearModel();
  errorImage.src = new URL('invalid-model.gif', base).href;
  errorImage.hidden = false;
}

function initGraphics() {
  if (graphicsReady || !hasWebGL) return;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0xf5f5f5);
    host.append(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-60, 60, 50, -50, .01, 10000);
    camera.up.set(0, 0, 1);
    camera.position.copy(directions.iso).multiplyScalar(300);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minZoom = 1;
    controls.maxZoom = 10;
    controls.addEventListener('start', () => { transition = null; hideLines(); });
    controls.addEventListener('change', () => {
      if (transition || modelLoading || !selected) return;
      if (currentView && !poseMatches(currentView)) {
        currentView = null;
        updateButtons();
      }
      invalidateLines();
    });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x83909e, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3.2);
    light.position.set(-60, -80, 160);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xffffff, 1);
    fill.position.set(100, 80, 30);
    scene.add(fill);
    graphicsReady = true;
    resize();
    animate();
  } catch (error) {
    console.warn('WebGL不可用，改用工程视图。', error);
    controls?.dispose();
    renderer?.dispose();
    host.replaceChildren();
    hasWebGL = false;
  }
}

async function loadModel(entry: ModelEntry, sequence: number, signal: AbortSignal) {
  selected = entry;
  currentView = 'iso';
  modelLoading = true;
  updateButtons();
  try {
    const svgResults = await Promise.all(views.map(async view => {
      const text = await (await fetchOK(asset(entry.views[view].url, entry), signal)).text();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
        throw new Error(`${entry.id}: ${view} SVG无效`);
      }
      return [view, text] as const;
    }));
    if (sequence !== loadSequence) return;
    drawings = Object.fromEntries(svgResults);
    target.fromArray(entry.bounds.min).add(new THREE.Vector3().fromArray(entry.bounds.max)).multiplyScalar(.5);
    diagonal = new THREE.Vector3().fromArray(entry.bounds.max).sub(new THREE.Vector3().fromArray(entry.bounds.min)).length();
    initGraphics();
    if (hasWebGL) {
      const gltf = await new GLTFLoader().loadAsync(asset(entry.glb, entry));
      if (sequence !== loadSequence) { disposeObject(gltf.scene); return; }
      const group = new THREE.Group();
      // GLB使用米，CAD投影使用毫米。
      gltf.scene.scale.setScalar(1000);
      const material = new THREE.MeshStandardMaterial({ color: 0xa9b1bb, metalness: .25, roughness: .48, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const old = new Set<THREE.Material>();
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => old.add(m));
          object.material = material;
        }
      });
      old.forEach(m => m.dispose());
      group.add(gltf.scene);
      try {
        const edges: number[][][] = await (await fetchOK(asset(entry.edges, entry), signal)).json();
        if (sequence !== loadSequence) { disposeObject(group); return; }
        const positions: number[] = [];
        edges.forEach(points => points.slice(1).forEach((point, i) => positions.push(...points[i], ...point)));
        const wireGroup = new THREE.Group();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        wireGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x303a46 })));
        group.add(wireGroup);
        wires = wireGroup;
      } catch (error) { disposeObject(group); throw error; }
      modelGroup = group;
      scene.add(group);
      host.hidden = false;
    }
    modelLoading = false;
    setView('iso', true);
  } catch (error) {
    if (sequence !== loadSequence || signal.aborted) return;
    pendingFetch?.abort();
    showError(error);
  }
}

async function loadFromURL() {
  const sequence = ++loadSequence;
  pendingFetch?.abort();
  clearModel();
  const requested = readModelId(location.search, location.hash);
  if (requested === null) return;
  const id = normalizeId(requested);
  if (!id) { showError(new Error(`无效题号: ${requested}`)); return; }
  pendingFetch = new AbortController();
  const signal = pendingFetch.signal;
  try {
    catalogPromise ??= fetchOK(new URL('models/catalog.json', base).href)
      .then(response => response.json() as Promise<Catalog>)
      .catch(error => { catalogPromise = undefined; throw error; });
    const catalog = await catalogPromise;
    if (sequence !== loadSequence) return;
    const entry = catalog.models.find(model => model.id === id);
    if (!entry) throw new Error(`未找到题目: ${requested}`);
    await loadModel(entry, sequence, signal);
  } catch (error) {
    if (sequence === loadSequence && !signal.aborted) showError(error);
  }
}

buttons.forEach(button => { button.onclick = () => setView(button.dataset.view as View); });
new ResizeObserver(resize).observe(viewport);
window.addEventListener('hashchange', () => { void loadFromURL(); });
window.addEventListener('popstate', () => { void loadFromURL(); });
void loadFromURL();
