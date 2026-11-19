// 同位素数据:伽马谱线、半衰期、衰变修正
// 数据来源: 标准核数据表 (Co-60 / Co-58 / Cs-137 主伽马线)

export interface GammaLine {
  /** 能量 MeV */
  energy: number;
  /** 每次衰变发射概率 */
  yield: number;
}

export interface Isotope {
  id: string;
  name: string;
  /** 半衰期,天 */
  halfLifeDays: number;
  lines: GammaLine[];
}

export const ISOTOPES: Record<string, Isotope> = {
  Co60: {
    id: 'Co60',
    name: 'Co-60',
    halfLifeDays: 5.2714 * 365.25,
    lines: [
      { energy: 1.1732, yield: 0.9985 },
      { energy: 1.3325, yield: 0.9998 },
    ],
  },
  Co58: {
    id: 'Co58',
    name: 'Co-58',
    halfLifeDays: 70.86,
    lines: [
      { energy: 0.8108, yield: 0.9945 },
      { energy: 0.8639, yield: 0.0068 },
      { energy: 1.6747, yield: 0.00517 },
    ],
  },
  Cs137: {
    id: 'Cs137',
    name: 'Cs-137',
    halfLifeDays: 30.08 * 365.25,
    // Ba-137m 0.6617 MeV
    lines: [{ energy: 0.6617, yield: 0.8499 }],
  },
};

export const ISOTOPE_LIST = Object.values(ISOTOPES);

/**
 * 衰变修正: A(t) = A0 * 2^(-(t-t0)/T)
 * @param activityAtRef 参考日活度 Bq
 * @param refDate 参考日期 (ms epoch)
 * @param workDate 作业日期 (ms epoch)
 */
export function decayedActivity(
  isotopeId: string,
  activityAtRef: number,
  refDate: number,
  workDate: number,
): number {
  const iso = ISOTOPES[isotopeId];
  if (!iso) throw new Error(`未知同位素: ${isotopeId}`);
  const dtDays = (workDate - refDate) / 86400000;
  return activityAtRef * Math.pow(2, -dtDays / iso.halfLifeDays);
}

/** 所有同位素谱线拉平后的全局谱线表 (GPU/CPU 共用同一顺序) */
export interface FlatLine {
  isotopeId: string;
  lineIndex: number;
  energy: number;
  yield: number;
}

export const FLAT_LINES: FlatLine[] = ISOTOPE_LIST.flatMap((iso) =>
  iso.lines.map((l, i) => ({ isotopeId: iso.id, lineIndex: i, energy: l.energy, yield: l.yield })),
);

export const NUM_LINES = FLAT_LINES.length;

/** 同位素 id -> 该同位素在全局谱线表中的 [start, count) */
export const ISOTOPE_LINE_RANGE: Record<string, { start: number; count: number }> = (() => {
  const map: Record<string, { start: number; count: number }> = {};
  let start = 0;
  for (const iso of ISOTOPE_LIST) {
    map[iso.id] = { start, count: iso.lines.length };
    start += iso.lines.length;
  }
  return map;
})();
