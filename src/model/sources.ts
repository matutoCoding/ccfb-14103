// 源项模型:点源 / 管线线源 / 设备内表面面源,按同位素录活度,按作业日期衰变。
// 线源、面源在计算前离散为点源集合。

import { Vec3 } from '../physics/geometry';
import { decayedActivity, ISOTOPES } from '../physics/isotopes';
import { PointSource } from '../physics/pointkernel';

export type SourceType = 'point' | 'line' | 'surface';

export interface SourceBase {
  id: string;
  name: string;
  type: SourceType;
  /** 参考日期 (ISO 日期字符串) */
  refDate: string;
  /** 各同位素在参考日的活度 Bq */
  activities: Record<string, number>;
}

export interface PointSourceDef extends SourceBase {
  type: 'point';
  pos: Vec3;
}

export interface LineSourceDef extends SourceBase {
  type: 'line';
  /** 管线折线节点 m */
  path: Vec3[];
  /** 离散间距 m (默认 0.25) */
  spacing?: number;
}

export interface SurfaceSourceDef extends SourceBase {
  type: 'surface';
  /** 设备内腔盒 (沉积面取其内壁) m */
  box: { min: Vec3; max: Vec3 };
  /** 沉积面: 默认全部内壁 */
  faces?: Array<'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+'>;
  /** 离散间距 m (默认 0.3) */
  spacing?: number;
}

export type SourceDef = PointSourceDef | LineSourceDef | SurfaceSourceDef;

/** 作业日期的衰变后活度 */
export function activityAt(src: SourceBase, isotopeId: string, workDate: number): number {
  const a0 = src.activities[isotopeId] ?? 0;
  if (a0 <= 0) return 0;
  return decayedActivity(isotopeId, a0, Date.parse(src.refDate), workDate);
}

/** 源项总活度 (作业日期, 所有同位素求和) */
export function totalActivityAt(src: SourceBase, workDate: number): number {
  let sum = 0;
  for (const iso of Object.keys(src.activities)) sum += activityAt(src, iso, workDate);
  return sum;
}

/** 把源项离散为点源集合 (活度已按作业日期衰变、按子源数均摊) */
export function discretizeSource(src: SourceDef, workDate: number): PointSource[] {
  const positions = samplePositions(src);
  const out: PointSource[] = [];
  const n = positions.length;
  if (n === 0) return out;
  for (const isoId of Object.keys(src.activities)) {
    if (!ISOTOPES[isoId]) continue;
    const a = activityAt(src, isoId, workDate);
    if (a <= 0) continue;
    const per = a / n;
    for (const pos of positions) {
      out.push({ pos, activity: per, isotopeId: isoId, label: src.name });
    }
  }
  return out;
}

function samplePositions(src: SourceDef): Vec3[] {
  switch (src.type) {
    case 'point':
      return [src.pos];
    case 'line': {
      const spacing = src.spacing ?? 0.25;
      const pts: Vec3[] = [];
      for (let i = 0; i < src.path.length - 1; i++) {
        const a = src.path[i], b = src.path[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = Math.max(1, Math.ceil(len / spacing));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          pts.push({ x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t });
        }
      }
      pts.push(src.path[src.path.length - 1]);
      return pts;
    }
    case 'surface': {
      const spacing = src.spacing ?? 0.3;
      const faces = src.faces ?? ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'];
      const { min, max } = src.box;
      const pts: Vec3[] = [];
      const grid = (u0: number, u1: number, v0: number, v1: number) => {
        const nu = Math.max(1, Math.ceil((u1 - u0) / spacing));
        const nv = Math.max(1, Math.ceil((v1 - v0) / spacing));
        const uv: Array<[number, number]> = [];
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
          uv.push([u0 + ((i + 0.5) / nu) * (u1 - u0), v0 + ((j + 0.5) / nv) * (v1 - v0)]);
        }
        return uv;
      };
      for (const f of faces) {
        if (f === 'x-' || f === 'x+') {
          const x = f === 'x-' ? min.x : max.x;
          for (const [y, z] of grid(min.y, max.y, min.z, max.z)) pts.push({ x, y, z });
        } else if (f === 'y-' || f === 'y+') {
          const y = f === 'y-' ? min.y : max.y;
          for (const [x, z] of grid(min.x, max.x, min.z, max.z)) pts.push({ x, y, z });
        } else {
          const z = f === 'z-' ? min.z : max.z;
          for (const [x, y] of grid(min.x, max.x, min.y, max.y)) pts.push({ x, y, z });
        }
      }
      return pts;
    }
  }
}
