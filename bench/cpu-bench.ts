// 基准: 反应堆厂房全场景的 CPU 计算速度
import { generateReactorProject } from '../src/model/reactorBuilding';
import { discretizeSource } from '../src/model/sources';
import { DoseFieldEngine } from '../src/gpu/engine';

const p = generateReactorProject();
const workDate = Date.parse(p.settings.workDate);
const pts = p.sources.flatMap((s) => discretizeSource(s, workDate));
console.log(`离散点源数: ${pts.length}, 屏蔽盒: ${p.building.boxes.length}`);

const eng = new DoseFieldEngine();
eng.configureGrid({ min: { x: -11, y: -11, z: -5.8 }, max: { x: 11, y: 11, z: 15.8 }, step: 0.5 });
eng.setScene(pts, p.building.boxes);
console.log(`网格: ${eng.dims.x}×${eng.dims.y}×${eng.dims.z} = ${eng.data.length} 体素`);

const t0 = performance.now();
eng.invalidate();
await eng.runAll();
const dt = performance.now() - t0;
console.log(`CPU 全场计算: ${(dt / 1000).toFixed(1)} s`);
// 采样几个点确认非零
console.log('SG间A 剂量率 μSv/h:', (eng.sample(-4, 4, 1) * 1e6).toFixed(1));
console.log('主泵间A 剂量率 μSv/h:', (eng.sample(-4, -4, 1) * 1e6).toFixed(1));
console.log('操作大厅 剂量率 μSv/h:', (eng.sample(0, 0, 9.8) * 1e6).toFixed(1));
