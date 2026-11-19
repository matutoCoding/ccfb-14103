// 作业路径页: 三维点击布点、分段剂量、超限标红、自动低剂量路线对比

import * as THREE from 'three';
import { App, Page } from '../app';
import { View3D } from '../view3d';
import { h, fmt } from '../dom';
import { WorkPath } from '../../model/project';
import { integratePath, findRoute } from '../../analysis/path';

export function pathsPage(): Page {
  let cleanup: (() => void) | null = null;
  return {
    title: '作业路径',
    mount(el, app: App) {
      let editing: WorkPath | null = null;
      let dwell = 10, crew = 2;
      let started = false;

      const viewWrap = h('div', { class: 'view3d' });
      const hint = h('div', { class: 'hint' }, '');
      const listWrap = h('div');
      const detailWrap = h('div');
      const routeWrap = h('div');

      el.append(
        h('div', { class: 'split' },
          h('div', { class: 'panel' }, viewWrap),
          h('div', {},
            h('div', { class: 'panel' }, listWrap),
            routeWrap,
          ),
        ),
        detailWrap,
      );

      const view = new View3D(viewWrap, app.project);
      app.view = view;
      viewWrap.append(hint);
      hint.textContent = '新建路径后在场景中点击布点';

      function renderList(): void {
        listWrap.innerHTML = '';
        listWrap.append(
          h('h2', {}, '作业路径'),
          h('div', { class: 'row' },
            '停留(min) ', inputNum(dwell, (v) => dwell = v, '60px'),
            '人数 ', inputNum(crew, (v) => crew = v, '50px'),
            h('button', {
              class: 'primary', onclick: () => {
                editing = {
                  id: `path-${Date.now()}`, name: `路径 ${app.project.paths.length + 1}`,
                  start: { x: 0, y: 0, z: 1 }, segments: [],
                };
                started = false;
                hint.textContent = '点击场景设置起点';
                renderDetail();
              },
            }, '新建路径'),
          ),
          ...app.project.paths.map((p) => {
            const r = integratePath(p, (x, y, z) => app.engine.sample(x, y, z), app.project.settings.dailyLimitMSv);
            return h('div', { class: 'row', style: 'margin-top:6px' },
              h('button', { onclick: () => { editing = p; renderDetail(); } }, p.name),
              h('span', { class: 'dim' }, `${p.segments.length} 段`),
              h('span', { class: r.individualTotalMSv > app.project.settings.dailyLimitMSv ? 'warn' : 'ok' },
                `个人 ${fmt(r.individualTotalMSv)} mSv`),
              h('span', { class: 'dim' }, `集体 ${fmt(r.collectiveTotalMSv)} mSv`),
              h('button', {
                class: 'danger', onclick: () => {
                  app.project.paths = app.project.paths.filter((x) => x.id !== p.id);
                  if (editing?.id === p.id) editing = null;
                  app.changed();
                  view.syncPaths();
                  renderList();
                  renderDetail();
                },
              }, '删'),
            );
          }),
        );
      }

      function renderDetail(): void {
        detailWrap.innerHTML = '';
        if (!editing) return;
        const p = editing;
        const result = integratePath(p, (x, y, z) => app.engine.sample(x, y, z), app.project.settings.dailyLimitMSv);
        detailWrap.append(
          h('div', { class: 'panel' },
            h('h2', {}, `${p.name} — 个人 ${fmt(result.individualTotalMSv)} mSv / 集体 ${fmt(result.collectiveTotalMSv)} mSv (日限值 ${app.project.settings.dailyLimitMSv} mSv)`),
            h('table', {},
              h('tr', {},
                h('th', {}, '#'), h('th', {}, '终点 (m)'), h('th', { class: 'num' }, '段长 m'),
                h('th', { class: 'num' }, '平均剂量率'), h('th', { class: 'num' }, '行走 mSv'),
                h('th', { class: 'num' }, '停留 mSv'), h('th', { class: 'num' }, '段合计 mSv'),
                h('th', { class: 'num' }, '人数'), h('th', { class: 'num' }, '集体 mSv'),
              ),
              ...result.segments.map((s, i) =>
                h('tr', { class: s.exceedsLimit ? 'warn' : '', style: s.exceedsLimit ? 'background:rgba(255,60,60,.12)' : '' },
                  h('td', {}, String(i + 1)),
                  h('td', {}, `(${s.to.x.toFixed(1)}, ${s.to.y.toFixed(1)}, ${s.to.z.toFixed(1)})`),
                  h('td', { class: 'num' }, fmt(s.lengthM, 2)),
                  h('td', { class: 'num' }, s.avgRateMSvH >= 1 ? `${fmt(s.avgRateMSvH, 2)} mSv/h` : `${fmt(s.avgRateMSvH * 1000, 1)} μSv/h`),
                  h('td', { class: 'num' }, fmt(s.transitDoseMSv)),
                  h('td', { class: 'num' }, fmt(s.dwellDoseMSv)),
                  h('td', { class: 'num' }, fmt(s.segmentDoseMSv)),
                  h('td', { class: 'num' }, String(s.crew)),
                  h('td', { class: 'num' }, fmt(s.collectiveMSv)),
                )),
            ),
            h('div', { class: 'row', style: 'margin-top:8px' },
              h('button', {
                class: 'primary', onclick: () => {
                  if (!app.project.paths.find((x) => x.id === p.id)) app.project.paths.push(p);
                  app.changed();
                  view.syncPaths();
                  renderList();
                },
              }, '保存路径'),
              h('button', { onclick: () => { editing = null; renderDetail(); } }, '关闭'),
            ),
          ),
        );
      }

      // 自动寻路
      routeWrap.append(
        h('h2', {}, '自动低剂量路线'),
        h('div', { class: 'row' },
          h('button', {
            class: 'primary', onclick: () => {
              const p = editing ?? app.project.paths[0];
              if (!p || p.segments.length === 0) { alert('先建一条路径(起点+至少一个途经点)'); return; }
              const goal = p.segments[p.segments.length - 1].to;
              const sample = (x: number, y: number, z: number) => app.engine.sample(x, y, z);
              const low = findRoute(app.project, p.start, goal, sample, 'dose');
              const short = findRoute(app.project, p.start, goal, sample, 'distance');
              showRoute(low, short);
            },
          }, '从当前路径起点到终点寻路'),
        ),
        h('div', { style: 'margin-top:8px' }, ''),
      );

      function showRoute(
        low: ReturnType<typeof findRoute>,
        short: ReturnType<typeof findRoute>,
      ): void {
        view.clearExtra();
        const mk = (path: Array<{ x: number; y: number; z: number }>, color: number) => {
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(path.map((q) => new THREE.Vector3(q.x, q.y, q.z))),
            new THREE.LineBasicMaterial({ color }),
          );
          view.addExtra(line);
        };
        if (low) mk(low.path, 0x4da3ff);
        if (short) mk(short.path, 0xffaa00);
        const div = routeWrap.lastElementChild as HTMLElement;
        div.innerHTML = '';
        if (!low || !short) {
          div.append(h('p', { class: 'warn' }, '未找到通路 (检查起终点是否在房间内、门洞楼梯是否连通)'));
          return;
        }
        const saved = short.doseMSv - low.doseMSv;
        div.append(
          h('table', {},
            h('tr', {}, h('th', {}, '路线'), h('th', { class: 'num' }, '长度 m'), h('th', { class: 'num' }, '通行剂量 mSv')),
            h('tr', {}, h('td', {}, '最短路线 (橙)'), h('td', { class: 'num' }, fmt(short.lengthM, 1)), h('td', { class: 'num' }, fmt(short.doseMSv))),
            h('tr', {}, h('td', {}, '低剂量路线 (蓝)'), h('td', { class: 'num' }, fmt(low.lengthM, 1)), h('td', { class: 'num' }, fmt(low.doseMSv))),
            h('tr', {}, h('td', { class: 'ok' }, '节省'), h('td', { class: 'num' }, ''), h('td', { class: 'num ok' }, `${fmt(saved)} (${short.doseMSv > 0 ? (saved / short.doseMSv * 100).toFixed(0) : 0}%)`)),
          ),
        );
      }

      view.onClick = (pick) => {
        if (!editing) return;
        const pt = { x: +pick.point.x.toFixed(2), y: +pick.point.y.toFixed(2), z: +pick.point.z.toFixed(2) };
        if (!started) {
          editing.start = pt;
          started = true;
          hint.textContent = '继续点击添加途经点';
        } else {
          editing.segments.push({ to: pt, dwellMinutes: dwell, crew });
        }
        // 临时显示
        const tmpPaths = app.project.paths.includes(editing) ? app.project.paths : [...app.project.paths, editing];
        const orig = app.project.paths;
        app.project.paths = tmpPaths;
        view.syncPaths();
        app.project.paths = orig;
        renderDetail();
      };

      renderList();
      cleanup = app.onChange(() => { renderList(); renderDetail(); });
    },
    unmount() { cleanup?.(); },
  };
}

function inputNum(v: number, set: (n: number) => void, w: string): HTMLElement {
  const inp = h('input', { type: 'number', value: v, style: `width:${w}` }) as HTMLInputElement;
  inp.onchange = () => set(+inp.value || 0);
  return inp;
}
