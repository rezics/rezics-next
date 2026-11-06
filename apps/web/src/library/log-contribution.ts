import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';

export type LiveLogContribution = { kind: 'live'; id: string; displayName: string | null };
export type DeletedLogContribution = {
  kind: 'deleted';
  displayName: 'Deleted account' | 'Deleted organization';
};
export type LogContribution = LiveLogContribution | DeletedLogContribution | { kind: 'unknown' };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Kernel FULL log attribution: live identity, explicit deletion, or unknown. */
export function logContribution(value: unknown): LogContribution {
  const row = record(value);
  if (!row) return { kind: 'unknown' };
  if (
    (row.displayName === 'Deleted account' || row.displayName === 'Deleted organization') &&
    !('id' in row)
  )
    return { kind: 'deleted', displayName: row.displayName };
  if (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    (typeof row.displayName === 'string' || row.displayName === null)
  )
    return { kind: 'live', id: row.id, displayName: row.displayName };
  return { kind: 'unknown' };
}

export function logContributionLabel(contribution: LogContribution, locale: string): string {
  const options = { locale: locale as Locale };
  if (contribution.kind === 'unknown') return m.thread_author_unknown({}, options);
  if (contribution.kind === 'deleted')
    return contribution.displayName === 'Deleted organization'
      ? m.thread_author_deleted_organization({}, options)
      : m.thread_author_deleted({}, options);
  const name = contribution.displayName?.trim();
  return name && name.length > 0 ? name : m.thread_author_unknown({}, options);
}
