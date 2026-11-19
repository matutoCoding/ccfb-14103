// 剂量场视图页: 任意剖切面热图、对数色标、等剂量线、悬停读数、主要贡献源、差值图

import { App, Page } from '../app';
import { h, fmtRate } from '../dom';
import { extractSlice, marchingSquares, logColor, SliceAxis, SliceData } from '../../analysis/isolines';
import { discretizeSource } from '../../model/sources';
import { doseContributions } from '../../physics/pointkernel';
import { effectiveBoxes } from '../../model/project';
import { PointSource } from '../../physics/pointkernel';
import { ShieldBox } from '../../physics/geometry';

export function doseviewPage(): Page {
  let cleanup: (() => void) | null = null;
  return {
    title: '剂量场视图',
    mount(el, app: App) {
      let axis: SliceAxis = 'z';
      let pos = 1.0;
      let showIso = true;
      let diffMode = false;
      let cachedSources: PointSource[] | null = null;
      let cachedBoxes: ShieldBox[] | null = null;

      const canvas = h('canvas', { width: 760, height: 560, style: 'width:100%;background:#000;border-radius:8px;cursor:crosshair' }) as HTMLCanvasElement;
      const readout = h('div', { class: 'dim' }, '移动鼠标读取剂量率');
      const contribList = h('div');
      const axisSel = h('select', {},
        h('option', { value: 'z' }, '水平面 (XY)'),
        h('option', { value: 'y' }, '纵剖面 (XZ)'),
        h('option', { value: 'x' }, '横剖面 (YZ)'),
      ) as HTMLSelectElement;
      const posSlider = h('input', { type: 'range', style: 'width:260px' }) as HTMLInputElement;
      const posLabel = h('span', { class: 'badge' }, '');

      el.append(
        h('div', { class: 'panel' },
          h('h2', {}, '剂量场视图'),
          h('div', { class: 'row' },
            '剖切面 ', axisSel, ' 位置 ', posSlider, posLabel,
            h('label', {}, h('input', {
              type: 'checkbox', checked: 'checked',
              onchange: (ev: Event) => { showIso = (ev.target as HTMLInputElement).checked; draw(); },
            }), ' 等剂量线'),
            h('label', {}, h('input', {
              type: 'checkbox',
              onchange: (ev: Event) => { diffMode = (ev.target as HTMLInputElement).checked; draw(); },
            }), ' 差值图(当前-基准)'),
          ),
        ),
        h('div', { class: 'split' },
          h('div', { class: 'panel' }, canvas, readout),
          h('div', { class: 'panel' }, h('h2', {}, '主要贡献源'), contribList),
        ),
      );

      const updateSliderRange = () => {
        const g = app.engine.grid;
        const [lo, hi] = axis === 'z' ? [g.min.z, g.max.z] : axis === 'y' ? [g.min.y, g.max.y] : [g.min.x, g.max.x];
        posSlider.min = String(lo); posSlider.max = String(hi); posSlider.step = '0.1';
        pos = Math.max(lo, Math.min(hi, pos));
        posSlider.value = String(pos);
        posLabel.textContent = `${axis.toUpperCase()} = ${pos.toFixed(1)} m`;
      };
      axisSel.onchange = () => { axis = axisSel.value as SliceAxis; updateSliderRange(); draw(); };
      posSlider.oninput = () => { pos = parseFloat(posSlider.value); posLabel.textContent = `${axis.toUpperCase()} = ${pos.toFixed(1)} m`; draw(); };

      let slice: SliceData | null = null;

      function draw(): void {
        if (!app.engine.grid || app.engine.data.length === 0) return;
        slice = extractSlice(app.engine, axis, pos, 0.2);
        const ctx = canvas.getContext('2d')!;
        const { rows, cols, values } = slice;
        const img = ctx.createImageData(cols, rows);
        const baseline = app.baselineField;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const v = values[r * cols + c];
            let rgb: [number, number, number];
            if (diffMode && baseline) {
              // 差值: 当前 - 基准 (负=剂量下降=绿, 正=红)
              const base = sampleBaseline(app, axis, pos, slice!, r, c);
              const dv = (v - base) * 1e6;
              rgb = dv < 0
                ? [0, Math.min(255, 40 + Math.log10(1 + Math.abs(dv)) * 50), 60]
                : [Math.min(255, 40 + Math.log10(1 + dv) * 50), 30, 30];
            } else {
              rgb = logColor(v * 1e6);
            }
            const o = ((rows - 1 - r) * cols + c) * 4; // 翻转 v 轴
            img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
          }
        }
        // 离屏放大
        const off = document.createElement('canvas');
        off.width = cols; off.height = rows;
        off.getContext('2d')!.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

        if (showIso && !diffMode) {
          ctx.strokeStyle = 'rgba(255,255,255,0.75)';
          ctx.lineWidth = 1;
          for (const level of [1, 10, 100, 1000, 10000]) {
            const segs = marchingSquares(slice!, level / 1e6); // μSv/h -> Sv/h
            ctx.beginPath();
            for (const s of segs) {
              const [x1, y1] = toCanvas(slice!, s.x1, s.y1, canvas);
              const [x2, y2] = toCanvas(slice!, s.x2, s.y2, canvas);
              ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            }
            ctx.stroke();
          }
        }
        // 色标
        drawLegend(ctx, canvas, diffMode);
      }

      function toCanvas(s: SliceData, u: number, v: number, cv: HTMLCanvasElement): [number, number] {
        const u1 = s.u0 + s.du * s.cols, v1 = s.v0 + s.dv * s.rows;
        return [
          ((u - s.u0) / (u1 - s.u0)) * cv.width,
          cv.height - ((v - s.v0) / (v1 - s.v0)) * cv.height,
        ];
      }

      canvas.addEventListener('mousemove', (ev) => {
        if (!slice) return;
        const rect = canvas.getBoundingClientRect();
        const fx = (ev.clientX - rect.left) / rect.width;
        const fy = 1 - (ev.clientY - rect.top) / rect.height;
        const u = slice.u0 + fx * slice.du * slice.cols;
        const v = slice.v0 + fy * slice.dv * slice.rows;
        let p: { x: number; y: number; z: number };
        if (axis === 'z') p = { x: u, y: v, z: pos };
        else if (axis === 'y') p = { x: u, y: pos, z: v };
        else p = { x: pos, y: u, z: v };
        const rate = app.engine.sample(p.x, p.y, p.z) * 1e6;
        readout.textContent = `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})  剂量率 ≈ ${fmtRate(rate)}`;
        // 贡献源 (CPU 精确算, 缓存离散化)
        if (!cachedSources) {
          const workDate = Date.parse(app.project.settings.workDate);
          cachedSources = app.project.sources.flatMap((s) => discretizeSource(s, workDate));
          cachedBoxes = effectiveBoxes(app.project);
        }
        const contrib = doseContributions(cachedSources, p, cachedBoxes!).slice(0, 5);
        const total = contrib.reduce((a, c) => a + c.dose, 0);
        contribList.innerHTML = '';
        contribList.append(...contrib.map((c) =>
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('span', {}, c.label),
            h('span', { class: 'dim' }, `${fmtRate(c.dose * 1e6)} (${total > 0 ? (c.dose / total * 100).toFixed(0) : 0}%)`),
          )));
      });

      updateSliderRange();
      draw();
      cleanup = app.onChange(() => { updateSliderRange(); draw(); });
    },
    unmount() { cleanup?.(); },
  };
}

function sampleBaseline(app: App, axis: SliceAxis, pos: number, slice: SliceData, r: number, c: number): number {
  // 基准场与当前场同网格, 直接用引擎网格参数索引
  const g = app.engine.grid;
  const u = slice.u0 + (c + 0.5) * slice.du;
  const v = slice.v0 + (r + 0.5) * slice.dv;
  let p: { x: number; y: number; z: number };
  if (axis === 'z') p = { x: u, y: v, z: pos };
  else if (axis === 'y') p = { x: u, y: pos, z: v };
  else p = { x: pos, y: u, z: v };
  const ix = Math.round((p.x - g.min.x) / g.step - 0.5);
  const iy = Math.round((p.y - g.min.y) / g.step - 0.5);
  const iz = Math.round((p.z - g.min.z) / g.step - 0.5);
  const { x: nx, y: ny, z: nz } = app.engine.dims;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
  return app.baselineField![iz * nx * ny + iy * nx + ix];
}

function drawLegend(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, diff: boolean): void {
  const x = canvas.width - 60, y0 = 20, hgt = 200, w = 14;
  for (let i = 0; i < hgt; i++) {
    const t = 1 - i / hgt;
    const uSvH = Math.pow(10, -2 + t * 7);
    const [r, g, b] = diff ? [128, 128, 128] : logColor(uSvH);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y0 + i, w, 1);
  }
  ctx.fillStyle = '#fff';
  ctx.font = '10px sans-serif';
  if (!diff) {
    for (const e of [-2, 0, 2, 4]) {
      const t = (e + 2) / 7;
      const y = y0 + (1 - t) * hgt;
      ctx.fillText(`1e${e}`, x + w + 3, y + 3);
    }
    ctx.fillText('μSv/h', x - 4, y0 + hgt + 14);
  } else {
    ctx.fillText('差值', x - 4, y0 + hgt + 14);
  }
}
