import type { Count } from '../count';
import { isRecord } from './shared';

/** A subject embeds a bounded relation preview, never the whole property. */
export function relationPreviewCount(subject: Record<string, unknown>, property: string): Count | undefined {
  const counts = isRecord(subject.relationCounts) ? subject.relationCounts : undefined;
  const value = counts && Object.hasOwn(counts, property) ? counts[property] : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { value, relation: 'exact' };
  // An omitted aggregate must stay omitted; a preview cannot certify completion.
  return undefined;
}
