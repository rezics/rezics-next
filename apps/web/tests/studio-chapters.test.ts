import { describe, expect, test } from 'bun:test';
import { chapterVariant, createChapter, moveChapter, publishChapter, settled } from '../features/studio/content-api.ts';
import { lengthUnit, manuscriptLength } from '../features/studio/counts.ts';
import { detailsInvalid, detailsValues } from '../features/studio/details-api.ts';
import { ids, storyMain } from '../features/studio/fixtures.ts';
import { chapterMemoryKey, type DraftStorage, readChapterMemory, rememberChapter } from '../features/studio/local-draft.ts';
import { workKind, type WorkMetadata } from '../features/studio/types.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

describe('Studio chapter variants', () => {
  test('every device derives the same variant for a chapter and language, and a different one per language', async () => {
    const chapter = ids.chapters[0]!;
    const first = await chapterVariant(chapter, 'zh-Hans');
    expect(first).toMatch(/^urn:rezics:variant:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Main reads lower-case some language tags; the variant must not depend on their case.
    expect(await chapterVariant(chapter, 'zh-hans')).toBe(first);
    expect(await chapterVariant(chapter, 'en')).not.toBe(first);
    expect(await chapterVariant(ids.chapters[1]!, 'zh-Hans')).not.toBe(first);
  });
});

describe('Studio manuscript length', () => {
  test('Chinese and Japanese count characters; space-separated scripts count words', () => {
    expect(manuscriptLength('雨停在书店打烊前。\n林梅在门口发现一封没有地址的信。', 'zh-Hans'))
      .toEqual({ unit: 'characters', value: 25 });
    expect(manuscriptLength('雨の夜、 本屋。', 'ja')).toEqual({ unit: 'characters', value: 7 });
    expect(manuscriptLength('It was a truth, universally acknowledged.', 'en')).toEqual({ unit: 'words', value: 6 });
    expect(manuscriptLength('안녕하세요 세계', 'ko')).toEqual({ unit: 'words', value: 2 });
    expect(lengthUnit('zh-Hant')).toBe('characters');
    expect(lengthUnit('fr')).toBe('words');
  });
});

describe('Studio chapter memory', () => {
  const storage = (): DraftStorage => {
    const values = new Map<string, string>();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); } };
  };

  test('what a device learns is merged, kept per Agent and variant, and malformed memory is ignored', () => {
    const store = storage();
    const key = chapterMemoryKey(agent, 'urn:rezics:variant:00000000-0000-4000-8000-000000000300');
    expect(key).not.toBe(chapterMemoryKey(ids.chapters[0]!, 'urn:rezics:variant:00000000-0000-4000-8000-000000000300'));
    rememberChapter(store, key, { head: 'h1', digest: 'd1', epoch: 'e1', length: 12, savedAt: '2026-09-28T12:00:00Z' });
    rememberChapter(store, key, { publication: 'p1', eligibility: 'q1', publishedHead: 'h1' });
    expect(readChapterMemory(store, key)).toEqual({ head: 'h1', digest: 'd1', epoch: 'e1', publication: 'p1',
      eligibility: 'q1', publishedHead: 'h1', length: 12, savedAt: '2026-09-28T12:00:00Z' });
    store.setItem(key, '"text"');
    expect(readChapterMemory(store, key)).toBeNull();
    store.setItem(key, '{"head":1,"length":"many"}');
    expect(readChapterMemory(store, key)).toMatchObject({ head: null, length: null });
  });
});

describe('Studio chapter commands', () => {
  test('a pending command is sent again with the same request until Main answers it', async () => {
    let sent = 0;
    const answer = await settled(async () => (++sent < 3
      ? { data: { operationId: 'op', retry: { afterMs: 1 } } } : { data: { work: 'w' } }));
    expect(sent).toBe(3);
    expect(answer.data).toEqual({ work: 'w' });
    const stuck = await settled(async () => ({ data: { operationId: 'op', retry: { afterMs: 1 } } }), 2);
    expect(stuck.data).toHaveProperty('operationId');
  });

  test('the first chapter makes the composition, then the chapter Work, then its place', async () => {
    const main = storyMain({ delayMs: 0 });
    const created = await createChapter({ actingSubject: agent, book: ids.serial, mainVersion: ids.serial, composition: null,
      title: '第一章 雨夜', language: 'zh-Hans', key: 'k1' }, main.main);
    expect(created.outcome).toBe('done');
    expect(main.calls).toEqual(['composition', 'work', 'insert']);
    expect(main.book(ids.serial)?.items).toEqual([expect.objectContaining({ target: created.chapter,
      label: { value: '第一章 雨夜', language: 'zh-Hans' } })]);
  });

  test('a chapter placed on a stale head is refused, and moves use the current head', async () => {
    const main = storyMain({ delayMs: 0 });
    const structure = main.seedBook(ids.serial, [{ target: ids.chapters[0]!, title: '一' },
      { target: ids.chapters[1]!, title: '二' }]);
    const book = main.book(ids.serial)!;
    const stale = await createChapter({ actingSubject: agent, book: ids.serial, mainVersion: ids.serial,
      composition: { structure, head: 'https://rezics.com/id/00000000-0000-4000-8000-00000000dead' }, title: '三',
      language: 'zh-Hans', key: 'k2' }, main.main);
    expect(stale.outcome).toBe('stale');
    const second = book.items[1]!.occurrence;
    const moved = await moveChapter({ actingSubject: agent, structure, head: book.head, occurrence: second, after: null,
      key: 'k3' }, main.main);
    expect(moved.outcome).toBe('done');
    expect(main.book(ids.serial)!.items.map(item => item.label.value)).toEqual(['二', '一']);
  });

  test('publishing makes a chapter readable; an update names the publication it replaces', async () => {
    const main = storyMain({ delayMs: 0 });
    const variant = await chapterVariant(ids.chapters[0]!, 'zh-Hans');
    const target = { actingSubject: agent, chapter: ids.chapters[0]!, variant, language: 'zh-Hans', direction: 'ltr' as const };
    const head = main.seedChapter(target.chapter, variant, '第一版');
    const basis = { head, digest: 'b'.repeat(64), epoch: 'story-epoch' };
    const first = await publishChapter({ target, basis, current: null, key: 'p1' }, main.main);
    expect(first).toMatchObject({ outcome: 'done', step: 'eligibility' });
    // Without the publication it replaces, an update is refused rather than overwriting it.
    const next = main.seedChapter(target.chapter, variant, '第二版');
    const blind = await publishChapter({ target, basis: { ...basis, head: next }, current: null, key: 'p2' }, main.main);
    expect(blind).toMatchObject({ outcome: 'stale', step: 'publish' });
    const update = await publishChapter({ target, basis: { ...basis, head: next }, current: first.publication!, key: 'p3' },
      main.main);
    expect(update).toMatchObject({ outcome: 'done' });
    expect(update.publication?.publication).not.toBe(first.publication?.publication);
    expect(main.calls).toEqual(['publish-chapter', 'eligibility', 'publish-chapter', 'publish-chapter', 'eligibility']);
  });
});

describe('Studio Work details', () => {
  const metadata = { work: ids.serial, revision: 'r', originalTitle: null, completionStatus: 'hiatus',
    localized: [{ language: 'en', title: 'Rain', description: null, mainVersionLabel: 'First edition', tagline: null },
      { language: 'zh-Hans', title: null, description: '简介', mainVersionLabel: null, tagline: '一句话' }] } as unknown as
    WorkMetadata;

  test('details open with the Work’s own language first and keep what the form does not edit', () => {
    const values = detailsValues(metadata, 'zh-Hans');
    expect(values.completion).toBe('hiatus');
    expect(values.entries.map(entry => entry.language)).toEqual(['zh-Hans', 'en']);
    expect(values.entries[1]).toMatchObject({ title: 'Rain', label: 'First edition' });
    expect(values.entries[0]).toMatchObject({ tagline: '一句话', description: '简介' });
    expect(detailsValues(null, 'ja').entries).toEqual([{ language: 'ja', title: '', description: '', tagline: '', label: null }]);
  });

  test('Studio refuses what Main would: a row without a language, a language twice, an unknown status', () => {
    const values = detailsValues(metadata, 'zh-Hans');
    expect(detailsInvalid(values)).toBe(false);
    expect(detailsInvalid({ ...values, entries: [...values.entries, { ...values.entries[0]! }] })).toBe(true);
    expect(detailsInvalid({ ...values, entries: [{ ...values.entries[0]!, language: '' }] })).toBe(true);
    expect(detailsInvalid({ ...values, completion: 'paused' as never })).toBe(true);
  });
});

describe('Studio Work kinds', () => {
  test('a Book is a Book even with other types; a Work without a type is a chapter', () => {
    expect(workKind(['https://schema.org/DigitalDocument', 'https://schema.org/Book'])).toBe('book');
    expect(workKind(['https://schema.org/Recipe'])).toBe('recipe');
    expect(workKind([])).toBe('chapter');
  });
});
