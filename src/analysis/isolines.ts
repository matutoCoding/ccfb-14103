// 剖切面提取 + 等剂量线 (marching squares)

import { DoseFieldEngine } from '../gpu/engine';

export type SliceAxis = 'x' | 'y' | 'z';

export interface SliceData {
  axis: SliceAxis;
  /** 剖切位置 m */
  pos: number;
  /** 2D 网格 [rows][cols], Sv/h */
  values: Float32Array;
  rows: number;
  cols: number;
  /** 平面坐标原点与步长 (u=水平, v=垂直) */
  u0: number; v0: number; du: number; dv: number;
  uLabel: string; vLabel: string;
}

export function extractSlice(engine: DoseFieldEngine, axis: SliceAxis, pos: number, resolution = 0.25): SliceData {
  const g = engine.grid;
  let u0: number, u1: number, v0: number, v1: number, uLabel: string, vLabel: string;
  if (axis === 'z') { u0 = g.min.x; u1 = g.max.x; v0 = g.min.y; v1 = g.max.y; uLabel = 'X'; vLabel = 'Y'; }
  else if (axis === 'y') { u0 = g.min.x; u1 = g.max.x; v0 = g.min.z; v1 = g.max.z; uLabel = 'X'; vLabel = 'Z'; }
  else { u0 = g.min.y; u1 = g.max.y; v0 = g.min.z; v1 = g.max.z; uLabel = 'Y'; vLabel = 'Z'; }
  const cols = Math.max(2, Math.round((u1 - u0) / resolution));
  const rows = Math.max(2, Math.round((v1 - v0) / resolution));
  const values = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = u0 + (c + 0.5) * (u1 - u0) / cols;
      const v = v0 + (r + 0.5) * (v1 - v0) / rows;
      let d: number;
      if (axis === 'z') d = engine.sample(u, v, pos);
      else if (axis === 'y') d = engine.sample(u, pos, v);
      else d = engine.sample(pos, u, v);
      values[r * cols + c] = d;
    }
  }
  return { axis, pos, values, rows, cols, u0, v0, du: (u1 - u0) / cols, dv: (v1 - v0) / rows, uLabel, vLabel };
}

export interface IsoSegment { x1: number; y1: number; x2: number; y2: number }

/** marching squares: 返回平面坐标 (u,v) 线段集 */
export function marchingSquares(slice: SliceData, level: number): IsoSegment[] {
  const { values, rows, cols, u0, v0, du, dv } = slice;
  const segs: IsoSegment[] = [];
  const at = (r: number, c: number) => values[r * cols + c];
  // 单元 (r,c) 四角: (r,c) 左下, (r,c+1) 右下, (r+1,c+1) 右上, (r+1,c) 左上
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v00 = at(r, c), v10 = at(r, c + 1), v11 = at(r + 1, c + 1), v01 = at(r + 1, c);
      let idx = 0;
      if (v00 > level) idx |= 1;
      if (v10 > level) idx |= 2;
      if (v11 > level) idx |= 4;
      if (v01 > level) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      const px = (c: number) => u0 + c * du;
      const py = (r: number) => v0 + r * dv;
      // 各边插值点
      const lerp = (a: number, b: number) => (Math.abs(b - a) < 1e-30 ? 0.5 : (level - a) / (b - a));
      const bottom = () => ({ x: px(c) + lerp(v00, v10) * du, y: py(r) });
      const right = () => ({ x: px(c + 1), y: py(r) + lerp(v10, v11) * dv });
      const top = () => ({ x: px(c) + lerp(v01, v11) * du, y: py(r + 1) });
      const left = () => ({ x: px(c), y: py(r) + lerp(v00, v01) * dv });
      const add = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
        segs.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      switch (idx) {
        case 1: case 14: add(left(), bottom()); break;
        case 2: case 13: add(bottom(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(right(), top()); break;
        case 5: add(left(), top()); add(bottom(), right()); break;
        case 6: case 9: add(bottom(), top()); break;
        case 7: case 8: add(left(), top()); break;
        case 10: add(left(), bottom()); add(right(), top()); break;
      }
    }
  }
  return segs;
}

/** 对数色标: μSv/h -> [r,g,b] 0..255 (蓝-青-绿-黄-红) */
export function logColor(uSvH: number): [number, number, number] {
  const v = Math.log10(Math.max(0.01, uSvH)); // 0.01 μSv/h 起
  // 映射 [-2, 5] -> [0,1]  (0.01 μSv/h ~ 100 mSv/h)
  const t = Math.max(0, Math.min(1, (v + 2) / 7));
  // 五段插值
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [30, 60, 200]],
    [0.25, [0, 180, 220]],
    [0.5, [40, 200, 80]],
    [0.75, [240, 220, 40]],
    [1.0, [220, 30, 30]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + k * (c1[0] - c0[0])),
        Math.round(c0[1] + k * (c1[1] - c0[1])),
        Math.round(c0[2] + k * (c1[2] - c0[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}
