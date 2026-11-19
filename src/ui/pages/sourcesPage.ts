// 源项管理页: 源项表(点/线/面)、衰变计算、新增点源、巡测对标与源项标定

import { App, Page } from '../app';
import { h, fmt, fmtRate } from '../dom';
import { ISOTOPE_LIST } from '../../physics/isotopes';
import { activityAt, PointSourceDef } from '../../model/sources';
import { compareSurvey, calibrateSources, applyCalibration, CalibrationResult } from '../../analysis/survey';

export function sourcesPage(): Page {
  let cleanup: (() => void) | null = null;
  return {
    title: '源项管理',
    mount(el, app: App) {
      const listWrap = h('div');
      const surveyWrap = h('div');

      const workDateInput = h('input', {
        type: 'date', value: app.project.settings.workDate,
        onchange: (ev: Event) => {
          app.project.settings.workDate = (ev.target as HTMLInputElement).value;
          app.changed();
          app.refreshField();
          render();
        },
      }) as HTMLInputElement;

      el.append(
        h('div', { class: 'panel' },
          h('h2', {}, '源项管理'),
          h('div', { class: 'row' },
            '作业日期 ', workDateInput,
            h('span', { class: 'dim' }, '活度按参考日录入, 自动衰变修正到作业日期'),
          ),
        ),
        h('div', { class: 'panel' }, listWrap),
        h('div', { class: 'panel' }, h('h2', {}, '新增点源'), addPointForm()),
        h('div', { class: 'panel' }, surveyWrap),
      );

      function addPointForm(): HTMLElement {
        const name = h('input', { placeholder: '名称', value: '新点源' }) as HTMLInputElement;
        const coords = ['x', 'y', 'z'].map((axis) =>
          h('input', { type: 'number', step: '0.1', value: '0', style: 'width:70px', title: axis }) as HTMLInputElement);
        const acts = ISOTOPE_LIST.map((iso) =>
          h('input', { type: 'number', step: 'any', value: '0', style: 'width:110px', title: iso.name }) as HTMLInputElement);
        return h('div', {},
          h('div', { class: 'row' }, '名称 ', name, ' 位置(m) x/y/z ', ...coords),
          h('div', { class: 'row', style: 'margin-top:6px' },
            '活度(GBq) ', ...ISOTOPE_LIST.map((iso, i) => h('span', {}, ` ${iso.name} `, acts[i]))),
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', {
              class: 'primary', onclick: () => {
                const activities: Record<string, number> = {};
                ISOTOPE_LIST.forEach((iso, i) => {
                  const v = parseFloat(acts[i].value) || 0;
                  if (v > 0) activities[iso.id] = v * 1e9;
                });
                const src: PointSourceDef = {
                  id: `src-${Date.now()}`, name: name.value || '点源', type: 'point',
                  refDate: app.project.settings.workDate,
                  activities,
                  pos: { x: +coords[0].value || 0, y: +coords[1].value || 0, z: +coords[2].value || 0 },
                };
                app.project.sources.push(src);
                app.changed();
                app.refreshField();
                render();
              },
            }, '添加'),
          ),
        );
      }

      function render(): void {
        const workDate = Date.parse(app.project.settings.workDate);
        listWrap.innerHTML = '';
        listWrap.append(
          h('table', {},
            h('tr', {},
              h('th', {}, '名称'), h('th', {}, '类型'),
              ...ISOTOPE_LIST.map((iso) => h('th', { class: 'num' }, `${iso.name} GBq`)),
              h('th', { class: 'num' }, '作业日总活度 GBq'), h('th', {}, ''),
            ),
            ...app.project.sources.map((s) =>
              h('tr', {},
                h('td', {}, s.name),
                h('td', {}, s.type === 'point' ? '点源' : s.type === 'line' ? '线源' : '面源'),
                ...ISOTOPE_LIST.map((iso) =>
                  h('td', { class: 'num' }, fmt(activityAt(s, iso.id, workDate) / 1e9, 3))),
                h('td', { class: 'num' }, fmt(
                  ISOTOPE_LIST.reduce((a, iso) => a + activityAt(s, iso.id, workDate), 0) / 1e9, 3)),
                h('td', {}, h('button', {
                  class: 'danger', onclick: () => {
                    app.project.sources = app.project.sources.filter((x) => x.id !== s.id);
                    app.changed();
                    app.refreshField();
                    render();
                  },
                }, '删除')),
              )),
          ),
        );
        renderSurvey();
      }

      function renderSurvey(): void {
        surveyWrap.innerHTML = '';
        const cmp = compareSurvey(app.project);
        const rms = Math.sqrt(cmp.reduce((a, c) => a + c.relDev ** 2, 0) / Math.max(1, cmp.length));
        const resultHolder = h('div');
        surveyWrap.append(
          h('h2', {}, `巡测对标 (${cmp.length} 点, RMS 偏差 ${(rms * 100).toFixed(1)}%)`),
          h('div', { class: 'row' },
            h('button', {
              class: 'primary', onclick: () => {
                const result = calibrateSources(app.project);
                showCalibration(result);
              },
            }, '按巡测偏差标定源项'),
            h('span', { class: 'dim' }, '非负最小二乘(乘性迭代)反推各源活度比例因子'),
          ),
          resultHolder,
          h('table', { style: 'margin-top:10px' },
            h('tr', {}, h('th', {}, '测点'), h('th', { class: 'num' }, '实测'), h('th', { class: 'num' }, '计算'), h('th', { class: 'num' }, '偏差%')),
            ...cmp.map((c) =>
              h('tr', {},
                h('td', {}, c.point.name),
                h('td', { class: 'num' }, fmtRate(c.measured)),
                h('td', { class: 'num' }, fmtRate(c.computed)),
                h('td', { class: `num ${Math.abs(c.relDev) > 0.3 ? 'warn' : ''}` }, (c.relDev * 100).toFixed(1)),
              )),
          ),
        );

        function showCalibration(result: CalibrationResult): void {
          resultHolder.innerHTML = '';
          resultHolder.append(
            h('div', { class: 'panel', style: 'background:#16202e;margin-top:10px' },
              h('h2', {}, `标定结果: RMS ${(result.rmsBefore * 100).toFixed(1)}% → ${(result.rmsAfter * 100).toFixed(1)}%`),
              h('table', {},
                h('tr', {}, h('th', {}, '源项'), h('th', { class: 'num' }, '活度比例因子')),
                ...app.project.sources.map((s) =>
                  h('tr', {}, h('td', {}, s.name), h('td', { class: 'num' }, fmt(result.factors[s.id] ?? 1, 3)))),
              ),
              h('h2', {}, '标定后残差'),
              h('table', {},
                h('tr', {}, h('th', {}, '测点'), h('th', { class: 'num' }, '标定前偏差%'), h('th', { class: 'num' }, '标定后偏差%')),
                ...result.after.map((c, i) =>
                  h('tr', {},
                    h('td', {}, c.point.name),
                    h('td', { class: 'num' }, (result.before[i].relDev * 100).toFixed(1)),
                    h('td', { class: `num ${Math.abs(c.relDev) > 0.2 ? 'warn' : 'ok'}` }, (c.relDev * 100).toFixed(1)),
                  ))),
              h('div', { class: 'row', style: 'margin-top:8px' },
                h('button', {
                  class: 'primary', onclick: () => {
                    applyCalibration(app.project, result.factors);
                    app.changed();
                    app.refreshField();
                    render();
                  },
                }, '应用标定到源项'),
              ),
            ),
          );
        }
      }

      render();
      cleanup = app.onChange(render);
    },
    unmount() { cleanup?.(); },
  };
}
