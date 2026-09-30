import { beforeAll, describe, expect, test } from 'bun:test';
import { chapterVariant, createChapter, moveChapter, publishChapter, settled } from '../features/studio/content-api.ts';
import { lengthUnit, manuscriptLength } from '../features/studio/counts.ts';
import { detailsInvalid, detailsValues } from '../features/studio/details-api.ts';
import { ids, storyMain } from '../features/studio/fixtures.ts';
import { chapterMemoryKey, type DraftStorage, readChapterMemory, rememberChapter } from '../features/studio/local-draft.ts';
import { readChapterFacts, readChapters } from '../features/studio/read.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

import { typeLabel } from '../features/catalogue/types.ts';
import { type MainClient, workKind, type WorkMetadata } from '../features/studio/types.ts';

beforeAll(seedServedTypes);

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
    expect(created.occurrence).toBe(main.book(ids.serial)?.items[0]?.occurrence);
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
  seedServedTypes();
  test('a Book is a Book even with other types; a Work without a type is a chapter', () => {
    expect(workKind(['https://schema.org/DigitalDocument', 'https://schema.org/Book'])).toBe('book');
    expect(workKind(['https://schema.org/Recipe'])).toBe('recipe');
    expect(workKind([])).toBe('chapter');
    // A prompt is written as one text, and is listed with the Agent's other Works.
    expect(workKind(['https://rezics.com/vocab/PromptTemplate'])).toBe('document');
  });

  test('a Work is labelled by the registry, the more specific type first', () => {
    expect(typeLabel(['https://schema.org/DigitalDocument'], 'en')).toBe('Guide');
    expect(typeLabel(['https://schema.org/DigitalDocument', 'https://rezics.com/vocab/PromptTemplate'], 'en')).toBe('Prompt');
    expect(typeLabel(['https://rezics.com/vocab/SkillPackage'], 'en')).toBe('Skill');
    expect(typeLabel(['https://rezics.com/vocab/ModPackage', 'https://schema.org/SoftwareApplication'], 'en')).toBe('Mod');
    expect(typeLabel(['https://schema.org/Recipe', 'https://schema.org/DigitalDocument'], 'en')).toBe('Recipe');
    expect(typeLabel(['https://schema.org/BookSeries'], 'ja')).toBe('本');
    expect(typeLabel([], 'en')).toBeNull();
  });
});

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const self = iri(1), pen = iri(2), stranger = iri(9);
const person = (id: string, label: string) => ({ iri: id, label, handle: null, kind: 'person' as const,
  path: 'represented-agent' as const });

interface Chapter {
  target: string;
  label: string | null;
  writer: string;
  /** Readers get it: its text is published and eligible, so anyone can see it. */
  published: boolean;
  /** The writer's draft head; the published revision when nothing changed since. */
  draft: string | null;
  language?: string;
}

/**
 * A stand-in Main for Studio's chapter reads: a Book's contents as each Agent sees them (a private chapter only
 * to its writer, a published one to everyone, in the language asked or the Main Version's), the Main Version's
 * public texts, and a chapter's Content variants, which Main lists only to the chapter's writer.
 */
function chaptersMain({ chapters, mainLanguage, mainTexts, bookWriter = self, refuseOther = false }: {
  chapters: Chapter[]; mainLanguage: string | null; mainTexts: Array<{ language: string; author: string }>;
  bookWriter?: string; refuseOther?: boolean;
}) {
  const calls: string[] = [];
  const ok = (data: unknown) => ({ data, error: null });
  const missing = () => ({ data: null, error: { status: 404, value: { code: 'work_unavailable' } } });
  const denied = () => ({ data: null, error: { status: 403, value: { code: 'studio_denied' } } });
  const published = (chapter: Chapter) => `urn:rezics:content:revision:${chapter.target.slice(-36)}`;
  const main = { v1: {
    me: { agents: ({ agent }: { agent: string }) => ({ works: () => ({ chapters: { get: async ({ query }: {
      query: { language: string; cursor?: string } }) => {
      const language = query.language.toLowerCase();
      calls.push(`chapter-agent ${agent}`);
      calls.push(`chapters ${language}`);
      if (agent !== bookWriter.slice(-36)) return refuseOther ? denied() : missing();
      const items = chapters.map((chapter, index) => {
        const visible = chapter.published || chapter.writer === self;
        const readable = chapter.published && language === (chapter.language ?? 'zh-hans');
        return { occurrence: iri(200 + index), parent: iri(102), role: 'chapter',
          label: visible && chapter.label ? { value: chapter.label, language } : null,
          target: visible ? chapter.target : null, selectedRevision: readable ? published(chapter) : null,
          progress: null, availability: readable ? 'available' : 'unavailable' };
      });
      const facts = chapters.map((chapter, index) => {
        const controlled = chapter.writer === self || chapter.writer === pen;
        const disclosed = controlled || chapter.published;
        const selected = published(chapter).slice('urn:rezics:content:revision:'.length);
        return { occurrence: iri(200 + index), writer: disclosed ? chapter.writer : null,
          otherIdentity: chapter.writer.slice(-36) !== agent,
          state: !disclosed ? null : !controlled ? 'published' : !chapter.draft ? 'empty'
            : chapter.published ? chapter.draft === selected ? 'published' : 'changed' : 'draft',
          target: disclosed ? chapter.target : null,
          label: disclosed && chapter.label ? { value: chapter.label, language } : null,
          language };
      });
      return ok({ profile: 'studio-chapters-v1', page: { profile: 'work-contents-v1', work: iri(100),
        version: iri(101), composition: iri(102), compositionRevision: iri(103), language,
        nextCursor: null, sourcePosition: { dataEpoch: 'e', sequence: '1' },
        count: { value: chapters.length, kind: 'exact-page', total: null }, items }, facts });
    } } }) }) },
    works: (params: { id: string }) => ({
      'agent-credits': { get: async () => {
        calls.push('credits');
        return ok({ items: [{ id: iri(400), role: 'author', agent: bookWriter,
          displayName: 'Writer', handle: null }], nextCursor: null });
      } },
      contents: { get: async ({ query }: { query: { actingSubject: string; language?: string } }) => {
        const language = query.language?.toLowerCase() ?? mainLanguage;
        calls.push(`contents ${query.actingSubject.slice(-1)} ${language}`);
        return ok({ profile: 'work-contents-v1', work: iri(100), version: iri(101), composition: iri(102),
          compositionRevision: iri(103), language, nextCursor: null, sourcePosition: { dataEpoch: 'e', sequence: '1' },
          count: { value: chapters.length, kind: 'exact-page', total: null },
          items: chapters.map((chapter, index) => {
            const visible = chapter.published || chapter.writer === query.actingSubject;
            const readable = chapter.published && language === (chapter.language ?? 'zh-hans');
            return { occurrence: iri(200 + index), parent: iri(102), role: 'chapter',
              label: visible && chapter.label ? { value: chapter.label, language: language ?? 'zh-hans' } : null,
              target: visible ? chapter.target : null, selectedRevision: readable ? published(chapter) : null,
              progress: null, availability: readable ? 'available' : 'unavailable' };
          }) });
      } },
      'content-variants': { get: async ({ query }: { query: { actingSubject: string } }) => {
        const chapter = chapters.find(item => item.target.endsWith(params.id));
        calls.push(`variants ${params.id.slice(-3)} ${query.actingSubject.slice(-1)}`);
        if (!chapter || chapter.writer !== query.actingSubject) return missing();
        return ok({ work: chapter.target, nextCursor: null, sourcePosition: { owner: 'content', dataEpoch: 'c', sequence: '1' },
          items: chapter.draft ? [{ variantId: `urn:rezics:variant:${chapter.target.slice(-36)}`,
            language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' }, direction: 'ltr', draftHead: chapter.draft,
            publicationHead: chapter.published ? 'urn:rezics:content-publication:p' : null,
            eligibilityHead: chapter.published ? 'urn:rezics:content-search-eligibility:e' : null }] : [] });
      } },
    }),
    'main-versions': () => ({ 'native-variants': { get: async () => {
      calls.push('main texts');
      return ok({ work: iri(100), mainVersion: iri(101), complete: true, variants: mainTexts.map((text, index) => ({
        contribution: iri(300 + index), publicationDecision: iri(310 + index), selectedDraft: iri(320 + index),
        language: text.language, author: text.author })) });
    } } }),
  } };
  return { main: main as unknown as MainClient, calls, published };
}

const serialHeader = (language = 'en') => ({ id: iri(100), mainVersion: iri(101),
  title: { value: '雨夜书店 · 连载小说', language, direction: 'ltr' as const, basis: 'requested' as const } });

describe('Studio chapters in the language they are written in', () => {
  const chapter = (n: number, extra: Partial<Chapter> = {}): Chapter => ({ target: iri(110 + n), label: `第${n}章`,
    writer: self, published: true, draft: null, ...extra });

  test('a serial whose title Main recorded as English reads its chapters in its Main Version’s language', async () => {
    const { main, calls } = chaptersMain({ chapters: [chapter(1), chapter(2)], mainLanguage: 'zh-hans',
      mainTexts: [{ language: 'zh-Hans', author: self }] });
    const read = await readChapters(self, serialHeader('en'), { main });
    expect(read.language).toBe('zh-Hans');
    expect(read.page.ok && read.page.data.items.map(item => [item.label?.value, item.availability])).toEqual([
      ['第1章', 'available'], ['第2章', 'available']]);
    expect(calls.filter(call => call.startsWith('chapters'))).toEqual(['chapters zh-hans']);
    expect(calls.filter(call => call.startsWith('contents'))).toEqual([]);
  });

  test('a Book with no published text reads its chapters in its own language', async () => {
    const { main, calls } = chaptersMain({ chapters: [chapter(1, { language: 'ja' })], mainLanguage: null, mainTexts: [] });
    const read = await readChapters(self, serialHeader('ja'), { main });
    expect(read.language).toBe('ja');
    expect(read.page.ok && read.page.data.items[0]?.availability).toBe('available');
    expect(calls.filter(call => call.startsWith('chapters'))).toEqual(['chapters ja']);
  });

  test('a Main Version in several languages reads the chapters in the Studio Agent’s own', async () => {
    const { main } = chaptersMain({ chapters: [chapter(1)], mainLanguage: 'en',
      mainTexts: [{ language: 'en', author: stranger }, { language: 'zh-Hans', author: self }] });
    const read = await readChapters(self, serialHeader('en'), { main });
    expect(read.language).toBe('zh-Hans');
    expect(read.page.ok && read.page.data.language).toBe('zh-hans');
  });

  test('a Book opened as another controlled identity reads chapters as its credited writer', async () => {
    const { main, calls } = chaptersMain({ chapters: [chapter(1, { writer: pen })], bookWriter: pen,
      refuseOther: true,
      mainLanguage: 'zh-hans', mainTexts: [{ language: 'zh-Hans', author: pen }] });
    const agents = [person(self, 'Reader'), person(pen, 'Writer')];
    const read = await readChapters(self, serialHeader(), { main, agents });
    expect(read.page.ok && read.page.data.items[0]?.label?.value).toBe('第1章');
    expect(calls.filter(call => call.startsWith('chapter-agent'))).toEqual([
      `chapter-agent ${self.slice(-36)}`, `chapter-agent ${pen.slice(-36)}`]);
    expect(calls).toContain('credits');
    const facts = await readChapterFacts(agents[0]!, agents, iri(100), read);
    expect(Object.values(facts)[0]?.writer).toEqual({ kind: 'agent', agent: agents[1] });
  });

  test('another identity without the author credit does not disclose the Book’s chapters', async () => {
    const { main, calls } = chaptersMain({ chapters: [chapter(1, { writer: pen, published: false })],
      bookWriter: pen, mainLanguage: null, mainTexts: [] });
    const read = await readChapters(self, serialHeader(), { main,
      agents: [person(self, 'Reader'), person(stranger, 'Unrelated')] });
    expect(read.page).toEqual({ ok: false, failure: 'none' });
    expect(calls.filter(call => call.startsWith('chapter-agent'))).toEqual([`chapter-agent ${self.slice(-36)}`]);
  });
});

describe('Studio chapter writers and states', () => {
  test('each chapter says where it stands and which of this person’s identities writes it', async () => {
    const chapters: Chapter[] = [
      { target: iri(111), label: '第一章', writer: self, published: true, draft: null },
      { target: iri(112), label: '第二章', writer: self, published: true, draft: '00000000-0000-4000-8000-00000000abcd' },
      { target: iri(113), label: '第三章', writer: pen, published: true, draft: null },
      { target: iri(114), label: '第四章', writer: pen, published: false, draft: '00000000-0000-4000-8000-00000000beef' },
      { target: iri(115), label: '第五章', writer: stranger, published: false, draft: '00000000-0000-4000-8000-00000000cafe' },
      { target: iri(116), label: '第六章', writer: self, published: false, draft: null },
    ];
    const { main, calls, published } = chaptersMain({ chapters, mainLanguage: 'zh-hans',
      mainTexts: [{ language: 'zh-Hans', author: self }] });
    // A published chapter's draft head is the revision readers get until it changes.
    for (const item of chapters) {
      if (item.published && !item.draft) item.draft = published(item).slice('urn:rezics:content:revision:'.length);
    }
    const read = await readChapters(self, serialHeader(), { main });
    const agents = [person(self, 'Lin Mei 林梅'), person(pen, '月下书生')];
    const facts = await readChapterFacts(agents[0]!, agents, iri(100), read);
    const at = (n: number) => facts[iri(200 + n)];
    expect(at(0)).toEqual({ writer: { kind: 'self' }, state: 'published' });
    expect(at(1)).toEqual({ writer: { kind: 'self' }, state: 'changed' });
    expect(at(2)).toEqual({ writer: { kind: 'agent', agent: agents[1] }, state: 'published' });
    // A private chapter the pen name writes: the Studio Agent can't see it, so its title comes from the pen name.
    expect(at(3)).toEqual({ writer: { kind: 'agent', agent: agents[1] }, state: 'draft', target: iri(114),
      label: { value: '第四章', language: 'zh-hans' } });
    expect(at(4)).toEqual({ writer: { kind: 'unknown' }, state: null });
    expect(at(5)).toEqual({ writer: { kind: 'self' }, state: 'empty' });
    expect(calls.filter(call => call.startsWith('variants'))).toEqual([]);
    const later = await readChapterFacts(agents[0]!, agents, iri(100), read);
    expect(later[iri(203)]).toEqual(at(3));
    expect(later[iri(202)]).toEqual(at(2));
  });

});
