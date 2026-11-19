// WGSL 计算着色器 —— 与 src/physics/pointkernel.ts 同一公式、同一份系数表。
// 每个线程算一个体素: 对所有点源循环, 射线穿行屏蔽盒累加各材料 μt,
// 取主导材料的 Berger 累积因子, 谱线求和得剂量率 (Sv/h)。

export const DOSE_SHADER = /* wgsl */ `
const NL: u32 = ${6}u;   // 谱线条数 (FLAT_LINES)
const NM: u32 = ${5}u;   // 材料种数

struct Source {
  pos: vec3f,
  activity: f32,
  lineStart: u32,
  lineCount: u32,
  pad: f32,
}

struct SBox {
  bmin: vec3f,
  bmax: vec3f,
  matIdx: u32,
  scale: f32,
  pad: vec2f,
}

struct Params {
  gridMin: vec3f,
  step: f32,
  dims: vec3u,        // 最细网格维度
  stride: u32,        // 本级步长 (4/2/1)
  numSources: u32,
  numBoxes: u32,
  chunkStart: u32,    // 本 chunk 起始体素序号 (本级坐标系)
  roiMin: vec3f,
  roiMax: vec3f,
  useRoi: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> sources: array<Source>;
@group(0) @binding(2) var<storage, read> boxes: array<SBox>;
@group(0) @binding(3) var<storage, read> muTab: array<f32>;      // NM*NL
@group(0) @binding(4) var<storage, read> bA: array<f32>;         // NM*NL
@group(0) @binding(5) var<storage, read> bB: array<f32>;         // NM*NL
@group(0) @binding(6) var<storage, read> conv: array<f32>;       // NL
@group(0) @binding(7) var<storage, read> yld: array<f32>;        // NL
@group(0) @binding(8) var<storage, read_write> outBuf: array<f32>; // chunk 局部, 按本级序号

fn segBoxLen(s: vec3f, e: vec3f, bmin: vec3f, bmax: vec3f) -> f32 {
  let d = e - s;
  var tmin = 0.0;
  var tmax = 1.0;
  for (var ax = 0u; ax < 3u; ax++) {
    let o = s[ax]; let dd = d[ax];
    let lo = bmin[ax]; let hi = bmax[ax];
    if (abs(dd) < 1e-9) {
      if (o < lo || o > hi) { return 0.0; }
    } else {
      var t1 = (lo - o) / dd;
      var t2 = (hi - o) / dd;
      if (t1 > t2) { let t = t1; t1 = t2; t2 = t; }
      tmin = max(tmin, t1);
      tmax = min(tmax, t2);
      if (tmin > tmax) { return 0.0; }
    }
  }
  return (tmax - tmin) * length(d);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let stride = params.stride;
  let nxL = (params.dims.x + stride - 1u) / stride;
  let nyL = (params.dims.y + stride - 1u) / stride;
  let nzL = (params.dims.z + stride - 1u) / stride;
  let total = nxL * nyL * nzL;
  let li_ = params.chunkStart + idx;
  if (li_ >= total) { outBuf[idx] = -1.0; return; }

  // 本级序号 -> 体素坐标
  let iz = li_ / (nxL * nyL);
  let rem = li_ % (nxL * nyL);
  let iy = rem / nxL;
  let ix = rem % nxL;

  let p = params.gridMin + (vec3f(f32(ix * stride), f32(iy * stride), f32(iz * stride)) + vec3f(0.5)) * params.step;

  if (params.useRoi == 1u) {
    if (any(p < params.roiMin) || any(p > params.roiMax)) {
      outBuf[idx] = -1.0; // 标记: 不在 ROI, CPU 侧跳过
      return;
    }
  }

  var dose = 0.0;
  for (var si = 0u; si < params.numSources; si++) {
    let src = sources[si];
    let dv = p - src.pos;
    let rM = length(dv);
    if (rM < 1e-4) { continue; }
    let rCm = rM * 100.0;

    var lenCm: array<f32, NM>;
    for (var m = 0u; m < NM; m++) { lenCm[m] = 0.0; }
    for (var bi = 0u; bi < params.numBoxes; bi++) {
      let b = boxes[bi];
      let L = segBoxLen(src.pos, p, b.bmin, b.bmax);
      if (L > 0.0) {
        lenCm[b.matIdx] += L * 100.0 * b.scale;
      }
    }

    let geom = src.activity / (12.566370614359172 * rCm * rCm);
    for (var k = 0u; k < src.lineCount; k++) {
      let li = src.lineStart + k;
      var mut = 0.0;
      var domMut = 0.0;
      var domMat = 0u;
      var hasShield = false;
      for (var m = 0u; m < NM; m++) {
        let x = lenCm[m];
        if (x > 0.0) {
          let mm = muTab[m * NL + li] * x;
          mut += mm;
          if (mm > domMut) { domMut = mm; domMat = m; hasShield = true; }
        }
      }
      var buildup = 1.0;
      if (hasShield && mut > 0.0) {
        let a = bA[domMat * NL + li];
        let bb = bB[domMat * NL + li];
        buildup = 1.0 + a * mut * exp(bb * mut);
      }
      let phi = geom * yld[li] * buildup * exp(-mut);
      dose += phi * conv[li];
    }
  }
  outBuf[idx] = dose;
}
`;
