// 剂量场引擎 (CPU 路径) 测试: 网格计算 vs 解析解、ROI 局部重算

import { describe, it, expect } from 'vitest';
import { DoseFieldEngine } from '../src/gpu/engine';
import { PointSource, analyticSlabDoseRate } from '../src/physics/pointkernel';
import { ShieldBox } from '../src/physics/geometry';

const GBq = 1e9;

async function makeEngine(sources: PointSource[], boxes: ShieldBox[]): Promise<DoseFieldEngine> {
  const eng = new DoseFieldEngine();
  // 不调用 init(): Node 环境无 WebGPU, 走 CPU 路径
  eng.configureGrid({ min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 }, step: 0.5 });
  eng.setScene(sources, boxes);
  eng.invalidate();
  await eng.runAll();
  return eng;
}

describe('剂量场引擎 (CPU)', () => {
  it('裸点源网格采样 vs 解析式', async () => {
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
    const eng = await makeEngine([src], []);
    // 近源处 1/r² 曲率大, 三线性插值引入与网格步长同阶的误差; 远场应优于 2%
    const cases: Array<[number, number]> = [[1.3, 0.06], [2.7, 0.02], [4.1, 0.02]];
    for (const [r, tol] of cases) {
      const got = eng.sample(r, 0, 0);
      const want = analyticSlabDoseRate('Co60', GBq, r, null, 0);
      expect(Math.abs(got - want) / want).toBeLessThan(tol);
    }
  });

  it('点源+铅板: 网格全场计算与解析式逐点一致 (<2%)', async () => {
    const slab: ShieldBox = {
      id: 's', name: 's', material: 'lead', group: 'shielding',
      min: { x: 1, y: -4, z: -4 }, max: { x: 1.02, y: 4, z: 4 },
    };
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
    const eng = await makeEngine([src], [slab]);
    const got = eng.sample(3, 0, 0);
    const want = analyticSlabDoseRate('Co60', GBq, 3, 'lead', 2);
    expect(Math.abs(got - want) / want).toBeLessThan(0.02);
  });

  it('ROI 局部重算: 移动铅板后 ROI 内更新、ROI 外不变', async () => {
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
    const slab: ShieldBox = {
      id: 's', name: 's', material: 'lead', group: 'shielding',
      min: { x: 1, y: -1, z: -1 }, max: { x: 1.05, y: 1, z: 1 },
    };
    const eng = await makeEngine([src], [slab]);
    const before = eng.sample(3, 0, 0);
    const outsideBefore = eng.sample(-3, 0, 0);

    // 移走铅板 (到 x∈[3,3.05]), ROI 覆盖新旧位置
    slab.min = { x: 3, y: -1, z: -1 };
    slab.max = { x: 3.05, y: 1, z: 1 };
    eng.setScene([src], [slab]);
    eng.invalidate({ min: { x: 0.5, y: -1.5, z: -1.5 }, max: { x: 3.5, y: 1.5, z: 1.5 } });
    await eng.runAll();

    // 原屏蔽点后方: 铅板已移走, 剂量应上升到接近裸源
    const after = eng.sample(1.8, 0, 0);
    const bare = analyticSlabDoseRate('Co60', GBq, 1.8, null, 0);
    expect(after).toBeGreaterThan(before);
    expect(Math.abs(after - bare) / bare).toBeLessThan(0.05);
    // ROI 外不受影响
    expect(eng.sample(-3, 0, 0)).toBe(outsideBefore);
  });
});
