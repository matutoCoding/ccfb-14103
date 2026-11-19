// 应用外壳: 项目状态、计算引擎、路由、分帧计算循环

import { Project, emptyProject, effectiveBoxes } from '../model/project';
import { generateReactorProject, MODEL_VERSION } from '../model/reactorBuilding';
import { discretizeSource } from '../model/sources';
import { DoseFieldEngine } from '../gpu/engine';
import { saveProject, loadProject, listProjects } from '../db/db';
import { View3D } from './view3d';
import { AABB } from '../physics/geometry';

export interface Page {
  title: string;
  mount(el: HTMLElement, app: App): void;
  unmount?(): void;
}

export class App {
  project: Project = emptyProject();
  engine = new DoseFieldEngine();
  view: View3D | null = null;
  private pages: Record<string, () => Page> = {};
  private currentPage: Page | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  /** 屏蔽差值对照: 开启后保留无临时屏蔽的场用于差值图 */
  baselineField: Float32Array | null = null;

  constructor() {
    window.addEventListener('hashchange', () => this.route());
  }

  registerPage(id: string, factory: () => Page): void {
    this.pages[id] = factory;
  }

  async start(): Promise<void> {
    await this.engine.init();
    const names = await listProjects().catch(() => [] as string[]);
    let loaded: Project | null = null;
    if (names.length > 0) loaded = await loadProject(names[0]);
    if (loaded && loaded.modelVersion === MODEL_VERSION) {
      this.project = loaded;
    } else {
      // 无存档或模型结构已升级: 重新生成
      this.project = generateReactorProject();
      await saveProject(this.project);
    }
    this.buildNav();
    this.configureEngine();
    this.engine.invalidate();
    this.route();
    this.updateProgress();
    this.loop();
  }

  private buildNav(): void {
    const nav = document.getElementById('nav')!;
    const items: Array<[string, string]> = [
      ['model', '厂房模型'], ['sources', '源项管理'], ['shielding', '屏蔽布置'],
      ['doseview', '剂量场视图'], ['paths', '作业路径'], ['alara', 'ALARA 报告'],
    ];
    nav.innerHTML = `<h1>检修剂量场仿真</h1>` +
      items.map(([id, t]) => `<a href="#${id}" data-id="${id}">${t}</a>`).join('') +
      `<div id="progress-wrap"><span id="engine-status">计算引擎</span><div id="progress-bar"><div></div></div></div>`;
  }

  route(): void {
    const id = (location.hash || '#model').slice(1);
    const factory = this.pages[id] ?? this.pages['model'];
    if (!factory) return;
    this.currentPage?.unmount?.();
    this.view?.dispose();
    this.view = null;
    const main = document.getElementById('main')!;
    main.innerHTML = '';
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', (a as HTMLElement).dataset.id === id);
    });
    this.currentPage = factory();
    this.currentPage.mount(main, this);
  }

  /** 场景变化后调用: 更新引擎数据并触发重算; roi 非空时只重算受影响区域 */
  refreshField(roi: AABB | null = null): void {
    if (roi === null) {
      this.configureEngine();
      this.engine.invalidate(null);
    } else {
      // 局部重算: 保留已有场, 只更新场景数据
      const workDate = Date.parse(this.project.settings.workDate);
      const pts = this.project.sources.flatMap((s) => discretizeSource(s, workDate));
      this.engine.setScene(pts, effectiveBoxes(this.project));
      this.engine.invalidate(roi);
    }
    this.emit();
  }

  private configureEngine(): void {
    const b = this.project.building;
    if (b.boxes.length === 0) return;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const bx of b.boxes) {
      min.x = Math.min(min.x, bx.min.x); min.y = Math.min(min.y, bx.min.y); min.z = Math.min(min.z, bx.min.z);
      max.x = Math.max(max.x, bx.max.x); max.y = Math.max(max.y, bx.max.y); max.z = Math.max(max.z, bx.max.z);
    }
    const m = 1;
    this.engine.configureGrid({
      min: { x: min.x - m, y: min.y - m, z: min.z - m },
      max: { x: max.x + m, y: max.y + m, z: max.z + m },
      step: this.project.settings.gridStep,
    });
    const workDate = Date.parse(this.project.settings.workDate);
    const pts = this.project.sources.flatMap((s) => discretizeSource(s, workDate));
    this.engine.setScene(pts, effectiveBoxes(this.project));
  }

  /** 分帧计算循环 */
  private loop = (): void => {
    void (async () => {
      if (this.engine.busy) {
        const more = await this.engine.pumpFrame(12);
        this.updateProgress();
        if (!more) this.emit();
      }
      requestAnimationFrame(this.loop);
    })();
  };

  private updateProgress(): void {
    const bar = document.querySelector('#progress-bar > div') as HTMLElement | null;
    const label = document.getElementById('engine-status');
    if (bar) bar.style.width = `${Math.round(this.engine.progress * 100)}%`;
    if (label) {
      label.textContent = this.engine.busy
        ? `剂量场计算中 ${Math.round(this.engine.progress * 100)}%${this.engine.gpuAvailable ? ' (GPU)' : ' (CPU)'}`
        : `就绪${this.engine.gpuAvailable ? ' (WebGPU)' : ' (CPU 兜底)'}`;
    }
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void saveProject(this.project), 400);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  changed(): void {
    this.save();
    this.emit();
  }
}
