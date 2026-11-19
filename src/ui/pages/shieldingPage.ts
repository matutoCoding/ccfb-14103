// 屏蔽布置页: 铅毯/铅砖墙拖放布置、方案管理、局部重算、屏蔽前后基准记录

import { App, Page } from '../app';
import { View3D } from '../view3d';
import { h, fmt } from '../dom';
import { ShieldBox, AABB, aabbIntersects } from '../../physics/geometry';
import { ShieldScenario } from '../../model/project';

const PRESETS: Array<{ name: string; size: [number, number, number]; material: 'lead' | 'steel' }> = [
  { name: '铅毯 1.5×2m (6mm)', size: [0.006, 1.5, 2], material: 'lead' },
  { name: '铅毯 1×2m (12mm)', size: [0.012, 1, 2], material: 'lead' },
  { name: '铅砖墙 2×2m (10cm)', size: [0.1, 2, 2], material: 'lead' },
  { name: '铅板 1×1m (25mm)', size: [0.025, 1, 1], material: 'lead' },
  { name: '钢板 1×2m (5cm)', size: [0.05, 1, 2], material: 'steel' },
];

export function shieldingPage(): Page {
  let cleanup: (() => void) | null = null;
  return {
    title: '屏蔽布置',
    mount(el, app: App) {
      let selectedScenarioId: string | null = app.project.scenarios[0]?.id ?? null;
      let placing: typeof PRESETS[0] | null = null;

      const viewWrap = h('div', { class: 'view3d' });
      const sideWrap = h('div');
      const hint = h('div', { class: 'hint' }, '选择左侧屏蔽件后点击场景放置; 拖动可移动 (Shift=升降)');

      el.append(
        h('div', { class: 'split' },
          h('div', { class: 'panel' }, viewWrap),
          h('div', {}, sideWrap),
        ),
      );

      const view = new View3D(viewWrap, app.project);
      app.view = view;
      view.draggableShielding = true;
      viewWrap.append(hint);

      function newScenario(): void {
        const sc: ShieldScenario = {
          id: `sc-${Date.now()}`, name: `方案 ${app.project.scenarios.length + 1}`,
          boxes: [], installCrew: 2, installMinutes: 30,
        };
        app.project.scenarios.push(sc);
        if (!selectedScenarioId) selectedScenarioId = sc.id;
        app.changed();
        render();
      }

      function render(): void {
        sideWrap.innerHTML = '';
        // 方案列表
        const scPanel = h('div', { class: 'panel' }, h('h2', {}, '屏蔽方案'));
        scPanel.append(
          h('div', { class: 'row' }, h('button', { onclick: newScenario }, '新建方案')),
          ...app.project.scenarios.map((sc) => {
            const active = app.project.activeScenarioIds.includes(sc.id);
            return h('div', { class: 'row', style: 'margin-top:6px' },
              h('input', {
                type: 'checkbox', ...(active ? { checked: 'checked' } : {}),
                onchange: (ev: Event) => {
                  const on = (ev.target as HTMLInputElement).checked;
                  app.project.activeScenarioIds = on
                    ? [...app.project.activeScenarioIds, sc.id]
                    : app.project.activeScenarioIds.filter((x) => x !== sc.id);
                  app.changed();
                  app.refreshField();
                  view.syncShielding();
                },
              }),
              h('button', {
                class: sc.id === selectedScenarioId ? 'primary' : '',
                onclick: () => { selectedScenarioId = sc.id; render(); },
              }, sc.name),
              h('span', { class: 'dim' }, `${sc.boxes.length} 件`),
              h('button', {
                class: 'danger', onclick: () => {
                  app.project.scenarios = app.project.scenarios.filter((x) => x.id !== sc.id);
                  app.project.activeScenarioIds = app.project.activeScenarioIds.filter((x) => x !== sc.id);
                  if (selectedScenarioId === sc.id) selectedScenarioId = app.project.scenarios[0]?.id ?? null;
                  app.changed();
                  app.refreshField();
                  view.syncShielding();
                  render();
                },
              }, '删'),
            );
          }),
        );
        sideWrap.append(scPanel);

        // 屏蔽件面板
        const palette = h('div', { class: 'panel' }, h('h2', {}, '屏蔽件 (点击后放到场景)'));
        for (const p of PRESETS) {
          palette.append(h('button', {
            style: `margin:3px;${placing === p ? 'border-color:var(--accent)' : ''}`,
            onclick: () => {
              placing = placing === p ? null : p;
              hint.textContent = placing ? `点击场景放置: ${placing.name}` : '选择左侧屏蔽件后点击场景放置; 拖动可移动 (Shift=升降)';
              render();
            },
          }, p.name));
        }
        sideWrap.append(palette);

        // 当前方案构件清单
        const sc = app.project.scenarios.find((s) => s.id === selectedScenarioId);
        if (sc) {
          const list = h('div', { class: 'panel' }, h('h2', {}, `${sc.name} 构件`));
          const crew = h('input', { type: 'number', value: sc.installCrew, style: 'width:60px' }) as HTMLInputElement;
          const mins = h('input', { type: 'number', value: sc.installMinutes, style: 'width:70px' }) as HTMLInputElement;
          list.append(
            h('div', { class: 'row' }, '搭拆人数 ', crew, ' 时长(min) ', mins,
              h('button', {
                onclick: () => {
                  sc.installCrew = +crew.value || 2;
                  sc.installMinutes = +mins.value || 30;
                  app.changed();
                },
              }, '保存')),
            h('table', { style: 'margin-top:8px' },
              h('tr', {}, h('th', {}, '名称'), h('th', { class: 'num' }, '质量 kg'), h('th', {}, '')),
              ...sc.boxes.map((b) => {
                const vol = (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
                const rho = b.material === 'lead' ? 11340 : 7850;
                return h('tr', {},
                  h('td', {}, b.name),
                  h('td', { class: 'num' }, fmt(vol * rho, 1)),
                  h('td', {}, h('button', {
                    class: 'danger', onclick: () => {
                      sc.boxes = sc.boxes.filter((x) => x.id !== b.id);
                      app.changed();
                      app.refreshField();
                      view.syncShielding();
                      render();
                    },
                  }, '删')),
                );
              }),
            ),
          );
          sideWrap.append(list);
        }

        // 差值基准
        sideWrap.append(
          h('div', { class: 'panel' },
            h('h2', {}, '屏蔽前后对照'),
            h('div', { class: 'row' },
              h('button', {
                onclick: async () => {
                  while (app.engine.busy) await new Promise((r) => setTimeout(r, 200));
                  app.baselineField = app.engine.data.slice();
                  alert('已记录当前剂量场为基准, 到「剂量场视图」开启差值图对照。');
                },
              }, '记录当前场为基准'),
              h('span', { class: 'dim' }, app.baselineField ? '已有基准' : '尚无基准'),
            ),
          ),
        );
      }

      view.onClick = (pick) => {
        if (!placing) return;
        let sc = app.project.scenarios.find((s) => s.id === selectedScenarioId);
        if (!sc) {
          newScenario();
          sc = app.project.scenarios.find((s) => s.id === selectedScenarioId)!;
        }
        const [tx, ty, tz] = placing.size;
        const c = pick.point;
        const b: ShieldBox = {
          id: `sh-${Date.now()}`, name: placing.name, material: placing.material, group: 'shielding',
          scenarioId: sc.id,
          min: { x: c.x - tx / 2, y: c.y - ty / 2, z: c.z - tz / 2 },
          max: { x: c.x + tx / 2, y: c.y + ty / 2, z: c.z + tz / 2 },
        };
        sc.boxes.push(b);
        app.changed();
        app.refreshField(roiOf(b, 5));
        view.syncShielding();
        render();
      };

      view.onShieldingMoved = (id, center) => {
        for (const sc of app.project.scenarios) {
          const b = sc.boxes.find((x) => x.id === id);
          if (!b) continue;
          const oldRoi = roiOf(b, 5);
          const sx = (b.max.x - b.min.x) / 2, sy = (b.max.y - b.min.y) / 2, sz = (b.max.z - b.min.z) / 2;
          b.min = { x: center.x - sx, y: center.y - sy, z: center.z - sz };
          b.max = { x: center.x + sx, y: center.y + sy, z: center.z + sz };
          const roi = unionRoi(oldRoi, roiOf(b, 5));
          app.changed();
          app.refreshField(roi);
          render();
          return;
        }
      };

      render();
      cleanup = app.onChange(() => view.syncShielding());
    },
    unmount() { cleanup?.(); },
  };
}

function roiOf(b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, margin: number): AABB {
  return {
    min: { x: b.min.x - margin, y: b.min.y - margin, z: b.min.z - margin },
    max: { x: b.max.x + margin, y: b.max.y + margin, z: b.max.z + margin },
  };
}

function unionRoi(a: AABB, b: AABB): AABB {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}
