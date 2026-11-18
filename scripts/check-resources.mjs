import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { normalizeId, readModelId } from '../src/model-id.ts';

const root = new URL('../public/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('models/catalog.json', root)));
assert.equal(catalog.models.length, 39);
const ids = new Set();
let files = 0;
for (const model of catalog.models) {
  assert(!ids.has(model.id), `重复题号: ${model.id}`);
  ids.add(model.id);
  for (const alias of [model.id, model.id.replace('_', ''), model.id.toUpperCase()]) {
    assert.equal(normalizeId(alias), model.id);
  }
  const expected = ['front', 'left', 'top', 'iso'];
  assert.deepEqual(Object.keys(model.views).sort(), expected.sort());
  const urls = [model.glb, model.edges, ...Object.values(model.views).map(view => view.url)];
  for (const path of urls) {
    assert(path.startsWith(`models/${model.id}/`) && !path.includes('..'));
    const data = await readFile(new URL(path, root));
    assert(data.length, `空文件: ${path}`);
    if (path.endsWith('.glb')) {
      assert.equal(data.toString('ascii', 0, 4), 'glTF');
      assert.equal(data.readUInt32LE(4), 2);
      assert.equal(data.readUInt32LE(8), data.length);
    } else if (path.endsWith('.json')) {
      assert(Array.isArray(JSON.parse(data)));
    } else assert(data.toString().includes('<svg'));
    files++;
  }
  const actual = await readdir(new URL(`models/${model.id}/`, root));
  assert.equal(actual.length, 6, `${model.id}: 包含多余资源`);
}
assert.equal(readModelId('', ''), null);
assert.equal(readModelId('?foo=1', '#'), null);
assert.equal(readModelId('?id=', '#24a_3'), '');
assert.equal(readModelId('?id=24a3', '#21_2'), '24a3');
assert.equal(readModelId('', '#24a_3'), '24a_3');
assert.equal(readModelId('', '#%ZZ'), '');
for (const value of ['', 'missing', '../24a3', '24a_3/']) assert.equal(normalizeId(value), null);
const gif = await readFile(new URL('invalid-model.gif', root));
assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
console.log(`39题、${files}个模型资源和题号入口检查通过。`);
