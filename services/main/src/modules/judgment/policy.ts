import type { ConceptHint } from './schema.ts';

/** A new z value requires a new policy generation; historic votes are unchanged. */
export const JUDGMENT_POLICY = { generation: 'wilson-v1', z: 1.96,
  defaultConceptHint: 'unknown' as ConceptHint } as const;

export interface JudgmentCounts {
  fitNegative: number; fitPositive: number;
  spoilerNone: number; spoilerMinor: number; spoilerMajor: number;
}

export function wilson(successes: number, size: number, z = JUDGMENT_POLICY.z):
  { lower: number; upper: number } | null {
  if (size === 0) return null;
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(size)
    || successes < 0 || successes > size || size < 0 || z <= 0) throw new Error('invalid Wilson input');
  const p = successes / size;
  const z2 = z * z;
  const d = 1 + z2 / size;
  const center = (p + z2 / (2 * size)) / d;
  const radius = z * Math.sqrt(p * (1 - p) / size + z2 / (4 * size * size)) / d;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

/** Independent fit and spoiler populations; null dimensions never cast votes. */
export function summarizeJudgments(counts: JudgmentCounts,
  hint: ConceptHint = JUDGMENT_POLICY.defaultConceptHint) {
  const values = Object.values(counts);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid judgment counts');
  const fitSize = counts.fitNegative + counts.fitPositive;
  const spoilerSize = counts.spoilerNone + counts.spoilerMinor + counts.spoilerMajor;
  const major = wilson(counts.spoilerMajor, spoilerSize);
  const any = wilson(counts.spoilerMinor + counts.spoilerMajor, spoilerSize);
  const none = wilson(counts.spoilerNone, spoilerSize);
  const positive = wilson(counts.fitPositive, fitSize);
  const negative = wilson(counts.fitNegative, fitSize);
  const protection: 'hide-major' | 'hide-any' | 'show-all' = spoilerSize === 0
    ? (hint === 'major' ? 'hide-major' : hint === 'not-spoiler' ? 'show-all' : 'hide-any')
    : major!.upper > 0.5 ? 'hide-major' : any!.upper > 0.5 ? 'hide-any' : 'show-all';
  const singleLevel = spoilerSize > 0 && [counts.spoilerNone, counts.spoilerMinor,
    counts.spoilerMajor].filter(value => value > 0).length === 1;
  const spoilerStatus: 'unknown' | 'major' | 'minor' | 'not-spoiler' | 'disputed' = spoilerSize === 0 ? 'unknown'
    : major!.lower > 0.5 ? 'major'
      : any!.lower > 0.5 ? 'minor'
        : none!.lower > 0.5 ? 'not-spoiler'
          : singleLevel ? counts.spoilerMajor ? 'major'
            : counts.spoilerMinor ? 'minor' : 'not-spoiler' : 'disputed';
  const fitStatus = fitSize === 0 ? 'unknown' : positive!.lower > 0.5 ? 'fits'
    : negative!.lower > 0.5 ? 'does-not-fit'
      : counts.fitNegative === 0 ? 'fits'
        : counts.fitPositive === 0 ? 'does-not-fit' : 'disputed';
  return {
    policy: JUDGMENT_POLICY, conceptHint: hint,
    fit: { status: fitStatus, distribution: { negative: counts.fitNegative,
      positive: counts.fitPositive }, sampleSize: fitSize,
    confidence: fitSize > 0 && (fitStatus === 'fits' ? positive!.lower > 0.5
      : fitStatus === 'does-not-fit' && negative!.lower > 0.5) ? 'high' : 'low',
    bounds: { positive, negative } },
    spoiler: { protection, status: spoilerStatus,
      distribution: { notSpoiler: counts.spoilerNone, minorSpoiler: counts.spoilerMinor,
        majorSpoiler: counts.spoilerMajor }, sampleSize: spoilerSize,
      confidence: spoilerSize > 0 && (spoilerStatus === 'major' ? major!.lower > 0.5
        : spoilerStatus === 'minor' ? any!.lower > 0.5
          : spoilerStatus === 'not-spoiler' && none!.lower > 0.5) ? 'high' : 'low',
      bounds: { major, any, none } },
  };
}
