// ALARA 报告页: 方案比选 (铅用量/搭拆剂量/净收益) + 报告导出

import { App, Page } from '../app';
import { h, fmt } from '../dom';
import { compareScenarios, buildAlaraReport, AlaraComparison } from '../../analysis/alara';

export function alaraPage(): Page {
  return {
    title: 'ALARA 报告',
    mount(el, app: App) {
      const resultWrap = h('div');
      el.append(
        h('div', { class: 'panel' },
          h('h2', {}, 'ALARA 方案比选'),
          h('div', { class: 'row' },
            h('button', {
              class: 'primary', onclick: () => {
                if (app.project.paths.length === 0) { alert('请先在「作业路径」页建立至少一条作业路径'); return; }
                resultWrap.innerHTML = '<p class="dim">计算中…</p>';
                setTimeout(() => {
                  const cmp = compareScenarios(app.project, app.project.paths);
                  render(cmp);
                }, 30);
              },
            }, '开始比选计算'),
            h('span', { class: 'dim' }, `方案 ${app.project.scenarios.length} 套 · 路径 ${app.project.paths.length} 条`),
          ),
        ),
        resultWrap,
      );

      function render(cmp: AlaraComparison): void {
        resultWrap.innerHTML = '';
        resultWrap.append(
          h('div', { class: 'panel' },
            h('h2', {}, `基线 (无临时屏蔽): 集体剂量 ${fmt(cmp.baselineCollectiveMSv)} mSv`),
            h('table', {},
              h('tr', {},
                h('th', {}, '方案'), h('th', { class: 'num' }, '铅用量 kg'),
                h('th', { class: 'num' }, '搭拆集体剂量 mSv'), h('th', { class: 'num' }, '实施后集体剂量 mSv'),
                h('th', { class: 'num' }, '节省 mSv'), h('th', { class: 'num' }, '净收益 mSv'),
              ),
              ...cmp.evals.map((e) =>
                h('tr', {},
                  h('td', {}, e.scenario.name),
                  h('td', { class: 'num' }, fmt(e.leadKg, 1)),
                  h('td', { class: 'num' }, fmt(e.installCollectiveMSv)),
                  h('td', { class: 'num' }, fmt(e.collectiveWithMSv)),
                  h('td', { class: 'num' }, fmt(e.savedMSv)),
                  h('td', { class: `num ${e.netBenefitMSv >= 0 ? 'ok' : 'warn'}` }, fmt(e.netBenefitMSv)),
                )),
            ),
            h('div', { class: 'row', style: 'margin-top:10px' },
              h('button', {
                class: 'primary', onclick: () => {
                  const html = buildAlaraReport(app.project, cmp, app.project.paths);
                  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `ALARA报告_${app.project.settings.workDate}.html`;
                  a.click();
                  URL.revokeObjectURL(a.href);
                },
              }, '导出 ALARA 报告 (HTML)'),
            ),
          ),
        );
      }
    },
  };
}
