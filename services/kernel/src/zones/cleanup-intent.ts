import type { ZoneHead } from './resource-store.ts';

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

export function withPurgeIntent(row: ZoneHead, intent: PurgeIntent | null): Record<string, unknown> {
  const next = record(row.withholding) ? { ...row.withholding } : {};
  if (intent) next[PURGE_INTENT] = intent;
  else delete next[PURGE_INTENT];
  return next;
}

export function liveCoverage(row: ZoneHead): string[] {
  return Object.keys(record(row.withholding) ? row.withholding : {}).filter(
    (key) => key === '' || key.startsWith('/'),
  );
}
