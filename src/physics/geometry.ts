// 场景几何与屏蔽体:全部屏蔽体统一为轴对齐盒(AABB),射线用 slab 法求穿行长度。
// 圆柱设备在建模时按外接盒参与衰减计算(工程估算级近似)。

import { MaterialId } from './materials';

export interface Vec3 { x: number; y: number; z: number }

/** 轴对齐盒,单位:米 */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface ShieldBox extends AABB {
  id: string;
  name: string;
  material: MaterialId;
  /** 密度覆盖 (g/cm³),undefined 用材料默认 */
  densityOverride?: number;
  /** 分组: 'structure' 厂房结构 | 'equipment' 设备 | 'pipe' 管道 | 'shielding' 临时屏蔽 */
  group: 'structure' | 'equipment' | 'pipe' | 'shielding';
  /** 屏蔽方案 id (仅 group==='shielding'),用于方案开关 */
  scenarioId?: string;
}

export function aabbContains(b: AABB, p: Vec3): boolean {
  return p.x >= b.min.x && p.x <= b.max.x &&
         p.y >= b.min.y && p.y <= b.max.y &&
         p.z >= b.min.z && p.z <= b.max.z;
}

export function aabbIntersects(a: AABB, b: AABB): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
         a.min.y <= b.max.y && a.max.y >= b.min.y &&
         a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/**
 * 线段与 AABB 的穿行长度 (slab 法)。单位与输入一致。
 * 从 s 到 e 的线段;无交返回 0。
 */
export function segmentAABBLength(s: Vec3, e: Vec3, box: AABB): number {
  const dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;
  let tmin = 0, tmax = 1;
  const axes: Array<[number, number, number, number]> = [
    [s.x, dx, box.min.x, box.max.x],
    [s.y, dy, box.min.y, box.max.y],
    [s.z, dz, box.min.z, box.max.z],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return 0;
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return 0;
    }
  }
  const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return (tmax - tmin) * segLen;
}

/** 源点与场点连线被各屏蔽体占据的长度,按材料累加。返回 Map<材质索引, 长度cm> */
export function accumulateShieldLengths(
  s: Vec3, e: Vec3, boxes: ShieldBox[], materialIndexOf: (b: ShieldBox) => number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of boxes) {
    const lenM = segmentAABBLength(s, e, b);
    if (lenM <= 0) continue;
    const mi = materialIndexOf(b);
    out.set(mi, (out.get(mi) ?? 0) + lenM * 100); // m -> cm
  }
  return out;
}
