// 材料库:质量衰减系数、剂量转换用质能吸收系数、Berger 累积因子系数
// 数值取自 NIST XCOM 量级数据(常用能点,对数插值),用于工程估算级点核积分。
// 关键性质:CPU 与 GPU 使用同一份表,保证两侧结果逐位一致。

import { FLAT_LINES, NUM_LINES } from './isotopes';

export type MaterialId = 'concrete' | 'steel' | 'lead' | 'water' | 'air';

export interface Material {
  id: MaterialId;
  name: string;
  /** 密度 g/cm³ */
  density: number;
  /** 能量网格 MeV (单调升) */
  energies: number[];
  /** 质量衰减系数 μ/ρ, cm²/g */
  muRho: number[];
  /** Berger 累积因子系数 a (B = 1 + a·x·e^(b·x), x=μt) */
  bergerA: number[];
  /** Berger 累积因子系数 b */
  bergerB: number[];
}

const E_GRID = [0.5, 0.6, 0.662, 0.8, 1.0, 1.173, 1.25, 1.333, 1.5, 2.0];

export const MATERIALS: Record<MaterialId, Material> = {
  concrete: {
    id: 'concrete', name: '混凝土', density: 2.3, energies: E_GRID,
    muRho: [0.0870, 0.0804, 0.0770, 0.0710, 0.0639, 0.0590, 0.0573, 0.0555, 0.0519, 0.0445],
    bergerA: [0.95, 0.90, 0.87, 0.82, 0.75, 0.71, 0.69, 0.67, 0.62, 0.52],
    bergerB: [0.090, 0.086, 0.084, 0.080, 0.075, 0.071, 0.069, 0.067, 0.063, 0.055],
  },
  steel: {
    id: 'steel', name: '钢', density: 7.85, energies: E_GRID,
    muRho: [0.0838, 0.0798, 0.0736, 0.0667, 0.0595, 0.0557, 0.0544, 0.0527, 0.0500, 0.0425],
    bergerA: [0.70, 0.68, 0.66, 0.63, 0.60, 0.57, 0.56, 0.55, 0.52, 0.45],
    bergerB: [0.060, 0.058, 0.057, 0.056, 0.055, 0.053, 0.052, 0.051, 0.049, 0.045],
  },
  lead: {
    id: 'lead', name: '铅', density: 11.34, energies: E_GRID,
    muRho: [0.161, 0.125, 0.105, 0.0887, 0.0708, 0.0619, 0.0584, 0.0552, 0.0517, 0.0460],
    bergerA: [0.28, 0.30, 0.31, 0.33, 0.36, 0.38, 0.39, 0.40, 0.42, 0.46],
    bergerB: [0.020, 0.021, 0.022, 0.024, 0.026, 0.028, 0.029, 0.030, 0.032, 0.036],
  },
  water: {
    id: 'water', name: '水', density: 1.0, energies: E_GRID,
    muRho: [0.0966, 0.0896, 0.0857, 0.0787, 0.0708, 0.0655, 0.0635, 0.0614, 0.0575, 0.0493],
    bergerA: [1.00, 0.94, 0.90, 0.85, 0.80, 0.75, 0.73, 0.71, 0.66, 0.56],
    bergerB: [0.100, 0.094, 0.090, 0.085, 0.080, 0.075, 0.073, 0.071, 0.066, 0.058],
  },
  air: {
    id: 'air', name: '空气', density: 0.001205, energies: E_GRID,
    muRho: [0.0866, 0.0804, 0.0770, 0.0707, 0.0636, 0.0588, 0.0570, 0.0551, 0.0517, 0.0445],
    bergerA: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
    bergerB: [0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005],
  },
};

export const MATERIAL_LIST = Object.values(MATERIALS);
export const NUM_MATERIALS = MATERIAL_LIST.length;
export const MATERIAL_INDEX: Record<MaterialId, number> = {
  concrete: 0, steel: 1, lead: 2, water: 3, air: 4,
};

/** 组织(水当量)质能吸收系数 μ_en/ρ, cm²/g —— 通量->剂量转换 */
const MU_EN_WATER = [0.0330, 0.0326, 0.0325, 0.0321, 0.0309, 0.0298, 0.0294, 0.0290, 0.0280, 0.0260];

/** 对数-对数插值 */
export function logLogInterp(grid: number[], values: number[], e: number): number {
  if (e <= grid[0]) return values[0];
  if (e >= grid[grid.length - 1]) return values[values.length - 1];
  let lo = 0;
  for (let i = 0; i < grid.length - 1; i++) {
    if (e >= grid[i] && e <= grid[i + 1]) { lo = i; break; }
  }
  const t = (Math.log(e) - Math.log(grid[lo])) / (Math.log(grid[lo + 1]) - Math.log(grid[lo]));
  const v = Math.exp(Math.log(values[lo]) + t * (Math.log(values[lo + 1]) - Math.log(values[lo])));
  return v;
}

/** 线性插值 (累积因子系数用) */
export function linInterp(grid: number[], values: number[], e: number): number {
  if (e <= grid[0]) return values[0];
  if (e >= grid[grid.length - 1]) return values[values.length - 1];
  let lo = 0;
  for (let i = 0; i < grid.length - 1; i++) {
    if (e >= grid[i] && e <= grid[i + 1]) { lo = i; break; }
  }
  const t = (e - grid[lo]) / (grid[lo + 1] - grid[lo]);
  return values[lo] + t * (values[lo + 1] - values[lo]);
}

/** 线衰减系数 μ = (μ/ρ)·ρ, cm⁻¹ */
export function linearAttenuation(mat: Material, energyMeV: number): number {
  return logLogInterp(mat.energies, mat.muRho, energyMeV) * mat.density;
}

/** Berger 累积因子 B(x) = 1 + a·x·exp(b·x), x 为平均自由程数 μt */
export function buildupBerger(a: number, b: number, x: number): number {
  return 1 + a * x * Math.exp(b * x);
}

const MeV_TO_J = 1.602176634e-13;

/**
 * 预计算表 —— CPU 与 GPU(WGSL 常量)共用,按 FLAT_LINES 顺序:
 *  mu[mat][line]      线衰减系数 cm⁻¹
 *  bergerA/B[mat][line]
 *  doseConv[line]     φ(1/cm²/s) -> Sv/h 的转换系数 (E·μ_en/ρ·单位换算, 光子 Q=1)
 */
export interface PhysicsTables {
  mu: Float64Array;        // NUM_MATERIALS * NUM_LINES
  bergerA: Float64Array;
  bergerB: Float64Array;
  doseConv: Float64Array;  // NUM_LINES
}

export function buildPhysicsTables(): PhysicsTables {
  const mu = new Float64Array(NUM_MATERIALS * NUM_LINES);
  const bergerA = new Float64Array(NUM_MATERIALS * NUM_LINES);
  const bergerB = new Float64Array(NUM_MATERIALS * NUM_LINES);
  const doseConv = new Float64Array(NUM_LINES);

  for (let li = 0; li < NUM_LINES; li++) {
    const e = FLAT_LINES[li].energy;
    const muEn = logLogInterp(E_GRID, MU_EN_WATER, e);
    // Gy/h = φ · E[MeV] · 1.602e-13[J/MeV] · (μ_en/ρ)[cm²/g] · 1000[g/kg] · 3600[s/h]
    doseConv[li] = e * MeV_TO_J * muEn * 1000 * 3600;
    for (let mi = 0; mi < NUM_MATERIALS; mi++) {
      const mat = MATERIAL_LIST[mi];
      mu[mi * NUM_LINES + li] = linearAttenuation(mat, e);
      bergerA[mi * NUM_LINES + li] = linInterp(mat.energies, mat.bergerA, e);
      bergerB[mi * NUM_LINES + li] = linInterp(mat.energies, mat.bergerB, e);
    }
  }
  return { mu, bergerA, bergerB, doseConv };
}

export const TABLES = buildPhysicsTables();
