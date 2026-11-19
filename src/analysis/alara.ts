// ALARA 方案比选与报告
// 每套屏蔽方案: 铅用量、搭拆剂量、对给定作业路径节省的集体剂量、净收益。

import { Project, ShieldScenario } from '../model/project';
import { WorkPath } from '../model/project';
import { integratePath, PathDoseResult } from './path';
import { discretizeSource } from '../model/sources';
import { totalDoseRate } from '../physics/pointkernel';
import { ShieldBox } from '../physics/geometry';

const LEAD_DENSITY = 11.34; // g/cm³

export interface ScenarioEval {
  scenario: ShieldScenario;
  /** 铅用量 kg */
  leadKg: number;
  /** 搭拆集体剂量 mSv (估算) */
  installCollectiveMSv: number;
  /** 启用该方案后全部作业路径的集体剂量 mSv */
  collectiveWithMSv: number;
  /** 相对无临时屏蔽节省的集体剂量 mSv */
  savedMSv: number;
  /** 净收益 mSv (节省 - 搭拆) */
  netBenefitMSv: number;
}

export interface AlaraComparison {
  baselineCollectiveMSv: number;
  baselineIndividual: number[];
  evals: ScenarioEval[];
}

function volumeM3(b: ShieldBox): number {
  return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
}

/** 搭拆剂量估算: 搭拆人员位于屏蔽物旁, 取盒外 0.5m 四个方向中
 *  不落在任何实体盒内部的候选点, 剂量率取无临时屏蔽工况的最大值。 */
function installDose(project: Project, sc: ShieldScenario): number {
  const workDate = Date.parse(project.settings.workDate);
  const pts = project.sources.flatMap((s) => discretizeSource(s, workDate));
  const baseBoxes = project.building.boxes; // 无临时屏蔽
  const insideAny = (p: { x: number; y: number; z: number }) =>
    baseBoxes.some((b) =>
      p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z);
  let rateSum = 0;
  for (const b of sc.boxes) {
    const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
    const candidates: Array<{ x: number; y: number; z: number }> = [];
    for (const dist of [0.5, 1.0, 1.5]) {
      candidates.push(
        { x: cx + ((b.max.x - b.min.x) / 2 + dist), y: cy, z: cz },
        { x: cx - ((b.max.x - b.min.x) / 2 + dist), y: cy, z: cz },
        { x: cx, y: cy + ((b.max.y - b.min.y) / 2 + dist), z: cz },
        { x: cx, y: cy - ((b.max.y - b.min.y) / 2 + dist), z: cz },
      );
    }
    const valid = candidates.filter((p) => !insideAny(p));
    let maxR = 0;
    for (const p of valid) maxR = Math.max(maxR, totalDoseRate(pts, p, baseBoxes));
    rateSum += maxR;
  }
  const hours = sc.installMinutes / 60;
  return rateSum * 1000 * hours * sc.installCrew; // mSv
}

/** 构造采样函数: 结构盒 + 指定临时屏蔽盒, 用点核直接算 (路径积分点数有限, 可接受) */
export function makeSampler(project: Project, extraShielding: ShieldBox[]): (x: number, y: number, z: number) => number {
  const workDate = Date.parse(project.settings.workDate);
  const pts = project.sources.flatMap((s) => discretizeSource(s, workDate));
  const boxes = [...project.building.boxes, ...extraShielding];
  return (x, y, z) => totalDoseRate(pts, { x, y, z }, boxes);
}

/** 比选全部方案 */
export function compareScenarios(
  project: Project,
  paths: WorkPath[],
  samplerFast?: (extra: ShieldBox[]) => (x: number, y: number, z: number) => number,
): AlaraComparison {
  const limit = project.settings.dailyLimitMSv;
  const mk = samplerFast ?? ((extra: ShieldBox[]) => makeSampler(project, extra));

  const baseSample = mk([]);
  let baselineCollective = 0;
  const baselineIndividual: number[] = [];
  for (const p of paths) {
    const r = integratePath(p, baseSample, limit);
    baselineCollective += r.collectiveTotalMSv;
    baselineIndividual.push(r.individualTotalMSv);
  }

  const evals: ScenarioEval[] = project.scenarios.map((sc) => {
    const sample = mk(sc.boxes);
    let collective = 0;
    for (const p of paths) collective += integratePath(p, sample, limit).collectiveTotalMSv;
    const leadKg = sc.boxes
      .filter((b) => b.material === 'lead')
      .reduce((a, b) => a + volumeM3(b) * 1e6 * LEAD_DENSITY / 1000, 0);
    const install = installDose(project, sc);
    const saved = baselineCollective - collective;
    return {
      scenario: sc, leadKg, installCollectiveMSv: install,
      collectiveWithMSv: collective, savedMSv: saved, netBenefitMSv: saved - install,
    };
  });

  return { baselineCollectiveMSv: baselineCollective, baselineIndividual, evals };
}

/** 导出 ALARA 报告 (HTML 字符串) */
export function buildAlaraReport(project: Project, cmp: AlaraComparison, paths: WorkPath[]): string {
  const rows = cmp.evals.map((e) => `
    <tr>
      <td>${esc(e.scenario.name)}</td>
      <td>${e.leadKg.toFixed(1)}</td>
      <td>${e.installCollectiveMSv.toFixed(3)}</td>
      <td>${e.collectiveWithMSv.toFixed(3)}</td>
      <td>${e.savedMSv.toFixed(3)}</td>
      <td class="${e.netBenefitMSv >= 0 ? 'pos' : 'neg'}">${e.netBenefitMSv.toFixed(3)}</td>
    </tr>`).join('');
  const pathRows = paths.map((p, i) => `
    <tr><td>${esc(p.name)}</td><td>${cmp.baselineIndividual[i]?.toFixed(3) ?? '-'}</td></tr>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>ALARA 报告 - ${esc(project.name)}</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:2em;color:#222}
table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #999;padding:4px 12px;text-align:right}
td:first-child,th:first-child{text-align:left}th{background:#eee}
.pos{color:#080}.neg{color:#c00}h1{font-size:1.4em}h2{font-size:1.1em;margin-top:1.5em}
</style></head><body>
<h1>ALARA 报告 — ${esc(project.name)}</h1>
<p>作业日期: ${project.settings.workDate} &nbsp; 个人日限值: ${project.settings.dailyLimitMSv} mSv &nbsp; 生成时间: ${new Date().toLocaleString('zh-CN')}</p>
<h2>无临时屏蔽基线</h2>
<p>全部作业路径集体剂量: <b>${cmp.baselineCollectiveMSv.toFixed(3)} mSv</b></p>
<table><tr><th>作业路径</th><th>个人剂量 mSv</th></tr>${pathRows}</table>
<h2>屏蔽方案比选</h2>
<table><tr><th>方案</th><th>铅用量 kg</th><th>搭拆集体剂量 mSv</th><th>实施后集体剂量 mSv</th><th>节省 mSv</th><th>净收益 mSv</th></tr>${rows}</table>
<p style="color:#666;font-size:0.9em">计算方法: 点核积分 + Berger 累积因子; 衰变按作业日期修正; 搭拆剂量按屏蔽物旁 0.5m 处最大剂量率估算。</p>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
