import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeRepeatedSegments } from './engineering-lines';

type View = 'front' | 'left' | 'top' | 'iso';
type ModelEntry = {
  id: string; status: string; review?: { status: string } | null; version: string; glb: string; edges: string;
  deflectionMM: number;
  bounds: { min: number[]; max: number[] };
  views: Record<View, { url: string; projection: number[][] }>;
  references: Record<'question' | 'answer', string>;
};
type Catalog = { models: ModelEntry[] };
const views: View[] = ['front', 'left', 'top', 'iso'];
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="catalog" aria-label="题目目录"><p>题目</p><div id="entries"></div></aside>
  <section id="workspace">
    <main aria-label="模型展示"><div id="canvas"></div><div id="lines" aria-hidden="true"></div>
      <p id="model-title"></p><p id="notice" role="status">加载中…</p>
    </main>
    <aside id="reference" aria-label="原图对照" hidden>
      <div class="reference-tabs"><button data-reference="question">题目</button><button data-reference="answer" aria-pressed="true">答案</button><button id="close-reference" aria-label="关闭题图">×</button></div>
      <div class="reference-image"><img id="reference-image" alt="参考答案"></div>
    </aside>
  </section>
  <nav aria-label="视图方向">
    <button data-view="front">主视图</button><button data-view="left">左视图</button>
    <button data-view="top">俯视图</button><button data-view="iso" aria-pressed="true">轴测图</button>
    <button id="toggle-reference" aria-pressed="false">题图</button>
  </nav>`;
const viewport = document.querySelector('main')!;
const host = document.querySelector<HTMLDivElement>('#canvas')!;
const lines = document.querySelector<HTMLDivElement>('#lines')!;
const notice = document.querySelector<HTMLParagraphElement>('#notice')!;
const title = document.querySelector<HTMLParagraphElement>('#model-title')!;
const reference = document.querySelector<HTMLElement>('#reference')!;
const referenceImage = document.querySelector<HTMLImageElement>('#reference-image')!;
const referenceToggle = document.querySelector<HTMLButtonElement>('#toggle-reference')!;
const target = new THREE.Vector3();
const directions: Record<View, THREE.Vector3> = {
  front: new THREE.Vector3(0, -1, 0), left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, 0, 1), iso: new THREE.Vector3(-1.1, -1.5, 1).normalize(),
};
let catalog: Catalog;
let selected: ModelEntry | undefined;
let currentView: View | null = 'iso';
let referenceView: 'question' | 'answer' = 'answer';
let fitHeight = 100;
let diagonal = 100;
let hasWebGL = true;
let renderer: THREE.WebGLRenderer;
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
  return `${url}?v=${encodeURIComponent(model.version)}`;
}
function updateButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
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
  // Check roll as well as direction. OrbitControls stays an epsilon away
  // from its polar singularity, so allow that numerical difference.
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
  const width = Math.max(1, viewport.clientWidth), height = Math.max(1, viewport.clientHeight);
  const aspect = width / height;
  // A bounding sphere fits every orientation with one shared orthographic
  // scale. Direction changes must not refit the individual projected bounds.
  fitHeight = diagonal * 1.15 * Math.max(1, 1 / aspect);
  controls.maxZoom = Math.max(1, Math.min(10, .25 * fitHeight / ((selected?.deflectionMM ?? .002) * height)));
  camera.zoom = Math.min(camera.zoom, controls.maxZoom);
  camera.left = -fitHeight * aspect / 2; camera.right = -camera.left;
  camera.top = fitHeight / 2; camera.bottom = -camera.top;
  camera.updateProjectionMatrix(); renderer.setSize(width, height); invalidateLines();
}
function setView(view: View, immediate = false) {
  if (!selected) return;
  // Suppress the old/target overlay BEFORE controls.update or resize can
  // request one. Only animate() may present it after the matching 3D frame.
  hideLines();
  if (modelLoading) { currentView = view; updateButtons(); return; }
  if (hasWebGL) { controls.enableDamping = false; controls.update(); controls.enableDamping = true; }
  currentView = view; lines.innerHTML = '';
  if (!hasWebGL) { updateButtons(); showLines(); return; }
  // Refit only when a model is loaded. Direction buttons preserve the user's
  // zoom, pan target and frustum; orthographic orbiting only changes orientation.
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
  // The canvas and SVG now describe the same camera pose in the same frame.
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
function showReference() {
  if (!selected || reference.hidden) return;
  referenceImage.src = asset(selected.references[referenceView], selected);
  referenceImage.alt = `${selected.id}${referenceView === 'answer' ? '参考答案' : '题目'}`;
  document.querySelectorAll<HTMLButtonElement>('[data-reference]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.reference === referenceView));
  });
}
function toggleReference(open: boolean) {
  reference.hidden = !open; referenceToggle.setAttribute('aria-pressed', String(open)); showReference();
}
async function fetchOK(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
async function selectModel(id: string, changeHash = true) {
  const entry = catalog.models.find(model => model.id === id);
  if (!entry) return;
  const sequence = ++loadSequence;
  pendingFetch?.abort(); pendingFetch = new AbortController();
  const signal = pendingFetch.signal;
  if (modelGroup) { scene.remove(modelGroup); disposeObject(modelGroup); modelGroup = undefined; }
  wires = undefined; transition = null; drawings = {}; selected = entry;
  modelLoading = true; currentView = 'iso'; hideLines(); updateButtons();
  lines.innerHTML = ''; notice.hidden = false; notice.textContent = '加载中…';
  title.textContent = `${entry.id} · ${entry.review?.status ?? entry.status}`;
  if (changeHash) history.replaceState(null, '', `#${entry.id}`);
  document.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(button => {
    const active = button.dataset.model === id;
    button.setAttribute('aria-current', active ? 'true' : 'false');
    if (active) button.scrollIntoView({ block: 'nearest' });
  });
  showReference();
  try {
    const svgResults = await Promise.all(views.map(async view => [view, await (await fetchOK(asset(entry.views[view].url, entry), signal)).text()] as const));
    if (sequence !== loadSequence) return;
    drawings = Object.fromEntries(svgResults);
    target.fromArray(entry.bounds.min).add(new THREE.Vector3().fromArray(entry.bounds.max)).multiplyScalar(.5);
    diagonal = new THREE.Vector3().fromArray(entry.bounds.max).sub(new THREE.Vector3().fromArray(entry.bounds.min)).length();
    if (hasWebGL) {
      const gltf = await new GLTFLoader().loadAsync(asset(entry.glb, entry));
      if (sequence !== loadSequence) { disposeObject(gltf.scene); return; }
      const group = new THREE.Group();
      // Standard GLB metres -> the same millimetre coordinates as CAD HLR.
      gltf.scene.scale.setScalar(1000);
      const material = new THREE.MeshStandardMaterial({ color: 0xa9b1bb, metalness: .25, roughness: .48, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const old = new Set<THREE.Material>();
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => old.add(m));
          object.material = material;
        }
      });
      old.forEach(m => m.dispose()); group.add(gltf.scene);
      try {
        const edges: number[][][] = await (await fetchOK(asset(entry.edges, entry), signal)).json();
        if (sequence !== loadSequence) { disposeObject(group); return; }
        const positions: number[] = [];
        edges.forEach(points => points.slice(1).forEach((point, i) => positions.push(...points[i], ...point)));
        wires = new THREE.Group();
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        wires.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x303a46 })));
        group.add(wires);
      } catch (error) { disposeObject(group); throw error; }
      modelGroup = group; scene.add(group);
    }
    modelLoading = false; setView(currentView ?? 'iso', true); notice.hidden = true;
  } catch (error) {
    if (sequence !== loadSequence || signal.aborted) return;
    modelLoading = false;
    console.error(error); notice.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
    // Exact engineering views remain usable even if the GLB failed to load.
    if (Object.keys(drawings).length) setView('iso', true);
  }
}
async function boot() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0xf5f5f5); host.append(renderer.domElement);
    scene = new THREE.Scene(); camera = new THREE.OrthographicCamera(-60, 60, 50, -50, .01, 10000); camera.up.set(0, 0, 1);
    camera.position.copy(directions.iso).multiplyScalar(300);
    controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minZoom = 1; controls.maxZoom = 10;
    controls.addEventListener('start', () => { transition = null; hideLines(); });
    controls.addEventListener('change', () => {
      if (transition || modelLoading) return;
      if (currentView && !poseMatches(currentView)) {
        currentView = null; lines.innerHTML = ''; updateButtons();
      }
      invalidateLines();
    });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x83909e, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3.2); light.position.set(-60, -80, 160); scene.add(light);
    const fill = new THREE.DirectionalLight(0xffffff, 1); fill.position.set(100, 80, 30); scene.add(fill);
    resize(); animate();
  } catch (error) {
    console.error(error); hasWebGL = false; host.hidden = true;
  }
  new ResizeObserver(resize).observe(viewport);
  try {
    catalog = await (await fetchOK('models/catalog.json')).json();
    const entries = document.querySelector<HTMLDivElement>('#entries')!;
    catalog.models.forEach(entry => {
      const button = document.createElement('button'); button.dataset.model = entry.id;
      button.textContent = entry.id; button.title = `${entry.id} · ${entry.review?.status ?? entry.status}`;
      button.onclick = () => { void selectModel(entry.id); }; entries.append(button);
    });
    const initial = decodeURIComponent(location.hash.slice(1));
    await selectModel(catalog.models.some(entry => entry.id === initial) ? initial : '21_2');
  } catch (error) { notice.textContent = `目录加载失败：${error instanceof Error ? error.message : String(error)}`; }
}
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => { button.onclick = () => setView(button.dataset.view as View); });
document.querySelectorAll<HTMLButtonElement>('[data-reference]').forEach(button => { button.onclick = () => { referenceView = button.dataset.reference as 'question' | 'answer'; showReference(); }; });
referenceToggle.onclick = () => toggleReference(reference.hidden);
document.querySelector<HTMLButtonElement>('#close-reference')!.onclick = () => toggleReference(false);
referenceImage.onerror = () => { notice.hidden = false; notice.textContent = `题图加载失败：${selected?.id ?? ''}`; };
window.addEventListener('hashchange', () => { const id = decodeURIComponent(location.hash.slice(1)); if (selected?.id !== id) void selectModel(id, false); });
void boot();
