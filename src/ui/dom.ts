// 简易 DOM 构造

type Attrs = Record<string, string | number | boolean | ((ev: any) => void)>;

export function h(tag: string, attrs: Attrs = {}, ...children: Array<Node | string | null | undefined>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c as Node | string);
  }
  return el;
}

export function fmt(x: number, digits = 3): string {
  if (!isFinite(x)) return '-';
  if (x !== 0 && (Math.abs(x) < 0.001 || Math.abs(x) >= 10000)) return x.toExponential(2);
  return x.toFixed(digits);
}

/** μSv/h 自动选单位 */
export function fmtRate(uSvH: number): string {
  if (uSvH >= 1000) return `${(uSvH / 1000).toFixed(2)} mSv/h`;
  return `${uSvH.toFixed(2)} μSv/h`;
}
