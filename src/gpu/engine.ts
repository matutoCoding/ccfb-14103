// 剂量场计算引擎: WebGPU 优先, CPU 兜底。
// 特性: 分帧计算(每帧预算毫秒数)、渐进细化(步长 4→2→1)、ROI 局部重算。
// 体素结果回读后在 CPU 侧按块溅射, 粗结果立即全场可见, 细结果逐步覆盖。

import { Vec3, AABB, aabbContains } from '../physics/geometry';
import { PointSource } from '../physics/pointkernel';
import { ShieldBox } from '../physics/geometry';
import { TABLES, NUM_MATERIALS, MATERIAL_INDEX } from '../physics/materials';
import { FLAT_LINES, NUM_LINES, ISOTOPE_LINE_RANGE } from '../physics/isotopes';
import { DOSE_SHADER } from './shaders';

const YIELDS = FLAT_LINES.map((l) => l.yield);
const FOUR_PI = 12.566370614359172;

export interface GridSpec { min: Vec3; max: Vec3; step: number }

interface Task { stride: number; start: number; count: number; roi: AABB | null }

const LEVEL_STRIDES = [4, 2, 1];
const GPU_CHUNK = 1 << 16; // 每 chunk 体素数 (GPU)
const CPU_CHUNK = 2048;    // CPU 兜底用小 chunk, 保证分帧让出主线程

export class DoseFieldEngine {
  grid!: GridSpec;
  dims = { x: 0, y: 0, z: 0 };
  /** 主网格剂量率 Sv/h */
  data = new Float32Array(0);
  /** 每体素已写入的细化级别 (stride), 255=未写 */
  private levelArr = new Uint8Array(0);
  version = 0;
  /** 进度 0..1 */
  get progress(): number {
    if (this.totalVoxels === 0) return 1;
    return this.doneVoxels / this.totalVoxels;
  }
  private totalVoxels = 0;
  private doneVoxels = 0;

  private sources: PointSource[] = [];
  private boxes: ShieldBox[] = [];
  private queue: Task[] = [];
  // CPU 内核用的打包数组: 源 [x,y,z,activity,lineStart,lineCount]×N, 盒 [minx..maxz,matIdx,scale]×N
  private packedSrc = new Float64Array(0);
  private packedBox = new Float64Array(0);
  private lenScratch = new Float64Array(NUM_MATERIALS);

  // GPU 资源
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private bufSources: GPUBuffer | null = null;
  private bufBoxes: GPUBuffer | null = null;
  private bufTables: GPUBuffer[] = [];
  private bufParams: GPUBuffer | null = null;
  private bufOut: GPUBuffer | null = null;
  private bufRead: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  gpuAvailable = false;

  async init(): Promise<void> {
    try {
      if (!navigator.gpu) return;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) { console.warn('[dose-engine] 无 WebGPU adapter, 使用 CPU 兜底'); return; }
      this.device = await adapter.requestDevice();
      this.device.addEventListener('uncapturederror', (ev) => {
        console.warn('[dose-engine] WebGPU 错误:', (ev as GPUUncapturedErrorEvent).error.message);
      });
      this.device.pushErrorScope('validation');
      const mod = this.device.createShaderModule({ code: DOSE_SHADER });
      this.pipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: mod, entryPoint: 'main' },
      });
      const err = await this.device.popErrorScope();
      if (err) {
        console.warn('[dose-engine] 着色器编译失败, 使用 CPU 兜底:', err.message);
        this.device = null;
        this.pipeline = null;
        return;
      }
      this.bufParams = this.device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bufOut = this.device.createBuffer({ size: GPU_CHUNK * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.bufRead = this.device.createBuffer({ size: GPU_CHUNK * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      // 物理常数表
      const mk = (arr: ArrayLike<number>) => {
        const b = this.device!.createBuffer({ size: Math.max(4, arr.length * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.device!.queue.writeBuffer(b, 0, new Float32Array(arr));
        return b;
      };
      this.bufTables = [
        mk(TABLES.mu), mk(TABLES.bergerA), mk(TABLES.bergerB), mk(TABLES.doseConv),
        mk(FLAT_LINES.map((l) => l.yield)),
      ];
      this.gpuAvailable = true;
    } catch (e) {
      console.warn('[dose-engine] WebGPU 初始化失败, 使用 CPU 兜底:', e);
      this.device = null;
      this.gpuAvailable = false;
    }
  }

  configureGrid(spec: GridSpec): void {
    this.grid = spec;
    this.dims = {
      x: Math.max(1, Math.round((spec.max.x - spec.min.x) / spec.step)),
      y: Math.max(1, Math.round((spec.max.y - spec.min.y) / spec.step)),
      z: Math.max(1, Math.round((spec.max.z - spec.min.z) / spec.step)),
    };
    const n = this.dims.x * this.dims.y * this.dims.z;
    this.data = new Float32Array(n);
    this.levelArr = new Uint8Array(n).fill(255);
    this.queue = [];
    this.totalVoxels = 0;
    this.doneVoxels = 0;
  }

  setScene(sources: PointSource[], boxes: ShieldBox[]): void {
    this.sources = sources;
    this.boxes = boxes;
    // 打包 (CPU 内核与 GPU 共用同一份场景)
    const ps = new Float64Array(sources.length * 6);
    sources.forEach((s, i) => {
      const r = ISOTOPE_LINE_RANGE[s.isotopeId];
      ps.set([s.pos.x, s.pos.y, s.pos.z, s.activity, r.start, r.count], i * 6);
    });
    this.packedSrc = ps;
    const defaultDensity: Record<string, number> = { concrete: 2.3, steel: 7.85, lead: 11.34, water: 1.0, air: 0.001205 };
    const pb = new Float64Array(boxes.length * 8);
    boxes.forEach((b, i) => {
      const scale = b.densityOverride !== undefined ? b.densityOverride / defaultDensity[b.material] : 1;
      pb.set([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, MATERIAL_INDEX[b.material], scale], i * 8);
    });
    this.packedBox = pb;
    if (!this.gpuAvailable || !this.device) return;
    // 打包源: pos(3f) activity(1f) lineStart(1u) lineCount(1u) pad(1f) = 32B
    const sData = new ArrayBuffer(Math.max(1, sources.length) * 32);
    const sv = new DataView(sData);
    sources.forEach((s, i) => {
      const o = i * 32;
      sv.setFloat32(o + 0, s.pos.x, true); sv.setFloat32(o + 4, s.pos.y, true); sv.setFloat32(o + 8, s.pos.z, true);
      sv.setFloat32(o + 12, s.activity, true);
      const range = ISOTOPE_LINE_RANGE[s.isotopeId];
      sv.setUint32(o + 16, range.start, true); sv.setUint32(o + 20, range.count, true);
    });
    this.bufSources?.destroy();
    this.bufSources = this.device.createBuffer({ size: sData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.bufSources, 0, sData);

    // 打包盒: bmin(3f) bmax(3f) matIdx(1u) scale(1f) pad(2f) = 48B
    const bData = new ArrayBuffer(Math.max(1, boxes.length) * 48);
    const bv = new DataView(bData);
    boxes.forEach((b, i) => {
      const o = i * 48;
      bv.setFloat32(o + 0, b.min.x, true); bv.setFloat32(o + 4, b.min.y, true); bv.setFloat32(o + 8, b.min.z, true);
      bv.setFloat32(o + 12, b.max.x, true); bv.setFloat32(o + 16, b.max.y, true); bv.setFloat32(o + 20, b.max.z, true);
      bv.setUint32(o + 24, MATERIAL_INDEX[b.material], true);
      bv.setFloat32(o + 28, b.densityOverride !== undefined ? b.densityOverride / defaultDensity[b.material] : 1, true);
    });
    this.bufBoxes?.destroy();
    this.bufBoxes = this.device.createBuffer({ size: bData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.bufBoxes, 0, bData);
    this.bindGroup = null;
  }

  /** 触发重算; roi 为空则全场重算 */
  invalidate(roi: AABB | null = null): void {
    // 重置受影响体素的细化级别, 否则已细化到 stride=1 的体素不会被粗级覆盖
    if (roi === null) {
      this.levelArr.fill(255);
    } else {
      const g = this.grid;
      const { x: nx, y: ny, z: nz } = this.dims;
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const p = {
              x: g.min.x + (ix + 0.5) * g.step,
              y: g.min.y + (iy + 0.5) * g.step,
              z: g.min.z + (iz + 0.5) * g.step,
            };
            if (aabbContains(roi, p)) this.levelArr[iz * nx * ny + iy * nx + ix] = 255;
          }
        }
      }
    }
    this.queue = [];
    this.totalVoxels = 0;
    this.doneVoxels = 0;
    for (const stride of LEVEL_STRIDES) {
      const nxL = Math.ceil(this.dims.x / stride);
      const nyL = Math.ceil(this.dims.y / stride);
      const nzL = Math.ceil(this.dims.z / stride);
      const total = nxL * nyL * nzL;
      this.totalVoxels += total;
      const chunk = this.gpuAvailable ? GPU_CHUNK : CPU_CHUNK;
      for (let start = 0; start < total; start += chunk) {
        this.queue.push({ stride, start, count: Math.min(chunk, total - start), roi });
      }
    }
  }

  get busy(): boolean { return this.queue.length > 0; }

  /** 每帧调用; 返回是否还有剩余工作 */
  async pumpFrame(budgetMs = 12): Promise<boolean> {
    const t0 = performance.now();
    while (this.queue.length > 0 && performance.now() - t0 < budgetMs) {
      const task = this.queue.shift()!;
      if (this.gpuAvailable) await this.runTaskGPU(task);
      else this.runTaskCPU(task);
      this.doneVoxels += task.count;
      this.version++;
    }
    return this.queue.length > 0;
  }

  /** 等待全部计算完成 (测试/导出走这里) */
  async runAll(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (this.gpuAvailable) await this.runTaskGPU(task);
      else this.runTaskCPU(task);
      this.doneVoxels += task.count;
      this.version++;
    }
  }

  private voxelPos(stride: number, li: number): { x: number; y: number; z: number; ix: number; iy: number; iz: number } {
    const nxL = Math.ceil(this.dims.x / stride);
    const nyL = Math.ceil(this.dims.y / stride);
    const iz = Math.floor(li / (nxL * nyL));
    const rem = li % (nxL * nyL);
    const iy = Math.floor(rem / nxL);
    const ix = rem % nxL;
    return {
      ix: ix * stride, iy: iy * stride, iz: iz * stride,
      x: this.grid.min.x + (ix * stride + 0.5) * this.grid.step,
      y: this.grid.min.y + (iy * stride + 0.5) * this.grid.step,
      z: this.grid.min.z + (iz * stride + 0.5) * this.grid.step,
    };
  }

  private runTaskCPU(task: Task): void {
    const out = new Float32Array(task.count);
    for (let i = 0; i < task.count; i++) {
      const v = this.voxelPos(task.stride, task.start + i);
      if (task.roi && !aabbContains(task.roi, { x: v.x, y: v.y, z: v.z })) { out[i] = -1; continue; }
      out[i] = this.doseAt(v.x, v.y, v.z);
    }
    this.splat(task, out);
  }

  /** CPU 快速内核: 与 pointSourceDoseRate 同一公式, 基于打包数组 (公式见 pointkernel.ts 头注) */
  private doseAt(px: number, py: number, pz: number): number {
    const ps = this.packedSrc, pb = this.packedBox;
    const mu = TABLES.mu, bA = TABLES.bergerA, bB = TABLES.bergerB, conv = TABLES.doseConv;
    const NL = NUM_LINES, NM = NUM_MATERIALS;
    const lenCm = this.lenScratch;
    let dose = 0;
    for (let si = 0; si < ps.length; si += 6) {
      const sx = ps[si], sy = ps[si + 1], sz = ps[si + 2];
      const dx = px - sx, dy = py - sy, dz = pz - sz;
      const rM = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (rM < 1e-4) continue;
      const rCm = rM * 100;
      lenCm.fill(0);
      for (let bi = 0; bi < pb.length; bi += 8) {
        // slab 法 (三轴内联)
        let tmin = 0, tmax = 1, ok = true;
        // x
        if (Math.abs(dx) < 1e-12) { if (sx < pb[bi] || sx > pb[bi + 3]) ok = false; }
        else {
          let t1 = (pb[bi] - sx) / dx, t2 = (pb[bi + 3] - sx) / dx;
          if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
        }
        // y
        if (ok) {
          if (Math.abs(dy) < 1e-12) { if (sy < pb[bi + 1] || sy > pb[bi + 4]) ok = false; }
          else {
            let t1 = (pb[bi + 1] - sy) / dy, t2 = (pb[bi + 4] - sy) / dy;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tmin) tmin = t1;
            if (t2 < tmax) tmax = t2;
          }
        }
        // z
        if (ok) {
          if (Math.abs(dz) < 1e-12) { if (sz < pb[bi + 2] || sz > pb[bi + 5]) ok = false; }
          else {
            let t1 = (pb[bi + 2] - sz) / dz, t2 = (pb[bi + 5] - sz) / dz;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tmin) tmin = t1;
            if (t2 < tmax) tmax = t2;
          }
        }
        if (ok && tmin <= tmax) {
          lenCm[pb[bi + 6] | 0] += (tmax - tmin) * rM * 100 * pb[bi + 7];
        }
      }
      const geom = ps[si + 3] / (FOUR_PI * rCm * rCm);
      const lineStart = ps[si + 4] | 0, lineCount = ps[si + 5] | 0;
      for (let k = 0; k < lineCount; k++) {
        const li = lineStart + k;
        let mut = 0, domMut = 0, domMat = -1;
        for (let m = 0; m < NM; m++) {
          const x = lenCm[m];
          if (x > 0) {
            const mm = mu[m * NL + li] * x;
            mut += mm;
            if (mm > domMut) { domMut = mm; domMat = m; }
          }
        }
        let buildup = 1;
        if (domMat >= 0 && mut > 0) {
          const a = bA[domMat * NL + li], b = bB[domMat * NL + li];
          buildup = 1 + a * mut * Math.exp(b * mut);
        }
        dose += geom * YIELDS[li] * buildup * Math.exp(-mut) * conv[li];
      }
    }
    return dose;
  }

  private async runTaskGPU(task: Task): Promise<void> {
    const dev = this.device!;
    if (!this.bindGroup) {
      this.bindGroup = dev.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bufParams! } },
          { binding: 1, resource: { buffer: this.bufSources! } },
          { binding: 2, resource: { buffer: this.bufBoxes! } },
          { binding: 3, resource: { buffer: this.bufTables[0] } },
          { binding: 4, resource: { buffer: this.bufTables[1] } },
          { binding: 5, resource: { buffer: this.bufTables[2] } },
          { binding: 6, resource: { buffer: this.bufTables[3] } },
          { binding: 7, resource: { buffer: this.bufTables[4] } },
          { binding: 8, resource: { buffer: this.bufOut! } },
        ],
      });
    }
    const p = new ArrayBuffer(96);
    const pv = new DataView(p);
    pv.setFloat32(0, this.grid.min.x, true); pv.setFloat32(4, this.grid.min.y, true); pv.setFloat32(8, this.grid.min.z, true);
    pv.setFloat32(12, this.grid.step, true);
    pv.setUint32(16, this.dims.x, true); pv.setUint32(20, this.dims.y, true); pv.setUint32(24, this.dims.z, true);
    pv.setUint32(28, task.stride, true);
    pv.setUint32(32, this.sources.length, true);
    pv.setUint32(36, this.boxes.length, true);
    pv.setUint32(40, task.start, true);
    const roi = task.roi;
    pv.setFloat32(48, roi?.min.x ?? 0, true); pv.setFloat32(52, roi?.min.y ?? 0, true); pv.setFloat32(56, roi?.min.z ?? 0, true);
    pv.setFloat32(64, roi?.max.x ?? 0, true); pv.setFloat32(68, roi?.max.y ?? 0, true); pv.setFloat32(72, roi?.max.z ?? 0, true);
    pv.setUint32(76, roi ? 1 : 0, true);
    dev.queue.writeBuffer(this.bufParams!, 0, p);

    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(task.count / 64));
    pass.end();
    enc.copyBufferToBuffer(this.bufOut!, 0, this.bufRead!, 0, task.count * 4);
    dev.queue.submit([enc.finish()]);
    await this.bufRead!.mapAsync(GPUMapMode.READ, 0, task.count * 4);
    const out = new Float32Array(this.bufRead!.getMappedRange(0, task.count * 4)).slice();
    this.bufRead!.unmap();
    this.splat(task, out);
  }

  /** 把 chunk 结果写回主网格: 计算体素按 stride 块溅射, 只覆盖更粗或未写的体素; ROI 任务裁剪到 ROI 内 */
  private splat(task: Task, out: Float32Array): void {
    const { x: nx, y: ny, z: nz } = this.dims;
    const s = task.stride;
    const g = this.grid;
    for (let i = 0; i < task.count; i++) {
      const val = out[i];
      if (val < 0) continue; // ROI 外
      const v = this.voxelPos(s, task.start + i);
      let x1 = Math.min(nx, v.ix + s), y1 = Math.min(ny, v.iy + s), z1 = Math.min(nz, v.iz + s);
      let x0 = v.ix, y0 = v.iy, z0 = v.iz;
      if (task.roi) {
        // 逐轴裁剪到 ROI
        const rx0 = Math.max(x0, Math.floor((task.roi.min.x - g.min.x) / g.step));
        const ry0 = Math.max(y0, Math.floor((task.roi.min.y - g.min.y) / g.step));
        const rz0 = Math.max(z0, Math.floor((task.roi.min.z - g.min.z) / g.step));
        const rx1 = Math.min(x1, Math.ceil((task.roi.max.x - g.min.x) / g.step));
        const ry1 = Math.min(y1, Math.ceil((task.roi.max.y - g.min.y) / g.step));
        const rz1 = Math.min(z1, Math.ceil((task.roi.max.z - g.min.z) / g.step));
        x0 = rx0; y0 = ry0; z0 = rz0; x1 = rx1; y1 = ry1; z1 = rz1;
      }
      for (let iz = z0; iz < z1; iz++) {
        for (let iy = y0; iy < y1; iy++) {
          for (let ix = x0; ix < x1; ix++) {
            const gi = iz * nx * ny + iy * nx + ix;
            if (this.levelArr[gi] <= s && this.levelArr[gi] !== 255) continue;
            this.data[gi] = val;
            this.levelArr[gi] = s;
          }
        }
      }
    }
  }

  /** 三线性插值采样 Sv/h */
  sample(x: number, y: number, z: number): number {
    const g = this.grid;
    const fx = (x - g.min.x) / g.step - 0.5;
    const fy = (y - g.min.y) / g.step - 0.5;
    const fz = (z - g.min.z) / g.step - 0.5;
    const { x: nx, y: ny, z: nz } = this.dims;
    const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(ny - 1, Math.floor(fy)));
    const z0 = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
    const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0)), tz = Math.max(0, Math.min(1, fz - z0));
    const at = (ix: number, iy: number, iz: number) => this.data[iz * nx * ny + iy * nx + ix];
    const c00 = at(x0, y0, z0) * (1 - tx) + at(x1, y0, z0) * tx;
    const c10 = at(x0, y1, z0) * (1 - tx) + at(x1, y1, z0) * tx;
    const c01 = at(x0, y0, z1) * (1 - tx) + at(x1, y0, z1) * tx;
    const c11 = at(x0, y1, z1) * (1 - tx) + at(x1, y1, z1) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  }
}
