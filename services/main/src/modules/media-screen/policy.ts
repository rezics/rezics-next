/** Classifier scores are private review evidence. This versioned launch policy
 * decides local clearance; it makes no assertion about legality or CSAM. */
export const SCREEN_POLICY = {
  profile: 'image-screen-v1', model: 'MobileNetV2', version: 'nsfwjs-4.4.0/tfjs-4.22.0',
  weightsDigest: '8e7dddbb16acacc1bf1601b1b8a761e730ff934b7f2d7771312b2f000e5f5f13',
  thresholds: { Explicit: 0.5, Porn: 0.5, Hentai: 0.5, Sexy: 0.8 },
} as const;
export const SCREEN_LIMITS = { bytes: 8 * 1024 * 1024, pixels: 16 * 1024 * 1024,
  dimension: 16_384, inputSize: 224, timeoutMs: 30_000, leaseMs: 60_000, reviewBatch: 8 } as const;
export type Scores = Record<'Drawing' | 'Hentai' | 'Neutral' | 'Porn' | 'Sexy', number>;
export interface ScreenVerdict {
  clearance: 'cleared' | 'held'; reason: 'likely-explicit' | 'screen-unavailable' | null;
  evidence: { model: string; version: string; weightsDigest: string;
    thresholds: typeof SCREEN_POLICY.thresholds; scores?: Scores; unavailable?: true };
}
export function screenVerdict(scores: Scores): ScreenVerdict {
  const values = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'].map(key => scores[key as keyof Scores]);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.01) throw new Error('invalid classifier output');
  // Uncertainty between the two explicit categories must not become clearance.
  const held = scores.Porn + scores.Hentai >= SCREEN_POLICY.thresholds.Explicit
    || (['Porn', 'Hentai', 'Sexy'] as const).some(key => scores[key] >= SCREEN_POLICY.thresholds[key]);
  return { clearance: held ? 'held' : 'cleared', reason: held ? 'likely-explicit' : null,
    evidence: { ...SCREEN_POLICY, scores } };
}
export function screenUnavailable(): ScreenVerdict {
  return { clearance: 'held', reason: 'screen-unavailable', evidence: { ...SCREEN_POLICY, unavailable: true } };
}
