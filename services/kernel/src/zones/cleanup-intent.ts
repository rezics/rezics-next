import type { Json } from 'reylo';
import { jsonParameter } from '../database/json.ts';
import type { ZoneHead } from './resource-head.ts';

/** Non-pointer withholding key. Live takedown filters never match it. */
export const PURGE_INTENT = 'purge';
export type PurgeIntent = { branch: 'ordinary' | 'early_privacy' | 'legal_order'; order?: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function purgeIntent(row: ZoneHead): PurgeIntent | null {
  const stored = record(row.withholding) ? row.withholding[PURGE_INTENT] : undefined;
  if (!record(stored)) return null;
  const branch = stored.branch;
  const order = stored.order;
  if (branch !== 'ordinary' && branch !== 'early_privacy' && branch !== 'legal_order') return null;
  return { branch, ...(typeof order === 'string' ? { order } : {}) };
}

export function withPurgeIntent(row: ZoneHead, intent: PurgeIntent | null): Json {
  const next = record(row.withholding) ? { ...row.withholding } : {};
  if (intent) next[PURGE_INTENT] = intent;
  else delete next[PURGE_INTENT];
  return jsonParameter(next);
}

export function liveCoverage(row: ZoneHead): string[] {
  return Object.keys(record(row.withholding) ? row.withholding : {}).filter((key) => key === '' || key.startsWith('/'));
}

/** Live decisions cover a pointer, any ancestor, and any descendant. Named release is the only way coverage shrinks. */
export function pointerIsCovered(row: ZoneHead, pointer: string): boolean {
  return liveCoverage(row).some(
    (live) => pointer === live || pointer.startsWith(`${live}/`) || live.startsWith(`${pointer}/`),
  );
}

/** Early privacy and account cleanup keep covered originals and drop everything else. */
export function retainCoveredPayload(row: ZoneHead): {
  configuration: ZoneHead['configuration'];
  mounts: string[];
} {
  const configuration = row.configuration;
  const mounts = row.mounts ?? [];
  if (!configuration) return { configuration: null, mounts: [] };
  const labels = { ...configuration.labels };
  for (const locale of Object.keys(labels) as (keyof typeof labels)[]) {
    if (!pointerIsCovered(row, `/labels/${locale}`)) delete labels[locale];
  }
  return {
    configuration: {
      ...configuration,
      labels,
      pages: configuration.pages.filter((_, index) => pointerIsCovered(row, `/pages/${index}/document`)),
      scope: configuration.scope.filter((_, index) => pointerIsCovered(row, `/scope/${index}`)),
    },
    mounts: mounts.filter((_, index) => pointerIsCovered(row, `/mounts/${index}`)),
  };
}
