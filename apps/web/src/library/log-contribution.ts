import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';

export type LiveLogContribution = { kind: 'live'; id: string; displayName: string | null };
export type DeletedLogContribution = {
  kind: 'deleted';
  displayName: 'Deleted account' | 'Deleted organization';
};
export type LogContribution = LiveLogContribution | DeletedLogContribution | { kind: 'unknown' };

const deletedNames = new Set(['Deleted account', 'Deleted organization']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deletedName(value: unknown): DeletedLogContribution['displayName'] | undefined {
  return typeof value === 'string' && deletedNames.has(value)
    ? (value as DeletedLogContribution['displayName'])
    : undefined;
}

/** Kernel FULL log attribution: live identity, an id-free deletion label, or unknown. */
export function logContribution(value: unknown): LogContribution {
  const row = record(value);
  if (!row) return { kind: 'unknown' };
  const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
  if (id && (typeof row.displayName === 'string' || row.displayName === null))
    return { kind: 'live', id, displayName: row.displayName };
  const deleted = deletedName(row.displayName);
  if (deleted && !('id' in row) && row.kind !== 'actor' && row.kind !== 'organization')
    return { kind: 'deleted', displayName: deleted };
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
