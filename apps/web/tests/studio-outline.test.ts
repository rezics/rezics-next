import { describe, expect, test } from 'bun:test';
import { changeComposition, publishLatest, chapterVariant } from '../features/studio/content-api.ts';
import { ids, storyMain } from '../features/studio/fixtures.ts';
import { chapterFacts, defaultChapterParent, dropEdge, moveOperation, publishable, stepDestination }
  from '../features/studio/outline.ts';
import type { ContentsItem } from '../features/studio/types.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const item = (occurrence: string, parent: string, role: 'chapter' | 'group' = 'chapter',
  division: ContentsItem['division'] = null) => ({ occurrence, parent, role, division }) as ContentsItem;

describe('Studio outline moves', () => {
  const book = 'book', [a, b, c] = ['a', 'b', 'c'];
  const top = [item(a, book), item(b, book), item(c, book)];

  test('a move before a sibling goes after the one before it, or first; after and end are direct', () => {
    expect(moveOperation(c, { parent: book, before: b }, top)).toEqual({ op: 'move', occurrence: c, parent: book,
      position: { after: a } });
    expect(moveOperation(c, { parent: book, before: a }, top)).toMatchObject({ position: 'first' });
    // The moving use is never its own anchor.
    expect(moveOperation(a, { parent: book, before: c }, top)).toMatchObject({ position: { after: b } });
    expect(moveOperation(a, { parent: book, after: c }, top)).toMatchObject({ position: { after: c } });
    expect(moveOperation(a, { parent: 'volume', end: true }, [])).toMatchObject({ parent: 'volume', position: 'last' });
  });

  test('one step up or down stays in its level and stops at its edges', () => {
    expect(stepDestination(c, -1, book, top)).toEqual({ parent: book, before: b });
    expect(stepDestination(a, 1, book, top)).toEqual({ parent: book, after: b });
    expect(stepDestination(a, -1, book, top)).toBeNull();
    expect(stepDestination(c, 1, book, top)).toBeNull();
  });

  test('a drop lands before a row over its upper half and after it over its lower half', () => {
    expect(dropEdge(10, { top: 0, height: 40 })).toBe('before');
    expect(dropEdge(30, { top: 0, height: 40 })).toBe('after');
  });

  test('a new chapter goes to the last volume or part, never extras, else the top level', () => {
    expect(defaultChapterParent(book, [item('v1', book, 'group', 'volume'), item('v2', book, 'group', 'part'),
      item('x', book, 'group', 'extras')])).toBe('v2');
    expect(defaultChapterParent(book, [item('x', book, 'group', 'extras')])).toBe(book);
    expect(defaultChapterParent(book, top)).toBe(book);
  });
});

describe('Studio outline commands', () => {
  test('a change on the current head reorders a level; one on a stale head is made again on the new head', async () => {
    const main = storyMain({ delayMs: 0 });
    const structure = main.seedBook(ids.serial, [{ target: ids.chapters[0]!, title: '一' },
      { target: ids.chapters[1]!, title: '二' }, { target: ids.chapters[2]!, title: '三' }]);
    const level = main.level(ids.serial);
    const [one, , three] = level.items.map(entry => entry.occurrence) as [string, string, string];
    const up = stepDestination(three, -1, structure, level.items)!;
    const moved = await changeComposition({ actingSubject: agent, book: ids.serial, language: 'zh-Hans',
      composition: { structure, head: level.compositionRevision }, operations: [moveOperation(three, up, level.items)],
      key: 'm1' }, main.main);
    expect(moved.outcome).toBe('done');
    expect(main.book(ids.serial)!.items.map(entry => entry.label.value)).toEqual(['一', '三', '二']);
    const stale = await changeComposition({ actingSubject: agent, book: ids.serial, language: 'zh-Hans',
      composition: { structure, head: level.compositionRevision }, operations: [moveOperation(one,
        { parent: structure, end: true }, level.items)], key: 'm2' }, main.main);
    expect(stale.outcome).toBe('done');
    expect(main.book(ids.serial)!.items.map(entry => entry.label.value)).toEqual(['三', '二', '一']);
  });

  test('volumes: a chapter moves into a volume, a group is renamed, re-divided, and removed only when empty', async () => {
    const main = storyMain({ delayMs: 0 });
    const structure = main.seedOutline(ids.serial, [
      { title: '第一卷', division: 'volume', chapters: [{ target: ids.chapters[0]!, title: '第一章' }] },
      { title: '第二卷', division: 'volume', chapters: [{ target: ids.chapters[1]!, title: '第二章' }] }]);
    const top = main.level(ids.serial);
    const [first, second] = top.items.map(entry => entry.occurrence) as [string, string];
    const chapter = main.level(ids.serial, first).items[0]!.occurrence;
    let head = top.compositionRevision;
    const change = async (operations: Parameters<typeof changeComposition>[0]['operations']) => {
      const result = await changeComposition({ actingSubject: agent, book: ids.serial, composition: { structure, head },
        operations, key: crypto.randomUUID() }, main.main);
      if (result.outcome === 'done') head = result.head;
      return result.outcome;
    };
    expect(await change([moveOperation(chapter, { parent: second, end: true }, [])])).toBe('done');
    expect(main.level(ids.serial, second).items.map(entry => [entry.label?.value, entry.number]))
      .toEqual([['第二章', 1], ['第一章', 2]]);
    expect(await change([{ op: 'update', occurrence: second, label: { value: '第二卷 雨停', language: 'zh-Hans' } }]))
      .toBe('done');
    expect(await change([{ op: 'update', occurrence: first, division: 'extras' }])).toBe('done');
    expect(main.level(ids.serial).items.map(entry => [entry.label?.value, entry.division, entry.number, entry.childCount]))
      .toEqual([['第一卷', 'extras', null, 0], ['第二卷 雨停', 'volume', 1, 2]]);
    expect(await change([{ op: 'remove', occurrence: second }])).toBe('stale');
    expect(await change([{ op: 'remove', occurrence: first }])).toBe('done');
    expect(main.level(ids.serial).items).toHaveLength(1);
  });

  test('publishing a selection publishes each chapter’s latest draft once, and skips what has none', async () => {
    const main = storyMain({ delayMs: 0 });
    const chapter = ids.chapters[0]!;
    main.seedChapter(chapter, await chapterVariant(chapter, 'zh-Hans'), '第一版');
    expect(await publishLatest({ actingSubject: agent, chapter, language: 'zh-Hans' }, main.main)).toBe('done');
    expect(await publishLatest({ actingSubject: agent, chapter: ids.chapters[1]!, language: 'zh-Hans' }, main.main))
      .toBe('nothing');
    expect(main.calls).toEqual(['publish-chapter', 'eligibility']);
  });

  test('facts name the writer and keep what only the writer sees; only a writer’s own draft is publishable', () => {
    const agents = [{ iri: agent, label: 'Lin Mei', handle: null, kind: 'person' as const, path: 'represented-agent' as const },
      { iri: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', label: 'Pen', handle: null,
        kind: 'pen-name' as const, path: 'represented-agent' as const }];
    const page = { items: [{ ...item('x', 'book'), target: 't' }, { ...item('y', 'book'), target: null }] } as never;
    const facts = chapterFacts(agents[0]!, agents, page, [
      { occurrence: 'x', writer: agent, otherIdentity: false, state: 'draft', target: 't', label: null, language: 'zh-Hans',
        length: { unit: 'characters', value: 120 } },
      { occurrence: 'y', writer: agents[1]!.iri, otherIdentity: true, state: 'empty', target: 'u',
        label: { value: '私', language: 'zh-Hans' }, language: 'zh-Hans', length: null }]);
    expect(facts.x).toEqual({ writer: { kind: 'self' }, state: 'draft', length: { unit: 'characters', value: 120 } });
    expect(facts.y).toMatchObject({ writer: { kind: 'agent' }, target: 'u', label: { value: '私' } });
    expect(publishable(facts.x)).toBe(true);
    expect(publishable(facts.y)).toBe(false);
  });
});
