// 反应堆厂房模型 + 巡测数据自动生成器
// 生成一座三标高层安全壳厂房: -4m 堆坑层 / 0m 主设备层(SG间×2、主泵间×2、中央堆腔) / +8m 操作大厅
// 巡测数据: 用一套"真实"源项(活度在建模值基础上随机浮动)做点核计算, 加 5% 噪声作为实测值。

import { ShieldBox, Vec3 } from '../physics/geometry';
import { Project, Building, Room, Opening, SurveyPoint } from './project';
import { SourceDef, discretizeSource } from './sources';
import { totalDoseRate } from '../physics/pointkernel';

/** 可复现随机数 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let boxSeq = 0;
function box(
  name: string, material: ShieldBox['material'],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  group: ShieldBox['group'] = 'structure',
): ShieldBox {
  return {
    id: `bx${boxSeq++}`, name, material, group,
    min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
    max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  };
}

export const MODEL_VERSION = 3;

export function generateReactorProject(): Project {
  boxSeq = 0;
  const boxes: ShieldBox[] = [];
  const rooms: Room[] = [];
  const openings: Opening[] = [];

  // ---------- 结构 ----------
  // 安全壳外墙: x,y ∈ [-10,10], z ∈ [-4,14], 混凝土 0.9m
  const W = 0.9, R = 10;
  boxes.push(box('外墙-西', 'concrete', -R, -R, -4, -R + W, R, 14));
  boxes.push(box('外墙-东', 'concrete', R - W, -R, -4, R, R, 14));
  boxes.push(box('外墙-南', 'concrete', -R, -R, -4, R, -R + W, 14));
  boxes.push(box('外墙-北', 'concrete', -R, R - W, -4, R, R, 14));
  boxes.push(box('底板', 'concrete', -R, -R, -4.8, R, R, -4));
  boxes.push(box('顶板', 'concrete', -R, -R, 14, R, R, 14.8));
  // 0m 楼板 (主设备层地坪, 中央留 2×2m 堆坑楼梯口)
  boxes.push(box('0m楼板-南', 'concrete', -R, -R, -0.8, R, -1, 0));
  boxes.push(box('0m楼板-北', 'concrete', -R, 1, -0.8, R, R, 0));
  boxes.push(box('0m楼板-西', 'concrete', -R, -1, -0.8, -1, 1, 0));
  boxes.push(box('0m楼板-东', 'concrete', 1, -1, -0.8, R, 1, 0));
  // +8m 楼板 (留堆腔吊物孔 x,y∈[-2,2])
  boxes.push(box('8m楼板-南', 'concrete', -R, -R, 8, R, -2, 8.8));
  boxes.push(box('8m楼板-北', 'concrete', -R, 2, 8, R, R, 8.8));
  boxes.push(box('8m楼板-西', 'concrete', -R, -2, 8, -2, 2, 8.8));
  boxes.push(box('8m楼板-东', 'concrete', 2, -2, 8, R, 2, 8.8));

  // 主设备层内隔墙 (0.5m 混凝土): x=±2.25 与 y=±0.25 两道, 把 0m 层分成
  // 中央堆腔 + 四个象限房间 (SG-A 西北 / SG-B 东北 / 主泵-A 西南 / 主泵-B 东南),
  // 隔墙在门洞处断开 (门宽 1.2m)。
  // x=-2.25 墙 (门洞: y∈[0.4,1.6] 通SG-A, y∈[-1.6,-0.4] 通主泵-A)
  boxes.push(box('隔墙-西-1', 'concrete', -2.5, -9.1, 0, -2, -1.6, 8));
  boxes.push(box('隔墙-西-2', 'concrete', -2.5, -0.4, 0, -2, 0.4, 8));
  boxes.push(box('隔墙-西-3', 'concrete', -2.5, 1.6, 0, -2, 9.1, 8));
  // x=+2.25 墙 (门洞: y∈[0.4,1.6] 通SG-B, y∈[-1.6,-0.4] 通主泵-B)
  boxes.push(box('隔墙-东-1', 'concrete', 2, -9.1, 0, 2.5, -1.6, 8));
  boxes.push(box('隔墙-东-2', 'concrete', 2, -0.4, 0, 2.5, 0.4, 8));
  boxes.push(box('隔墙-东-3', 'concrete', 2, 1.6, 0, 2.5, 9.1, 8));
  // y=0 墙西段 (门洞 x∈[-5.6,-4.4]: SG-A ↔ 主泵-A)
  boxes.push(box('隔墙-南-1', 'concrete', -9.1, -0.25, 0, -5.6, 0.25, 8));
  boxes.push(box('隔墙-南-2', 'concrete', -4.4, -0.25, 0, -2.5, 0.25, 8));
  // y=0 墙东段 (门洞 x∈[4.4,5.6]: SG-B ↔ 主泵-B)
  boxes.push(box('隔墙-北-1', 'concrete', 2.5, -0.25, 0, 4.4, 0.25, 8));
  boxes.push(box('隔墙-北-2', 'concrete', 5.6, -0.25, 0, 9.1, 0.25, 8));

  rooms.push(
    { id: 'pit', name: '堆坑层(-4m)', elevation: -4, bounds: { min: { x: -9.1, y: -9.1, z: -4 }, max: { x: 9.1, y: 9.1, z: -0.8 } } },
    { id: 'sg-a', name: 'SG间A(0m)', elevation: 0, bounds: { min: { x: -9.1, y: 0.25, z: 0 }, max: { x: -2.5, y: 9.1, z: 8 } } },
    { id: 'sg-b', name: 'SG间B(0m)', elevation: 0, bounds: { min: { x: 2.5, y: 0.25, z: 0 }, max: { x: 9.1, y: 9.1, z: 8 } } },
    { id: 'rcp-a', name: '主泵间A(0m)', elevation: 0, bounds: { min: { x: -9.1, y: -9.1, z: 0 }, max: { x: -2.5, y: -0.25, z: 8 } } },
    { id: 'rcp-b', name: '主泵间B(0m)', elevation: 0, bounds: { min: { x: 2.5, y: -9.1, z: 0 }, max: { x: 9.1, y: -0.25, z: 8 } } },
    { id: 'cavity', name: '中央堆腔(0m)', elevation: 0, bounds: { min: { x: -2, y: -2, z: 0 }, max: { x: 2, y: 2, z: 8 } } },
    { id: 'hall', name: '操作大厅(+8m)', elevation: 8.8, bounds: { min: { x: -9.1, y: -9.1, z: 8.8 }, max: { x: 9.1, y: 9.1, z: 14 } } },
  );

  openings.push(
    { id: 'd-sga', name: 'SG-A↔堆腔门', kind: 'door', rooms: ['sg-a', 'cavity'], pos: { x: -2.25, y: 1, z: 0 }, width: 1.2 },
    { id: 'd-sgb', name: 'SG-B↔堆腔门', kind: 'door', rooms: ['sg-b', 'cavity'], pos: { x: 2.25, y: 1, z: 0 }, width: 1.2 },
    { id: 'd-rcpa', name: '主泵-A↔堆腔门', kind: 'door', rooms: ['rcp-a', 'cavity'], pos: { x: -2.25, y: -1, z: 0 }, width: 1.2 },
    { id: 'd-rcpb', name: '主泵-B↔堆腔门', kind: 'door', rooms: ['rcp-b', 'cavity'], pos: { x: 2.25, y: -1, z: 0 }, width: 1.2 },
    { id: 'd-west', name: 'SG-A↔主泵-A门', kind: 'door', rooms: ['sg-a', 'rcp-a'], pos: { x: -5, y: 0, z: 0 }, width: 1.2 },
    { id: 'd-east', name: 'SG-B↔主泵-B门', kind: 'door', rooms: ['sg-b', 'rcp-b'], pos: { x: 5, y: 0, z: 0 }, width: 1.2 },
    { id: 'st-pit', name: '堆坑楼梯', kind: 'stairs', rooms: ['cavity', 'pit'], pos: { x: 0, y: 0, z: 0 }, width: 1.5, toElevation: -4 },
    { id: 'st-hall', name: '大厅楼梯', kind: 'stairs', rooms: ['sg-a', 'hall'], pos: { x: -6, y: 6, z: 0 }, width: 1.5, toElevation: 8.8 },
  );

  // ---------- 设备 ----------
  // 注意: 屏蔽体不允许嵌套 (射线按盒逐一累加衰减, 嵌套会重复计数)。
  // 容器类设备用 6 块壁板拼壳, 内腔另放充水盒。
  const shell = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number) => {
    boxes.push(box(`${name}-壁x-`, 'steel', x0, y0, z0, x0 + t, y1, z1, 'equipment'));
    boxes.push(box(`${name}-壁x+`, 'steel', x1 - t, y0, z0, x1, y1, z1, 'equipment'));
    boxes.push(box(`${name}-壁y-`, 'steel', x0 + t, y0, z0, x1 - t, y0 + t, z1, 'equipment'));
    boxes.push(box(`${name}-壁y+`, 'steel', x0 + t, y1 - t, z0, x1 - t, y1, z1, 'equipment'));
    boxes.push(box(`${name}-底`, 'steel', x0 + t, y0 + t, z0, x1 - t, y1 - t, z0 + t, 'equipment'));
    boxes.push(box(`${name}-顶`, 'steel', x0 + t, y0 + t, z1 - t, x1 - t, y1 - t, z1, 'equipment'));
  };
  // 反应堆压力容器 (壁 20cm)
  shell('RPV', -1.5, -1.5, 0, 1.5, 1.5, 7, 0.2);
  // 蒸汽发生器 A/B (壳 10cm + 下部水室)
  shell('SG-A壳体', -6.5, 4.5, 0, -4.5, 6.5, 7, 0.1);
  boxes.push(box('SG-A水室', 'water', -6.3, 4.7, 0.2, -4.7, 6.3, 1.8, 'equipment'));
  shell('SG-B壳体', 4.5, 4.5, 0, 6.5, 6.5, 7, 0.1);
  boxes.push(box('SG-B水室', 'water', 4.7, 4.7, 0.2, 6.3, 6.3, 1.8, 'equipment'));
  // 主泵 A/B (近似实心钢)
  boxes.push(box('主泵A', 'steel', -6.3, -6.3, 0, -4.7, -4.7, 2.6, 'equipment'));
  boxes.push(box('主泵B', 'steel', 4.7, -6.3, 0, 6.3, -4.7, 2.6, 'equipment'));
  // 主循环管道: 钢壁+充水按等效密度 2.0 g/cm³ 抹平 (densityOverride)
  const pipe = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const b = box(name, 'steel', x0 - 0.22, y0 - 0.22, z0 - 0.22, x1 + 0.22, y1 + 0.22, z1 + 0.22, 'pipe');
    b.densityOverride = 2.0;
    boxes.push(b);
  };
  // 环路A
  pipe('热段A', -1.5, 1.0, 3.5, -5.5, 1.0, 3.5);
  pipe('热段A立管', -5.5, 1.0, 3.5, -5.5, 4.5, 3.5);
  pipe('冷段A', -5.5, -4.7, 1.2, -5.5, 1.0, 1.2);
  pipe('冷段A回', -5.5, -4.7, 1.2, -1.5, -1.0, 1.2);
  // 环路B
  pipe('热段B', 1.5, 1.0, 3.5, 5.5, 1.0, 3.5);
  pipe('热段B立管', 5.5, 1.0, 3.5, 5.5, 4.5, 3.5);
  pipe('冷段B', 5.5, -4.7, 1.2, 5.5, 1.0, 1.2);
  pipe('冷段B回', 5.5, -4.7, 1.2, 1.5, -1.0, 1.2);

  const building: Building = { rooms, boxes, openings };

  // ---------- 源项 (建模值, 参考日 2026-03-01) ----------
  const refDate = '2026-03-01';
  const GBq = 1e9;
  const sources: SourceDef[] = [
    {
      id: 'src-sga-surf', name: 'SG-A水室内表面沉积', type: 'surface', refDate,
      activities: { Co58: 180 * GBq, Co60: 60 * GBq, Cs137: 2 * GBq },
      box: { min: { x: -6.3, y: 4.7, z: 0.2 }, max: { x: -4.7, y: 6.3, z: 1.8 } },
      faces: ['z+', 'x-', 'x+', 'y-', 'y+'], spacing: 0.4,
    },
    {
      id: 'src-sgb-surf', name: 'SG-B水室内表面沉积', type: 'surface', refDate,
      activities: { Co58: 150 * GBq, Co60: 55 * GBq, Cs137: 1.5 * GBq },
      box: { min: { x: 4.7, y: 4.7, z: 0.2 }, max: { x: 6.3, y: 6.3, z: 1.8 } },
      faces: ['z+', 'x-', 'x+', 'y-', 'y+'], spacing: 0.4,
    },
    {
      id: 'src-pumpa-surf', name: '主泵A内表面沉积', type: 'surface', refDate,
      activities: { Co58: 60 * GBq, Co60: 25 * GBq },
      box: { min: { x: -6.1, y: -6.1, z: 0.2 }, max: { x: -4.9, y: -4.9, z: 2.4 } },
      spacing: 0.4,
    },
    {
      id: 'src-pumpb-surf', name: '主泵B内表面沉积', type: 'surface', refDate,
      activities: { Co58: 55 * GBq, Co60: 22 * GBq },
      box: { min: { x: 4.9, y: -6.1, z: 0.2 }, max: { x: 6.1, y: -4.9, z: 2.4 } },
      spacing: 0.4,
    },
    {
      id: 'src-pipe-a', name: '主管道A环线源', type: 'line', refDate,
      activities: { Co58: 120 * GBq, Co60: 40 * GBq },
      path: [
        { x: -1.5, y: 1.0, z: 3.5 }, { x: -5.5, y: 1.0, z: 3.5 },
        { x: -5.5, y: 4.5, z: 3.5 }, { x: -5.5, y: 1.0, z: 1.2 },
        { x: -5.5, y: -4.7, z: 1.2 }, { x: -1.5, y: -1.0, z: 1.2 },
      ],
      spacing: 0.5,
    },
    {
      id: 'src-pipe-b', name: '主管道B环线源', type: 'line', refDate,
      activities: { Co58: 110 * GBq, Co60: 38 * GBq },
      path: [
        { x: 1.5, y: 1.0, z: 3.5 }, { x: 5.5, y: 1.0, z: 3.5 },
        { x: 5.5, y: 4.5, z: 3.5 }, { x: 5.5, y: 1.0, z: 1.2 },
        { x: 5.5, y: -4.7, z: 1.2 }, { x: 1.5, y: -1.0, z: 1.2 },
      ],
      spacing: 0.5,
    },
    {
      id: 'src-hotspot-pit', name: '堆坑热点(点源)', type: 'point', refDate,
      activities: { Co60: 8 * GBq, Cs137: 3 * GBq },
      pos: { x: 3, y: 3, z: -3 },
    },
    {
      id: 'src-hotspot-filter', name: '废过滤器(点源)', type: 'point', refDate,
      activities: { Co60: 15 * GBq, Cs137: 6 * GBq },
      pos: { x: -8, y: -8, z: 0.5 },
    },
  ];

  const project: Project = {
    name: '反应堆厂房大修剂量仿真',
    modelVersion: MODEL_VERSION,
    building,
    sources,
    scenarios: [],
    activeScenarioIds: [],
    paths: [],
    surveyPoints: [],
    settings: { workDate: '2026-05-15', dailyLimitMSv: 2, gridStep: 0.5 },
  };

  project.surveyPoints = generateSurveyData(project);
  return project;
}

/** 巡测数据: "真实"源项 = 建模活度 × 随机因子, 点核计算 + 5% 噪声 */
export function generateSurveyData(project: Project): SurveyPoint[] {
  const rand = mulberry32(20260515);
  const workDate = Date.parse(project.settings.workDate);

  // 真实源项: 每个源每项活度乘 0.7~1.4
  const trueSources: SourceDef[] = project.sources.map((s) => {
    const activities: Record<string, number> = {};
    for (const [iso, a] of Object.entries(s.activities)) {
      activities[iso] = a * (0.7 + rand() * 0.7);
    }
    return { ...s, activities };
  });
  const truePoints = trueSources.flatMap((s) => discretizeSource(s, workDate));
  const boxes = project.building.boxes;

  // 巡测点: 各房间离地 1m 若干点
  const spots: Array<[string, number, number, number]> = [];
  const roomSpots: Record<string, Array<[number, number]>> = {
    'sg-a': [[-4, 4], [-7, 7], [-4, 7.5], [-7.5, 3.5], [-3, 5.5]],
    'sg-b': [[4, 4], [7, 7], [4, 7.5], [7.5, 3.5], [3, 5.5]],
    'rcp-a': [[-4, -4], [-7, -7], [-4, -7.5], [-7.5, -3.5], [-3, -5.5]],
    'rcp-b': [[4, -4], [7, -7], [4, -7.5], [7.5, -3.5], [3, -5.5]],
    'cavity': [[0, 0], [1.2, -1.2], [-1.2, 1.2]],
    'hall': [[-5, 0], [5, 0], [0, -5], [0, 5], [-6, -6], [6, 6]],
    'pit': [[3, -3], [-3, 3], [5, 5], [-5, -5]],
  };
  const roomZ: Record<string, number> = {
    'sg-a': 1, 'sg-b': 1, 'rcp-a': 1, 'rcp-b': 1, 'cavity': 1, 'hall': 9.8, 'pit': -3,
  };
  for (const [room, list] of Object.entries(roomSpots)) {
    list.forEach(([x, y], i) => spots.push([`${room}#${i + 1}`, x, y, roomZ[room]]));
  }

  return spots.map(([name, x, y, z]) => {
    const pos: Vec3 = { x, y, z };
    const exact = totalDoseRate(truePoints, pos, boxes); // Sv/h
    const noisy = exact * (1 + (rand() - 0.5) * 0.1);
    return { id: `sv-${name}`, name, pos, measured: noisy * 1e6 }; // μSv/h
  });
}
