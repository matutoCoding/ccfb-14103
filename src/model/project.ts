// 项目数据模型:厂房、源项、屏蔽方案、作业路径、巡测点、全局设置

import { ShieldBox, Vec3 } from '../physics/geometry';
import { SourceDef } from './sources';

export interface Room {
  id: string;
  name: string;
  /** 标高 m (地坪) */
  elevation: number;
  bounds: { min: Vec3; max: Vec3 };
}

/** 门洞/楼梯口 (供寻路) */
export interface Opening {
  id: string;
  name: string;
  kind: 'door' | 'stairs';
  /** 连接的两个房间 */
  rooms: [string, string];
  /** 通行中心点 */
  pos: Vec3;
  /** 通行宽度 m */
  width: number;
  /** 楼梯: 目标标高 */
  toElevation?: number;
}

export interface Building {
  rooms: Room[];
  /** 全部结构/设备/管道屏蔽盒 */
  boxes: ShieldBox[];
  openings: Opening[];
}

export interface ShieldScenario {
  id: string;
  name: string;
  /** 临时屏蔽 (铅毯/铅砖墙) */
  boxes: ShieldBox[];
  /** 搭拆估计: 人数、人均在屏蔽旁作业时长 min、作业点剂量率可现场实测或取计算值 */
  installCrew: number;
  installMinutes: number;
}

export interface PathSegment {
  /** 段终点 (起点为上一段终点或路径起点) */
  to: Vec3;
  /** 在该点的停留时间 min */
  dwellMinutes: number;
  /** 作业人数 */
  crew: number;
}

export interface WorkPath {
  id: string;
  name: string;
  start: Vec3;
  segments: PathSegment[];
}

export interface SurveyPoint {
  id: string;
  name: string;
  pos: Vec3;
  /** 实测剂量率 μSv/h */
  measured: number;
}

export interface ProjectSettings {
  /** 作业日期 ISO */
  workDate: string;
  /** 个人日剂量限值 mSv */
  dailyLimitMSv: number;
  /** 剂量网格分辨率 m */
  gridStep: number;
}

export interface Project {
  name: string;
  /** 模型结构版本: 生成器变更时递增, 旧存档自动重建 */
  modelVersion?: number;
  building: Building;
  sources: SourceDef[];
  scenarios: ShieldScenario[];
  /** 当前启用的屏蔽方案 id 列表 */
  activeScenarioIds: string[];
  paths: WorkPath[];
  surveyPoints: SurveyPoint[];
  settings: ProjectSettings;
}

export function emptyProject(): Project {
  return {
    name: '大修剂量仿真',
    building: { rooms: [], boxes: [], openings: [] },
    sources: [],
    scenarios: [],
    activeScenarioIds: [],
    paths: [],
    surveyPoints: [],
    settings: {
      workDate: new Date().toISOString().slice(0, 10),
      dailyLimitMSv: 2,
      gridStep: 0.5,
    },
  };
}

/** 当前生效的全部屏蔽盒 (结构+设备+管道+启用方案的临时屏蔽) */
export function effectiveBoxes(p: Project): ShieldBox[] {
  const boxes = [...p.building.boxes];
  for (const sc of p.scenarios) {
    if (p.activeScenarioIds.includes(sc.id)) boxes.push(...sc.boxes);
  }
  return boxes;
}
