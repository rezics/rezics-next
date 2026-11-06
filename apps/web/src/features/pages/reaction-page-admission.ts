import type { PageRead } from '@rezics/composition';
import { isRecord } from './shared';

/** Public subject totals; upvote/downvote stay on scored posts and never render here. */
export const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;

const admitted = new Set<string>(subjectReactionKinds);
const nativeReactionKinds = new Set<string>([...subjectReactionKinds, 'upvote', 'downvote']);

export type NativeReactionSummaryPage = {
  counts: Partial<Record<(typeof subjectReactionKinds)[number], number>>;
};

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function nativeWatermark(value: unknown): boolean {
  return (
    value === null ||
    (hasExactKeys(value, ['epoch', 'position']) &&
      typeof value.epoch === 'number' &&
      Number.isSafeInteger(value.epoch) &&
      value.epoch >= 1 &&
      typeof value.position === 'string' &&
      /^[1-9][0-9]*$/.test(value.position))
  );
}

/** Public reaction totals from the planned reactions leaf. Viewer slots are not part of this page. */
export function nativeReactionSummaryPage(read: unknown, body: unknown): NativeReactionSummaryPage | undefined {
  if (!isRecord(read) || read.kind !== 'reactions' || !isRecord(body) || !Array.isArray(body.counts)) return;
  if (!nativeWatermark(body.watermark)) return;
  const counts: NativeReactionSummaryPage['counts'] = {};
  const seen = new Set<string>();
  for (const row of body.counts) {
    if (
      !hasExactKeys(row, ['kind', 'count']) ||
      typeof row.kind !== 'string' ||
      !nativeReactionKinds.has(row.kind) ||
      seen.has(row.kind) ||
      typeof row.count !== 'number' ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1
    )
      return;
    seen.add(row.kind);
    if (admitted.has(row.kind)) counts[row.kind as (typeof subjectReactionKinds)[number]] = row.count;
  }
  return { counts };
}

export function plannedReactionRead(
  read: PageRead | undefined,
  subject: string | null,
): read is PageRead & {
  kind: 'reactions';
  id: string;
} {
  return (
    !!read &&
    read.kind === 'reactions' &&
    typeof subject === 'string' &&
    read.id.toLowerCase() === subject.toLowerCase()
  );
}
