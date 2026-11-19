import { generateReactorProject } from '../src/model/reactorBuilding';
import { calibrateSources } from '../src/analysis/survey';

const p = generateReactorProject();
const r = calibrateSources(p);
console.log('RMS', (r.rmsBefore * 100).toFixed(1), '% ->', (r.rmsAfter * 100).toFixed(1), '%');
for (const s of p.sources) console.log(s.name.padEnd(20), r.factors[s.id]?.toFixed(3));
