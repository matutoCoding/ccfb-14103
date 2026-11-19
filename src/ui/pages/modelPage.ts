// 厂房模型页: 三维视图 + 房间/构件表 + 材料编辑 + 模型生成

import { App, Page } from '../app';
import { View3D } from '../view3d';
import { h } from '../dom';
import { generateReactorProject } from '../../model/reactorBuilding';
import { MATERIALS, MaterialId } from '../../physics/materials';
import { saveProject } from '../../db/db';

export function modelPage(): Page {
  return {
    title: '厂房模型',
    mount(el, app: App) {
      const viewWrap = h('div', { class: 'view3d' });
      const tableWrap = h('div');
      el.append(
        h('div', { class: 'panel' },
          h('h2', {}, '厂房模型'),
          h('div', { class: 'row' },
            h('button', {
              class: 'primary',
              onclick: async () => {
                if (!confirm('重新生成反应堆厂房模型与巡测数据? 当前模型与源项将被覆盖。')) return;
                app.project = generateReactorProject();
                await saveProject(app.project);
                app.refreshField();
                app.route();
              },
            }, '生成反应堆厂房模型'),
            h('span', { class: 'dim' }, `房间 ${app.project.building.rooms.length} 个 · 构件 ${app.project.building.boxes.length} 块 · 门洞/楼梯 ${app.project.building.openings.length} 处`),
          ),
        ),
        h('div', { class: 'split' },
          h('div', { class: 'panel' }, viewWrap, h('p', { class: 'dim' }, '左键旋转 · 右键平移 · 滚轮缩放 · 点击构件编辑材料')),
          h('div', { class: 'panel' }, h('h2', {}, '房间与标高'), tableWrap),
        ),
      );

      const view = new View3D(viewWrap, app.project);
      app.view = view;
      viewWrap.append(h('div', { class: 'hint' }, '点击构件查看/修改材料'));

      const roomsTable = () => {
        tableWrap.innerHTML = '';
        tableWrap.append(
          h('table', {},
            h('tr', {}, h('th', {}, '房间'), h('th', { class: 'num' }, '标高 m')),
            ...app.project.building.rooms.map((r) =>
              h('tr', {}, h('td', {}, r.name), h('td', { class: 'num' }, r.elevation.toFixed(1)))),
          ),
        );
      };
      roomsTable();

      const editor = h('div');
      el.querySelector('.split')!.append(editor);

      view.onClick = (pick) => {
        // 找最近构件
        const p = pick.point;
        let best: typeof app.project.building.boxes[0] | null = null;
        let bestD = Infinity;
        for (const b of app.project.building.boxes) {
          const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
          const d = (cx - p.x) ** 2 + (cy - p.y) ** 2 + (cz - p.z) ** 2;
          if (d < bestD) { bestD = d; best = b; }
        }
        if (!best) return;
        const box = best;
        editor.innerHTML = '';
        const sel = h('select', {},
          ...Object.values(MATERIALS).map((m) =>
            h('option', { value: m.id, ...(m.id === box.material ? { selected: 'selected' } : {}) }, m.name)),
        ) as HTMLSelectElement;
        const dens = h('input', { type: 'number', step: '0.01', value: box.densityOverride ?? MATERIALS[box.material].density, style: 'width:90px' }) as HTMLInputElement;
        editor.append(
          h('div', { class: 'panel' },
            h('h2', {}, `构件: ${box.name}`),
            h('div', { class: 'row' }, '材料 ', sel, ' 密度 g/cm³ ', dens),
            h('div', { class: 'row', style: 'margin-top:8px' },
              h('button', {
                class: 'primary', onclick: () => {
                  box.material = sel.value as MaterialId;
                  const dv = parseFloat(dens.value);
                  box.densityOverride = isFinite(dv) ? dv : undefined;
                  app.changed();
                  view.syncBuilding();
                  app.refreshField();
                },
              }, '应用并重算'),
            ),
          ),
        );
      };
    },
  };
}
