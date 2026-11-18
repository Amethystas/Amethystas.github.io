// Independent Three.js camera projection versus the CAD projector matrices.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const catalog = JSON.parse(fs.readFileSync(new URL('../public/models/catalog.json', import.meta.url), 'utf8'));
const directions = { front:[0,-1,0], left:[-1,0,0], top:[0,0,1], iso:[-1.1,-1.5,1] };
const width = 1100, height = 800, fit = 160;
let maxError = 0, checks = 0;
for (const model of catalog.models) {
  const center = new THREE.Vector3().fromArray(model.bounds.min).add(new THREE.Vector3().fromArray(model.bounds.max)).multiplyScalar(.5);
  for (const [view, direction] of Object.entries(directions)) {
    const camera = new THREE.OrthographicCamera(-fit*width/height/2,fit*width/height/2,fit/2,-fit/2,.01,10000);
    camera.up.fromArray(view === 'top' ? [0,1,0] : [0,0,1]);
    camera.position.copy(center).addScaledVector(new THREE.Vector3(...direction).normalize(),600);
    camera.lookAt(center);camera.updateMatrixWorld(true);
    const p = model.views[view].projection;
    for (let n=0;n<8;n++) {
      const point = new THREE.Vector3(...[0,1,2].map(axis => model.bounds[(n & (1<<axis)) ? 'max' : 'min'][axis]));
      const projected = point.clone().project(camera);
      const cameraPixel = [(projected.x+1)*width/2,(1-projected.y)*height/2];
      const delta = point.sub(center).toArray();
      const cadPixel = p.map((row,i) => (i ? height : width)/2 + row.reduce((sum,v,j)=>sum+v*delta[j],0)*height/fit);
      const error = Math.hypot(cameraPixel[0]-cadPixel[0],cameraPixel[1]-cadPixel[1]);
      assert(error < 1e-8, `${model.id} ${view}: ${error}`);maxError=Math.max(maxError,error);checks++;
    }
  }
}
console.log(JSON.stringify({models:catalog.models.length,projectionChecks:checks,maxPixelError:maxError},null,2));
