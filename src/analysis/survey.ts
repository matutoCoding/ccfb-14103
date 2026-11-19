// 巡测对标与源项标定
// 模型: measured_i ≈ Σ_j s_j · D_ij, D_ij 为源 j 在建模活度下对巡测点 i 的剂量率。
// 用乘性迭代 (NNLS 的 MLEM 形式) 解非负比例因子 s_j, 输出标定前后残差。

import { Project, SurveyPoint } from '../model/project';
import { SourceDef, discretizeSource } from '../model/sources';
import { totalDoseRate } from '../physics/pointkernel';
import { effectiveBoxes } from '../model/project';

export interface SurveyComparison {
  point: SurveyPoint;
  computed: number;   // μSv/h
  measured: number;   // μSv/h
  /** (计算-实测)/实测 */
  relDev: number;
}

export interface CalibrationResult {
  /** 每个源的活度比例因子 */
  factors: Record<string, number>;
  before: SurveyComparison[];
  after: SurveyComparison[];
  /** 标定前后 RMS 相对偏差 */
  rmsBefore: number;
  rmsAfter: number;
}

function computedAt(project: Project, sources: SourceDef[], pos: { x: number; y: number; z: number }): number {
  const workDate = Date.parse(project.settings.workDate);
  const pts = sources.flatMap((s) => discretizeSource(s, workDate));
  return totalDoseRate(pts, pos, effectiveBoxes(project)) * 1e6; // μSv/h
}

/** 各巡测点计算值 vs 实测值 */
export function compareSurvey(project: Project, sources: SourceDef[] = project.sources): SurveyComparison[] {
  const workDate = Date.parse(project.settings.workDate);
  const boxes = effectiveBoxes(project);
  const pts = sources.flatMap((s) => discretizeSource(s, workDate));
  return project.surveyPoints.map((sp) => {
    const computed = totalDoseRate(pts, sp.pos, boxes) * 1e6;
    return {
      point: sp, computed, measured: sp.measured,
      relDev: sp.measured > 0 ? (computed - sp.measured) / sp.measured : 0,
    };
  });
}

/** 标定: 对每个源项求活度比例因子, 返回标定结果 (不修改 project)。
 *  加权(1/m²)非负最小二乘, 坐标下降法: 每轮对每个源求闭式最优比例并截断到非负。 */
export function calibrateSources(project: Project, sweeps = 50): CalibrationResult {
  const workDate = Date.parse(project.settings.workDate);
  const boxes = effectiveBoxes(project);
  const srcs = project.sources;
  const sps = project.surveyPoints;

  // D_ij: 源 j 对点 i 的剂量率 (μSv/h)
  const D: number[][] = srcs.map((s) => {
    const pts = discretizeSource(s, workDate);
    return sps.map((sp) => totalDoseRate(pts, sp.pos, boxes) * 1e6);
  });

  const m = sps.map((sp) => sp.measured);
  const w = m.map((v) => 1 / Math.max(v, 1e-6) ** 2); // 相对偏差最小化
  const s = srcs.map(() => 1);
  // c_i = Σ_j s_j D_ij
  const c = sps.map((_, i) => srcs.reduce((acc, _, j) => acc + s[j] * D[j][i], 0));

  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let j = 0; j < srcs.length; j++) {
      let num = 0, den = 0;
      for (let i = 0; i < sps.length; i++) {
        const cNeg = c[i] - s[j] * D[j][i]; // 去掉源 j 的计算值
        num += w[i] * D[j][i] * (m[i] - cNeg);
        den += w[i] * D[j][i] * D[j][i];
      }
      // 岭正则化: 向先验 s=1 收缩, 抑制源项空间分布相近时的共线性发散
      const lambda = 0.05 * den;
      const sjNew = den > 0 ? Math.max(0.01, Math.min(10, (num + lambda) / (den + lambda))) : 1;
      for (let i = 0; i < sps.length; i++) c[i] += (sjNew - s[j]) * D[j][i];
      s[j] = sjNew;
    }
  }

  const factors: Record<string, number> = {};
  srcs.forEach((src, j) => { factors[src.id] = s[j]; });

  const scaled: SourceDef[] = srcs.map((src, j) => {
    const activities: Record<string, number> = {};
    for (const [iso, a] of Object.entries(src.activities)) activities[iso] = a * s[j];
    return { ...src, activities };
  });

  const before = compareSurvey(project);
  const after = compareSurvey(project, scaled);
  const rms = (list: SurveyComparison[]) =>
    Math.sqrt(list.reduce((a, c) => a + c.relDev * c.relDev, 0) / Math.max(1, list.length));

  return { factors, before, after, rmsBefore: rms(before), rmsAfter: rms(after) };
}

/** 把标定因子应用到 project.sources (就地) */
export function applyCalibration(project: Project, factors: Record<string, number>): void {
  for (const src of project.sources) {
    const f = factors[src.id];
    if (f === undefined) continue;
    for (const iso of Object.keys(src.activities)) src.activities[iso] *= f;
  }
}
