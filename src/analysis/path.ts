// 作业路径剂量积分 + 自动低剂量寻路 (A*)
// 个人剂量 = Σ段 (行走剂量 + 停留剂量); 集体剂量 = Σ段 个人段剂量 × 人数。

import { Vec3 } from '../physics/geometry';
import { Project, WorkPath, PathSegment } from '../model/project';

export interface SegmentDose {
  from: Vec3;
  to: Vec3;
  lengthM: number;
  transitDoseMSv: number;  // 单人
  dwellDoseMSv: number;    // 单人
  segmentDoseMSv: number;  // 单人合计
  collectiveMSv: number;   // × 人数
  avgRateMSvH: number;
  crew: number;
  dwellMinutes: number;
  exceedsLimit: boolean;
}

export interface PathDoseResult {
  segments: SegmentDose[];
  individualTotalMSv: number;
  collectiveTotalMSv: number;
}

const WALK_SPEED = 1.0; // m/s
const SAMPLE_STEP = 0.25; // m

/** 沿路径积分 (剂量率由 sample 给出, Sv/h) */
export function integratePath(
  path: WorkPath,
  sample: (x: number, y: number, z: number) => number,
  dailyLimitMSv: number,
): PathDoseResult {
  const segments: SegmentDose[] = [];
  let prev = path.start;
  let individualTotal = 0, collectiveTotal = 0;

  for (const seg of path.segments) {
    const dx = seg.to.x - prev.x, dy = seg.to.y - prev.y, dz = seg.to.z - prev.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // 行走段: 沿线采样平均剂量率
    let rateSum = 0;
    const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      rateSum += sample(prev.x + dx * t, prev.y + dy * t, prev.z + dz * t);
    }
    const avgRateSvH = rateSum / (n + 1);
    const transitH = len / WALK_SPEED / 3600;
    const transitDose = avgRateSvH * 1000 * transitH;
    // 停留段: 终点处剂量率 × 停留时间
    const dwellRate = sample(seg.to.x, seg.to.y, seg.to.z);
    const dwellDose = dwellRateSv(dwellRate) * (seg.dwellMinutes / 60);
    const segDose = transitDose + dwellDose;
    const collective = segDose * seg.crew;
    individualTotal += segDose;
    collectiveTotal += collective;
    segments.push({
      from: prev, to: seg.to, lengthM: len,
      transitDoseMSv: transitDose, dwellDoseMSv: dwellDose,
      segmentDoseMSv: segDose, collectiveMSv: collective,
      avgRateMSvH: avgRateSvH * 1000, crew: seg.crew, dwellMinutes: seg.dwellMinutes,
      exceedsLimit: segDose > dailyLimitMSv,
    });
    prev = seg.to;
  }
  return { segments, individualTotalMSv: individualTotal, collectiveTotalMSv: collectiveTotal };
}

function dwellRateSv(r: number): number { return r * 1000; } // Sv/h -> mSv/h

// ---------------- 自动寻路 ----------------

interface Node {
  ix: number; iy: number; iz: number;
  x: number; y: number; z: number;
}

/**
 * 可行走网格: 各房间地坪上方 1m 的平面网格; 门洞连接同层相邻房间, 楼梯连接跨层。
 * cost 模式: 'dose' 最小化剂量积分, 'distance' 最短路径。
 */
export function findRoute(
  project: Project,
  start: Vec3, goal: Vec3,
  sample: (x: number, y: number, z: number) => number,
  cost: 'dose' | 'distance',
  cell = 0.5,
): { path: Vec3[]; totalCost: number; doseMSv: number; lengthM: number } | null {
  const rooms = project.building.rooms;
  // 楼层列表 (标高去重)
  const floors = [...new Set(rooms.map((r) => r.elevation))].sort((a, b) => a - b);
  const floorOfZ = (z: number) => floors.findIndex((f) => Math.abs(z - (f + 1)) < 1.5);

  const roomAt = (x: number, y: number, elev: number) =>
    rooms.find((r) => Math.abs(r.elevation - elev) < 0.6 &&
      x >= r.bounds.min.x && x <= r.bounds.max.x &&
      y >= r.bounds.min.y && y <= r.bounds.max.y);

  const key = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  const toNode = (p: Vec3): Node | null => {
    const iz = floorOfZ(p.z);
    if (iz < 0) return null;
    const elev = floors[iz];
    if (!roomAt(p.x, p.y, elev)) return null;
    return { ix: Math.round(p.x / cell), iy: Math.round(p.y / cell), iz, x: p.x, y: p.y, z: elev + 1 };
  };
  const startNode = toNode(start);
  const goalNode = toNode(goal);
  if (!startNode || !goalNode) return null;

  // 相邻房间 (共享门洞)
  const doorBetween = (a: string, b: string, x: number, y: number) =>
    project.building.openings.some((o) => o.kind === 'door' &&
      ((o.rooms[0] === a && o.rooms[1] === b) || (o.rooms[0] === b && o.rooms[1] === a)) &&
      Math.abs(o.pos.x - x) < 2 && Math.abs(o.pos.y - y) < 2);

  const neighbors = (n: Node): Array<{ node: Node; cost: number }> => {
    const out: Array<{ node: Node; cost: number }> = [];
    const elev = floors[n.iz];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = (n.ix + dx) * cell, ny = (n.iy + dy) * cell;
      const r1 = roomAt(n.ix * cell, n.iy * cell, elev);
      const r2 = roomAt(nx, ny, elev);
      if (!r2) continue;
      if (r1 && r2 && r1.id !== r2.id && !doorBetween(r1.id, r2.id, nx, ny)) continue;
      const doseRate = cost === 'dose' ? sample(nx, ny, elev + 1) * 1000 : 0; // mSv/h
      const edgeLen = cell;
      const transitH = edgeLen / WALK_SPEED / 3600;
      const c = cost === 'dose' ? doseRate * transitH : edgeLen;
      out.push({ node: { ix: n.ix + dx, iy: n.iy + dy, iz: n.iz, x: nx, y: ny, z: elev + 1 }, cost: c });
    }
    // 楼梯: 当前位置靠近楼梯口 -> 该楼梯连接的另一标高层
    for (const o of project.building.openings) {
      if (o.kind !== 'stairs') continue;
      if (Math.abs(o.pos.x - n.ix * cell) > 1.5 || Math.abs(o.pos.y - n.iy * cell) > 1.5) continue;
      // 楼梯连接的两个房间所在标高
      const elevs = o.rooms
        .map((rid) => rooms.find((r) => r.id === rid)?.elevation)
        .filter((e): e is number => e !== undefined);
      for (const e2 of elevs) {
        if (Math.abs(e2 - elev) < 0.6) continue; // 当前层
        const useIz = floors.findIndex((f) => Math.abs(f - e2) < 0.6);
        if (useIz < 0) continue;
        if (!roomAt(o.pos.x, o.pos.y, e2)) continue;
        const dz = Math.abs(e2 - elev);
        const edgeLen = dz * 1.5; // 楼梯折算长度
        const doseRate = cost === 'dose' ? sample(o.pos.x, o.pos.y, (elev + e2) / 2 + 1) * 1000 : 0;
        const c = cost === 'dose' ? doseRate * (edgeLen / WALK_SPEED / 3600) : edgeLen;
        out.push({ node: { ix: Math.round(o.pos.x / cell), iy: Math.round(o.pos.y / cell), iz: useIz, x: o.pos.x, y: o.pos.y, z: e2 + 1 }, cost: c });
      }
    }
    return out;
  };

  // A*
  const open = new Map<string, { node: Node; f: number; g: number }>();
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  const nodeByKey = new Map<string, Node>();
  const h = (n: Node) => {
    const d = Math.hypot(n.x - goalNode.x, n.y - goalNode.y, n.z - goalNode.z);
    return cost === 'dose' ? 0 : d; // dose 模式用 Dijkstra (可容许性难保证, 稳妥)
  };
  const sk = key(startNode.ix, startNode.iy, startNode.iz);
  open.set(sk, { node: startNode, f: 0, g: 0 });
  gScore.set(sk, 0);
  nodeByKey.set(sk, startNode);
  const gk = key(goalNode.ix, goalNode.iy, goalNode.iz);

  let found: string | null = null;
  let guard = 0;
  while (open.size > 0 && guard++ < 200000) {
    let bestK = '', bestF = Infinity;
    for (const [k, v] of open) if (v.f < bestF) { bestF = v.f; bestK = k; }
    const cur = open.get(bestK)!;
    open.delete(bestK);
    if (bestK === gk) { found = bestK; break; }
    for (const { node: nb, cost: ec } of neighbors(cur.node)) {
      const nk = key(nb.ix, nb.iy, nb.iz);
      const g = cur.g + ec;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        cameFrom.set(nk, bestK);
        nodeByKey.set(nk, nb);
        open.set(nk, { node: nb, f: g + h(nb), g });
      }
    }
  }
  if (!found) return null;

  const nodes: Node[] = [];
  let k: string | undefined = found;
  while (k) { nodes.push(nodeByKey.get(k)!); k = cameFrom.get(k); }
  nodes.reverse();
  const path = nodes.map((n) => ({ x: n.x, y: n.y, z: n.z }));

  // 统计实际剂量与长度
  let dose = 0, length = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    length += len;
    const r = (sample(a.x, a.y, a.z) + sample(b.x, b.y, b.z)) / 2;
    dose += r * 1000 * (len / WALK_SPEED / 3600);
  }
  return { path, totalCost: gScore.get(gk)!, doseMSv: dose, lengthM: length };
}
