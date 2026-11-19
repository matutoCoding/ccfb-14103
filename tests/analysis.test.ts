// 分析模块测试: 巡测标定收敛、路径积分、自动寻路

import { describe, it, expect } from 'vitest';
import { generateReactorProject } from '../src/model/reactorBuilding';
import { calibrateSources, compareSurvey } from '../src/analysis/survey';
import { integratePath, findRoute } from '../src/analysis/path';
import { makeSampler } from '../src/analysis/alara';
import { WorkPath } from '../src/model/project';

describe('巡测标定', () => {
  it('标定后 RMS 偏差显著下降', () => {
    const p = generateReactorProject();
    const before = compareSurvey(p);
    const rmsBefore = Math.sqrt(before.reduce((a, c) => a + c.relDev ** 2, 0) / before.length);
    const result = calibrateSources(p);
    expect(result.rmsAfter).toBeLessThan(result.rmsBefore);
    expect(result.rmsAfter).toBeLessThan(rmsBefore * 0.7);
    // 比例因子应都在合理范围 (真值在 0.7~1.4)
    for (const f of Object.values(result.factors)) {
      expect(f).toBeGreaterThan(0.3);
      expect(f).toBeLessThan(2.5);
    }
  });
});

describe('路径剂量积分', () => {
  it('高剂量区停留产生合理剂量, 超限段标红', () => {
    const p = generateReactorProject();
    const sample = makeSampler(p, []);
    const path: WorkPath = {
      id: 't', name: '测试', start: { x: -4, y: 4, z: 1 },
      segments: [
        { to: { x: -5.5, y: 5.5, z: 1 }, dwellMinutes: 60, crew: 2 }, // SG-A 水室旁
        { to: { x: 0, y: 0, z: 9.8 }, dwellMinutes: 0, crew: 1 },
      ],
    };
    const r = integratePath(path, sample, 0.01); // 限值 0.01 mSv 迫使标红
    expect(r.individualTotalMSv).toBeGreaterThan(0);
    expect(r.collectiveTotalMSv).toBeGreaterThan(r.individualTotalMSv);
    expect(r.segments[0].exceedsLimit).toBe(true);
    // 剂量率量级: SG 间数百 μSv/h, 停留 1h → 零点几 mSv
    expect(r.segments[0].dwellDoseMSv).toBeGreaterThan(0.05);
    expect(r.segments[0].dwellDoseMSv).toBeLessThan(5);
  });
});

describe('自动寻路', () => {
  it('低剂量路线剂量不高于最短路线', () => {
    const p = generateReactorProject();
    const sample = makeSampler(p, []);
    const start = { x: -6, y: 6, z: 1 };   // SG间A
    const goal = { x: 6, y: -6, z: 1 };    // 主泵间B
    const low = findRoute(p, start, goal, sample, 'dose');
    const short = findRoute(p, start, goal, sample, 'distance');
    expect(low).not.toBeNull();
    expect(short).not.toBeNull();
    expect(low!.doseMSv).toBeLessThanOrEqual(short!.doseMSv * 1.0001);
    expect(low!.lengthM).toBeGreaterThan(0);
  });

  it('跨层寻路: 主设备层到操作大厅', () => {
    const p = generateReactorProject();
    const sample = makeSampler(p, []);
    const r = findRoute(p, { x: -6, y: 6, z: 1 }, { x: 5, y: 5, z: 9.8 }, sample, 'distance');
    expect(r).not.toBeNull();
    // 路径应包含 z≈9.8 的终点
    const last = r!.path[r!.path.length - 1];
    expect(Math.abs(last.z - 9.8)).toBeLessThan(1);
  });
});
