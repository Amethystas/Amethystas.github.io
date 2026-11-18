import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { straightSegmentKey } from '../src/engineering-lines.ts';
assert.equal(straightSegmentKey('M 1 2 L 3 4'),straightSegmentKey('M 3 4 L 1 2'));
assert.notEqual(straightSegmentKey('M 1 2 L 3 4'),straightSegmentKey('M 1 2 L 3 4.00001'));
assert.equal(straightSegmentKey('M 1 2 C 3 4 5 6 7 8'),null);
const catalog=JSON.parse(readFileSync(new URL('../public/models/catalog.json',import.meta.url)));
let duplicates=0,views=0;const affected=[];
for (const model of catalog.models) for (const [view,entry] of Object.entries(model.views)) {
 const svg=readFileSync(new URL('../public/'+entry.url,import.meta.url),'utf8');
 const group=svg.match(/<g class="hidden"[^>]*>([\s\S]*?)<\/g>/)?.[1]??'';
 const paths=[...group.matchAll(/<path d="([^"]+)"/g)].map(x=>x[1]);
 const keys=new Set();let removed=0;
 for(const path of paths) {const key=straightSegmentKey(path);if(key===null)continue;if(keys.has(key))removed++;else keys.add(key);}
 if(removed)affected.push({id:model.id,view,removed});
 duplicates+=removed;views++;
}
assert.equal(affected.find(x=>x.id==='21_3'&&x.view==='top')?.removed,4);
console.log(JSON.stringify({views,duplicates,affected},null,2));
