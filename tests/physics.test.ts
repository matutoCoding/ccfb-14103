// 物理内核对标测试
// 1) 裸点源 vs 剂量率常数文献值 (Co-60 ≈ 0.308~0.36 mSv·m²/(GBq·h) 量级)
// 2) 点源 + 单层平板屏蔽: 点核积分器 vs 手算点核公式, 误差 < 1%
// 3) 衰变修正: 半衰期整数倍活度减半
// 4) 线源/面源离散: 活度守恒

import { describe, it, expect } from 'vitest';
import { pointSourceDoseRate, analyticSlabDoseRate, PointSource } from '../src/physics/pointkernel';
import { ShieldBox } from '../src/physics/geometry';
import { decayedActivity, ISOTOPES } from '../src/physics/isotopes';
import { discretizeSource, LineSourceDef, SurfaceSourceDef, totalActivityAt } from '../src/model/sources';

const GBq = 1e9;

describe('裸点源 vs 手算点核公式', () => {
  it('Co-60 1 GBq, 1~5 m 空气, 与解析式一致 (<0.1%)', () => {
    for (const r of [1, 2, 3.7, 5]) {
      const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
      const got = pointSourceDoseRate(src, { x: r, y: 0, z: 0 }, []);
      const want = analyticSlabDoseRate('Co60', GBq, r, null, 0);
      expect(Math.abs(got - want) / want).toBeLessThan(1e-3);
    }
  });

  it('Co-60 剂量率常数在文献范围 (0.30~0.37 mSv/h @1m,1GBq)', () => {
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
    const d = pointSourceDoseRate(src, { x: 1, y: 0, z: 0 }, []);
    const mSvPerH = d * 1000;
    expect(mSvPerH).toBeGreaterThan(0.30);
    expect(mSvPerH).toBeLessThan(0.37);
  });

  it('平方反比律: 2m 处约为 1m 处的 1/4 (<0.1%)', () => {
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Cs137', label: 't' };
    const d1 = pointSourceDoseRate(src, { x: 1, y: 0, z: 0 }, []);
    const d2 = pointSourceDoseRate(src, { x: 2, y: 0, z: 0 }, []);
    expect(Math.abs(d2 / d1 - 0.25)).toBeLessThan(1e-3);
  });
});

describe('点源 + 单层平板屏蔽 vs 手算点核公式', () => {
  // 源在原点, 场点在 x=3m, 中间一块 1cm 厚铅板 (x∈[1,1.01])
  const cases: Array<[string, string, 'lead' | 'concrete' | 'steel' | 'water', number, number]> = [
    // [用例名, 同位素, 材料, 板厚cm, 距离m]
    ['Co60-铅1cm', 'Co60', 'lead', 1, 3],
    ['Co60-铅5cm', 'Co60', 'lead', 5, 3],
    ['Co60-混凝土30cm', 'Co60', 'concrete', 30, 4],
    ['Co58-钢10cm', 'Co58', 'steel', 10, 3],
    ['Cs137-铅2cm', 'Cs137', 'lead', 2, 2.5],
    ['Cs137-水50cm', 'Cs137', 'water', 50, 3],
  ];
  for (const [name, iso, mat, thickCm, dist] of cases) {
    it(`${name}: 误差 < 1%`, () => {
      const thickM = thickCm / 100;
      const slab: ShieldBox = {
        id: 'slab', name: 'slab', material: mat, group: 'shielding',
        min: { x: 1, y: -2, z: -2 }, max: { x: 1 + thickM, y: 2, z: 2 },
      };
      const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: iso, label: 't' };
      const got = pointSourceDoseRate(src, { x: dist, y: 0, z: 0 }, [slab]);
      const want = analyticSlabDoseRate(iso, GBq, dist, mat, thickCm);
      const rel = Math.abs(got - want) / want;
      expect(rel).toBeLessThan(0.01);
    });
  }

  it('斜射: 射线斜穿平板, 按实际穿行长度衰减', () => {
    // 板厚 2cm (x∈[1,1.02]), 场点 (2, 1, 0): 穿行长度 = 0.02 * |seg|/|seg_x|
    const src: PointSource = { pos: { x: 0, y: 0, z: 0 }, activity: GBq, isotopeId: 'Co60', label: 't' };
    const p = { x: 2, y: 1, z: 0 };
    const slab: ShieldBox = {
      id: 'slab', name: 'slab', material: 'lead', group: 'shielding',
      min: { x: 1, y: -2, z: -2 }, max: { x: 1.02, y: 2, z: 2 },
    };
    const got = pointSourceDoseRate(src, p, [slab]);
    const segLen = Math.sqrt(5); // |(2,1,0)|
    const travelCm = 2 * (segLen / 2); // 穿行长度 = 厚 * 总长/x向长度
    const want = analyticSlabDoseRate('Co60', GBq, segLen, 'lead', travelCm);
    expect(Math.abs(got - want) / want).toBeLessThan(0.01);
  });
});

describe('衰变修正', () => {
  it('Co-60 经过一个半衰期活度减半', () => {
    const T = ISOTOPES.Co60.halfLifeDays;
    const a = decayedActivity('Co60', GBq, 0, T * 86400000);
    expect(Math.abs(a / GBq - 0.5)).toBeLessThan(1e-9);
  });
  it('Co-58 经过 70.86 天减半, 两个半衰期变 1/4', () => {
    const a1 = decayedActivity('Co58', GBq, 0, 70.86 * 86400000);
    const a2 = decayedActivity('Co58', GBq, 0, 2 * 70.86 * 86400000);
    expect(a1 / GBq).toBeCloseTo(0.5, 6);
    expect(a2 / GBq).toBeCloseTo(0.25, 6);
  });
  it('Cs-137 一年衰变约 2.3%', () => {
    const a = decayedActivity('Cs137', GBq, 0, 365.25 * 86400000);
    expect(a / GBq).toBeCloseTo(Math.pow(2, -365.25 / ISOTOPES.Cs137.halfLifeDays), 9);
    expect(a / GBq).toBeLessThan(1);
    expect(a / GBq).toBeGreaterThan(0.95);
  });
});

describe('线源/面源离散', () => {
  const workDate = Date.parse('2026-05-01');
  it('线源离散后总活度守恒', () => {
    const line: LineSourceDef = {
      id: 'L1', name: '管线', type: 'line', refDate: '2026-01-01',
      activities: { Co60: 10 * GBq },
      path: [{ x: 0, y: 0, z: 1 }, { x: 5, y: 0, z: 1 }, { x: 5, y: 3, z: 1 }],
    };
    const pts = discretizeSource(line, workDate);
    const sum = pts.reduce((s, p) => s + p.activity, 0);
    expect(sum / totalActivityAt(line, workDate)).toBeCloseTo(1, 9);
    expect(pts.length).toBeGreaterThan(20);
  });
  it('面源离散后总活度守恒且点位于壁面', () => {
    const surf: SurfaceSourceDef = {
      id: 'S1', name: '换热器', type: 'surface', refDate: '2026-01-01',
      activities: { Co58: 5 * GBq },
      box: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 3 } },
    };
    const pts = discretizeSource(surf, workDate);
    const sum = pts.reduce((s, p) => s + p.activity, 0);
    expect(sum / totalActivityAt(surf, workDate)).toBeCloseTo(1, 9);
    for (const p of pts) {
      const onWall =
        Math.abs(p.pos.x) < 1e-9 || Math.abs(p.pos.x - 2) < 1e-9 ||
        Math.abs(p.pos.y) < 1e-9 || Math.abs(p.pos.y - 1) < 1e-9 ||
        Math.abs(p.pos.z) < 1e-9 || Math.abs(p.pos.z - 3) < 1e-9;
      expect(onWall).toBe(true);
    }
  });
});
