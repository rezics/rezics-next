import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkedMetadataState, metadataDigest, InvalidWorkMetadata } from '../src/modules/work/metadata-schema.ts';
import { selectedMetadata } from '../src/modules/work/metadata-read.ts';
import { readSerialSummaries } from '../src/modules/work/summary-serial.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const work = `https://rezics.com/id/${randomUUID()}`;
const header = { kind: 'header' as const, originalTitle: null,
  completionStatus: 'ongoing' as const, localized: [
    { language: 'zh-CN', title: null, description: null, mainVersionLabel: null, tagline: '星际旅程' },
    { language: 'en', title: null, description: null, mainVersionLabel: null, tagline: 'A voyage beyond the stars' },
  ] };

test('serial metadata records a short, localized hook separately from description', () => {
  const state = checkedMetadataState(header);
  expect(state.kind).toBe('header');
  if (state.kind !== 'header') return;
  expect(selectedMetadata({ localized: state.localized }, 'zh-CN').tagline).toMatchObject({
    value: '星际旅程', language: 'zh-cn', basis: 'requested' });
  expect(selectedMetadata({ localized: state.localized }, 'fr').tagline).toMatchObject({
    value: 'A voyage beyond the stars', language: 'en', basis: 'fallback' });
  expect(metadataDigest({ work, expectedHead: null, state: header })).not.toBe(metadataDigest({
    work, expectedHead: null, state: { ...header, completionStatus: 'completed' } }));
  for (const invalid of [
    { ...header, localized: [{ ...header.localized[0], tagline: 'x'.repeat(181) }] },
    { ...header, localized: [{ ...header.localized[0], tagline: 'bad\nline' }] },
    { ...header, completionStatus: 'unknown' },
  ]) expect(() => checkedMetadataState(invalid)).toThrow(InvalidWorkMetadata);
});

test('serial list hydration stays within one page and represents unavailable counts as unknown', async () => {
  const query = async (_body: string, _limit: number) => [{ work: { value: work } }];
  const session = { query, options: { language: 'en' } } as unknown as WorkReadSession;
  expect(await readSerialSummaries(session, [work])).toEqual(new Map([[work, {
    tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
  }]]));
  await expect(readSerialSummaries(session, Array(21).fill(work))).rejects.toThrow('out of bounds');
});
