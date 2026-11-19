// 点核积分剂量计算 (CPU 参考实现)
//
// 物理模型: 对各向同性点源,场点处第 i 条伽马线的注量率
//   φ_i = A·Y_i / (4πr²) · B_i(μt) · exp(-μt)
// 剂量率 Ḋ = Σ_i φ_i · doseConv_i   [Sv/h]
// 其中 μt = Σ_m μ_m(E_i)·x_m 为射线穿行的总平均自由程数,
// 累积因子取贡献最大的屏蔽材料(主导层)的 Berger 系数、以总 μt 求值。
// 该实现与 gpu/shaders.ts 中的 WGSL 计算着色器使用同一公式与同一份系数表,
// 单点源+单层平板工况须与手算点核公式偏差 <1%。

import { FLAT_LINES, NUM_LINES, ISOTOPE_LINE_RANGE } from './isotopes';
import { TABLES, NUM_MATERIALS, MATERIAL_INDEX, MaterialId } from './materials';
import { ShieldBox, Vec3, segmentAABBLength } from './geometry';

/** 离散后的点源 (线源/面源在 CPU 侧离散为点源集合) */
export interface PointSource {
  /** 位置 m */
  pos: Vec3;
  /** 作业日期衰变修正后的活度 Bq */
  activity: number;
  isotopeId: string;
  /** 来源标签 (用于贡献排序) */
  label: string;
}

export interface DoseOptions {
  /** 参与计算的屏蔽盒 */
  boxes: ShieldBox[];
  /** 场点若在实体内部,是否仍计算 (默认 true,照常算) */
  computeInsideSolid?: boolean;
}

/**
 * 单个点源在场点的剂量率, Sv/h。
 * 同时返回每条谱线的贡献(可选,用于贡献分析)。
 */
export function pointSourceDoseRate(
  src: PointSource,
  p: Vec3,
  boxes: ShieldBox[],
  lineContrib?: Float64Array,
): number {
  const dx = p.x - src.pos.x, dy = p.y - src.pos.y, dz = p.z - src.pos.z;
  const rM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (rM < 1e-6) return 0;
  const rCm = rM * 100;

  // 按材料累加穿行长度 (cm)
  const lenCm = new Float64Array(NUM_MATERIALS);
  for (const b of boxes) {
    const L = segmentAABBLength(src.pos, p, b);
    if (L <= 0) continue;
    const mi = MATERIAL_INDEX[b.material];
    // 密度覆盖时按默认密度比例折算等效长度
    const scale = b.densityOverride !== undefined
      ? b.densityOverride / defaultDensity(b.material) : 1;
    lenCm[mi] += L * 100 * scale;
  }

  const range = ISOTOPE_LINE_RANGE[src.isotopeId];
  let dose = 0;
  const geom = src.activity / (4 * Math.PI * rCm * rCm); // 1/(cm²·s) 每单位产额

  for (let k = 0; k < range.count; k++) {
    const li = range.start + k;
    // 总 μt 与主导材料
    let mut = 0;
    let domMat = -1, domMut = 0;
    for (let mi = 0; mi < NUM_MATERIALS; mi++) {
      const x = lenCm[mi];
      if (x <= 0) continue;
      const m = TABLES.mu[mi * NUM_LINES + li] * x;
      mut += m;
      if (m > domMut) { domMut = m; domMat = mi; }
    }
    let buildup = 1;
    if (domMat >= 0 && mut > 0) {
      const a = TABLES.bergerA[domMat * NUM_LINES + li];
      const b = TABLES.bergerB[domMat * NUM_LINES + li];
      buildup = 1 + a * mut * Math.exp(b * mut);
    }
    const phi = geom * FLAT_LINES[li].yield * buildup * Math.exp(-mut);
    const d = phi * TABLES.doseConv[li];
    if (lineContrib) lineContrib[li] += d;
    dose += d;
  }
  return dose;
}

function defaultDensity(id: MaterialId): number {
  switch (id) {
    case 'concrete': return 2.3;
    case 'steel': return 7.85;
    case 'lead': return 11.34;
    case 'water': return 1.0;
    case 'air': return 0.001205;
  }
}

/** 多点源在场点的总剂量率 Sv/h */
export function totalDoseRate(sources: PointSource[], p: Vec3, boxes: ShieldBox[]): number {
  let d = 0;
  for (const s of sources) d += pointSourceDoseRate(s, p, boxes);
  return d;
}

/** 各源贡献分解,返回按贡献降序的 [{label, dose}] */
export function doseContributions(
  sources: PointSource[], p: Vec3, boxes: ShieldBox[],
): Array<{ label: string; dose: number }> {
  const byLabel = new Map<string, number>();
  for (const s of sources) {
    const d = pointSourceDoseRate(s, p, boxes);
    byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + d);
  }
  return [...byLabel.entries()]
    .map(([label, dose]) => ({ label, dose }))
    .sort((a, b) => b.dose - a.dose);
}

/**
 * 手算点核公式 (解析参考,用于对标测试):
 * 单点源、单一均匀屏蔽层厚度 tShield cm、材料 mat。
 * Ḋ = Σ_i A·Y_i/(4πr²) · B_i(μt) · e^(-μt) · doseConv_i
 */
export function analyticSlabDoseRate(
  isotopeId: string,
  activity: number,
  distanceM: number,
  mat: MaterialId | null,
  shieldThicknessCm: number,
): number {
  const mi = mat ? MATERIAL_INDEX[mat] : -1;
  const rCm = distanceM * 100;
  const range = ISOTOPE_LINE_RANGE[isotopeId];
  let dose = 0;
  for (let k = 0; k < range.count; k++) {
    const li = range.start + k;
    let mut = 0, buildup = 1;
    if (mi >= 0 && shieldThicknessCm > 0) {
      mut = TABLES.mu[mi * NUM_LINES + li] * shieldThicknessCm;
      const a = TABLES.bergerA[mi * NUM_LINES + li];
      const b = TABLES.bergerB[mi * NUM_LINES + li];
      buildup = 1 + a * mut * Math.exp(b * mut);
    }
    const phi = (activity * FLAT_LINES[li].yield) / (4 * Math.PI * rCm * rCm);
    dose += phi * buildup * Math.exp(-mut) * TABLES.doseConv[li];
  }
  return dose;
}
