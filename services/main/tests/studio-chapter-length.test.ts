import { expect, test } from 'bun:test';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import { manuscriptLength, readStudioChapterLengths, STUDIO_CHAPTER_COST } from '../src/modules/studio/chapters.ts';

test('STUDIO: a chapter is measured as its writers count it: characters in Chinese and Japanese, words elsewhere', () => {
  expect(manuscriptLength({ body: '雨停在书店打烊前。\n林梅在门口发现一封没有地址的信。' }, 'zh-Hans'))
    .toEqual({ unit: 'characters', value: 25 });
  expect(manuscriptLength({ body: '第一章の本文' }, 'ja')).toEqual({ unit: 'characters', value: 6 });
  expect(manuscriptLength({ body: 'It was a truth, universally acknowledged.' }, 'en'))
    .toEqual({ unit: 'words', value: 6 });
  expect(manuscriptLength({ body: '안녕하세요 세계' }, 'ko')).toEqual({ unit: 'words', value: 2 });
  expect(manuscriptLength({ blocks: [] }, 'en')).toBeNull();
});

const snapshot = (revisionId: string, body: Record<string, unknown>): ExactReadResult => ({
  revisionId, status: 'available', body, serializedJson: JSON.stringify(body),
  reference: { owner: 'content', resourceId: 'chapter', variantId: 'variant', revisionId,
    format: 'rezics-content-json-v1', model: 'text', byteDigest: 'digest', byteLength: 0,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    sourceRevision: null, predecessor: null, provenance: {} },
});

test('Studio hydrates distinct bounded revisions while retaining all 23 repeated placements across pages', async () => {
  const texts = Array.from({ length: 23 }, (_, index) => ({ occurrence: `placement-${index}`,
    revision: 'shared-chapter', language: 'en' }));
  const calls: string[][] = [];
  const content: Pick<ContentCore, 'readExactBatch'> = { async readExactBatch(revisions, authorize) {
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions.length).toBeLessThanOrEqual(STUDIO_CHAPTER_COST.bodyBatch);
    expect(await authorize(revisions)).toEqual(new Set(revisions));
    calls.push(revisions);
    return revisions.map(revision => snapshot(revision, { body: 'Same chapter in several places.' }));
  } };
  const lengths = new Map<string, ReturnType<typeof manuscriptLength>>();
  for (let start = 0; start < texts.length; start += STUDIO_CHAPTER_COST.pageSize) {
    const page = texts.slice(start, start + STUDIO_CHAPTER_COST.pageSize);
    const before = calls.length;
    const result = await readStudioChapterLengths(content, page);
    expect(result.size).toBe(page.length);
    expect(calls.length - before).toBeLessThanOrEqual(STUDIO_CHAPTER_COST.bodyBatches);
    for (const [occurrence, length] of result) lengths.set(occurrence, length);
  }
  expect([...lengths.keys()]).toEqual(texts.map(item => item.occurrence));
  expect([...lengths.values()]).toEqual(Array.from({ length: 23 }, () => ({ unit: 'words', value: 5 })));
  expect(calls).toEqual(Array.from({ length: 6 }, () => ['shared-chapter']));
});

test('Studio matches exact snapshots by revision and preserves placement language and unavailable lengths', async () => {
  const texts = [
    { occurrence: 'english', revision: 'shared', language: 'en' },
    { occurrence: 'chinese', revision: 'shared', language: 'zh-Hans' },
    { occurrence: 'unavailable', revision: 'unavailable', language: 'en' },
    { occurrence: 'nontext', revision: 'nontext', language: 'en' },
  ];
  const calls: string[][] = [];
  const content: Pick<ContentCore, 'readExactBatch'> = { async readExactBatch(revisions) {
    calls.push(revisions);
    // Snapshot identity, rather than its returned index, owns each placement's length.
    return [snapshot('nontext', { blocks: [] }),
      { revisionId: 'unavailable', status: 'unavailable' }, snapshot('shared', { body: 'First chapter' })];
  } };
  const lengths = await readStudioChapterLengths(content, texts);
  expect(calls).toEqual([['shared', 'unavailable', 'nontext']]);
  expect([...lengths]).toEqual([
    ['english', { unit: 'words', value: 2 }],
    ['chinese', { unit: 'characters', value: 12 }],
    ['unavailable', null], ['nontext', null],
  ]);
});
