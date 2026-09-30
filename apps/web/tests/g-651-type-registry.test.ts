import { beforeEach, describe, expect, test } from 'bun:test';
import { isUseWork, rowStatusLabel } from '../features/library/labels.ts';
import { seedServedTypes, servedTypes } from '../features/catalogue/type-fixtures.ts';
import { forgetServedTypes, readTypes } from '../features/catalogue/types-read.ts';
import { clearTypes, coverOf, creatableTypes, isUseAction, labelOfType, primaryActionOf, typeEntry, typeLabel }
  from '../features/catalogue/types.ts';
import { coverKindOf, slotRatio } from '../features/catalogue/work.ts';
import { workTypes } from '../features/discover/state.ts';
import { valueLabel } from '../features/zones/browse-view.ts';
import { typeNames } from '../features/work-page/format.ts';
import { writableTypes, workKind } from '../features/studio/types.ts';

const game = 'https://schema.org/VideoGame';
const book = 'https://schema.org/Book';

describe('G-651 the web reads types from the served registry', () => {
  beforeEach(seedServedTypes);

  test('a VideoGame draws the registry’s landscape cover and is called a Game, not a book', () => {
    expect(coverOf([game])).toBe('game');
    expect(coverKindOf([game])).toBe('game');
    expect(typeLabel([game], 'en')).toBe('Game');
    expect(typeLabel([game], 'ja')).toBe('ゲーム');
    expect(typeLabel([game], 'zh-Hant')).toBe('遊戲');
    expect(typeLabel([game], 'en', 'other')).toBe('Games');
    expect(primaryActionOf([game])).toBe('visit');
    expect(slotRatio([{ kind: 'game' }])).toBe(16 / 9);
    expect(slotRatio([{ kind: 'game' }, { kind: 'book' }])).toBe(2 / 3);
  });

  test('an unknown type gets its base’s default label and cover; an untyped Work names nothing', () => {
    expect(typeEntry(['https://example.com/Hologram'])?.type).toBe('https://schema.org/CreativeWork');
    expect(typeLabel(['https://example.com/Hologram'], 'en')).toBe('Work');
    expect(coverOf(['https://example.com/Hologram'])).toBe('document');
    expect(primaryActionOf(['https://example.com/Hologram'])).toBe('read');
    expect(typeLabel([], 'en')).toBeNull();
    // Only an admitted type labels a facet value; the default never stands for an unknown one.
    expect(labelOfType('https://example.com/Hologram', 'en')).toBeNull();
    expect(labelOfType(book, 'en', 'other')).toBe('Books');
  });

  test('the most specific type wins, and squares split into recipe cards and package tiles', () => {
    expect(typeLabel(['https://schema.org/DigitalDocument', 'https://rezics.com/vocab/PromptTemplate'], 'en')).toBe('Prompt');
    expect(coverOf(['https://schema.org/Recipe'])).toBe('recipe');
    expect(coverOf(['https://rezics.com/vocab/ModPackage'])).toBe('package');
    expect(coverOf(['https://schema.org/Movie'])).toBe('book');
    expect(typeNames([book, 'https://schema.org/BookSeries', 'https://example.com/Hologram'], 'en')).toEqual(['Book']);
  });

  test('before the registry arrives a Work draws a book and has no label', () => {
    clearTypes();
    expect(coverOf([game])).toBe('book');
    expect(typeLabel([game], 'en')).toBeNull();
    expect(primaryActionOf([game])).toBe('read');
  });

  test('library status words follow the registry’s action: installed or copied Works are used, the rest read', () => {
    const row = (types: string[]) => ({ work: { kind: coverKindOf(types) }, types, status: 'reading' as const });
    expect(isUseAction(primaryActionOf(['https://rezics.com/vocab/PromptTemplate']))).toBe(true);
    expect(isUseWork(row(['https://rezics.com/vocab/SkillPackage']))).toBe(true);
    expect(isUseWork(row(['https://schema.org/SoftwareApplication']))).toBe(true);
    expect(isUseWork(row([book]))).toBe(false);
    expect(isUseWork(row([game]))).toBe(false);
    const t = { reading: 'Reading', using: 'Using' } as never;
    expect(rowStatusLabel(row(['https://rezics.com/vocab/PromptTemplate']) as never, t)).toBe('Using');
    expect(rowStatusLabel(row([book]) as never, t)).toBe('Reading');
  });

  test('Studio offers the Work types a contributor creates and readers read, and writes a Book in chapters', () => {
    expect(writableTypes().map(entry => entry.type)).toEqual([book,
      'https://schema.org/DigitalDocument', 'https://schema.org/Recipe']);
    // Administrator-only and non-text types are creatable in the registry but not offered here.
    expect(creatableTypes().map(entry => entry.type)).toContain(game);
    expect(writableTypes().map(entry => entry.type)).not.toContain(game);
    expect(workKind([book])).toBe('book');
    expect(workKind([game])).toBe('document');
    expect(workKind([])).toBe('chapter');
  });

  test('a Zone’s type facet values are worded by the registry in the page’s language', () => {
    const label = (value: string, locale: 'en' | 'ja' | 'zh-Hant') => valueLabel('type', value, null, locale, {} as never)?.value;
    expect(label(game, 'en')).toBe('Game');
    expect(label(game, 'ja')).toBe('ゲーム');
    expect(label('https://rezics.com/vocab/SkillPackage', 'zh-Hant')).toBe('技能');
    expect(label('https://example.com/Hologram', 'en')).toBeUndefined();
  });

  test('discovery filters take their IRI and label from the registry', () => {
    expect(workTypes().map(type => [type.key, type.iri, type.entry.labels.en.other])).toEqual([
      ['book', book, 'Books'], ['document', 'https://schema.org/DigitalDocument', 'Guides'],
      ['recipe', 'https://schema.org/Recipe', 'Recipes']]);
  });
});

describe('G-651 the web revalidates the registry by ETag', () => {
  const tag = `"${servedTypes.digest}"`;
  const reply = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 304 ? null : JSON.stringify(servedTypes), { status, headers: { 'cache-control':
      'public, max-age=300', ...headers } });

  function recorder(answers: Array<() => Response | Promise<Response>>) {
    const calls: Array<{ url: string; ifNoneMatch: string | null }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ifNoneMatch: new Headers(init?.headers).get('if-none-match') });
      return answers[calls.length - 1]!();
    }) as typeof fetch;
    return { calls, fetcher };
  }

  beforeEach(() => { clearTypes(); forgetServedTypes(); });

  test('one read serves every caller until Main’s max-age ends, then an If-None-Match read gets 304', async () => {
    let clock = 0;
    const { calls, fetcher } = recorder([() => reply(200, { etag: tag }), () => reply(304, { etag: tag })]);
    const first = await readTypes(fetcher, () => clock);
    expect(first?.digest).toBe(servedTypes.digest);
    expect(calls).toEqual([{ url: expect.stringMatching(/\/v1\/types$/), ifNoneMatch: null }]);
    expect(coverKindOf([game])).toBe('game');
    clock = 299_000;
    await readTypes(fetcher, () => clock);
    expect(calls).toHaveLength(1);
    clock = 301_000;
    const again = await readTypes(fetcher, () => clock);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.ifNoneMatch).toBe(tag);
    // The 304 renewed the held body without a new download.
    expect(again?.digest).toBe(servedTypes.digest);
    clock = 400_000;
    await readTypes(fetcher, () => clock);
    expect(calls).toHaveLength(2);
  });

  test('concurrent first reads share one request, and a failed revalidation keeps the last registry', async () => {
    let clock = 0;
    const { calls, fetcher } = recorder([() => reply(200, { etag: tag }), () => reply(500), () => reply(304)]);
    const [a, b] = await Promise.all([readTypes(fetcher, () => clock), readTypes(fetcher, () => clock)]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    clock = 301_000;
    expect((await readTypes(fetcher, () => clock))?.digest).toBe(servedTypes.digest);
    expect(coverKindOf([game])).toBe('game');
    // Main is asked again shortly, not on every render.
    await readTypes(fetcher, () => clock + 1_000);
    expect(calls).toHaveLength(2);
    clock += 11_000;
    await readTypes(fetcher, () => clock);
    expect(calls).toHaveLength(3);
  });

  test('with nothing held and Main down there is no registry, and lookups stay safe', async () => {
    const { fetcher } = recorder([() => { throw new Error('down'); }]);
    expect(await readTypes(fetcher, () => 0)).toBeNull();
    expect(coverKindOf([game])).toBe('book');
  });
});
