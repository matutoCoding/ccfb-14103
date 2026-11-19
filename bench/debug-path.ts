import { generateReactorProject } from '../src/model/reactorBuilding';
import { makeSampler } from '../src/analysis/alara';
import { integratePath } from '../src/analysis/path';

const p = generateReactorProject();
const sample = makeSampler(p, []);
console.log('rate @(-5.5,5.5,1) μSv/h =', sample(-5.5, 5.5, 1) * 1e6);
console.log('rate @(-4,4,1) μSv/h =', sample(-4, 4, 1) * 1e6);
const r = integratePath({
  id: 't', name: 't', start: { x: -4, y: 4, z: 1 },
  segments: [{ to: { x: -5.5, y: 5.5, z: 1 }, dwellMinutes: 60, crew: 2 }],
}, sample, 0.01);
console.log(JSON.stringify(r, null, 1));
