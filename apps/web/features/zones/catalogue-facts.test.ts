import { describe, expect, test } from 'vitest';
import type { StatementPage } from '../entity-page/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import type { ClassificationPage, Loaded } from '../work-page/types.ts';
import { readCatalogueFacts, readCatalogueStatementPages } from './catalogue-facts.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000801';
const predicate = 'https://rezics.com/id/00000000-0000-4000-8000-000000000802';
const countName = zoneContentText('Episodes', 'en');
const formatName = zoneContentText('TV', 'en');
const xsd = 'http://www.w3.org/2001/XMLSchema#';
type CatalogueReaders = NonNullable<Parameters<typeof readCatalogueFacts>[4]>;

function page(index: number, count: number): StatementPage {
  return {
    groups: [{ predicate: 'https://schema.org/datePublished', items: [{ kind: 'statement',
      value: { kind: 'literal', lexical: String(2021 + index), datatype: `${xsd}gYear` } }] },
    ...index === count - 1 ? [{ predicate, items: [{ kind: 'statement',
      value: { kind: 'literal', lexical: '12', datatype: `${xsd}integer` } }] }] : []],
    factObligations: { page: index },
    nextCursor: index + 1 < count ? `page-${index + 1}` : null,
  } as unknown as StatementPage;
}

function classifications(nextCursor: string | null = null, matched = true): ClassificationPage {
  const name = matched ? formatName : zoneContentText('Novel', 'en');
  return { items: [{ name: { value: name.value, language: name.lang, direction: name.dir } }],
    nextCursor } as unknown as ClassificationPage;
}

function readers(classificationPage = classifications(),
  statements: CatalogueReaders['statements'] = async () => ({ ok: true, data: [page(0, 1)] }),
): CatalogueReaders {
  return {
    classifications: async () => ({ ok: true, data: classificationPage }),
    statements,
    predicate: async () => ({ ok: true, data: { predicate, name: countName } }),
  };
}

const unavailable = { format: null, years: [], count: null, countName: null,
  unavailable: true, factObligations: [] };

describe('catalogue preview statement continuation', () => {
  test('a terminal fourth page preserves every page and its rights obligations', async () => {
    const calls: Array<string | undefined> = [];
    const pages = Array.from({ length: 4 }, (_, index) => page(index, 4));
    const result = await readCatalogueStatementPages(async cursor => {
      calls.push(cursor);
      return { ok: true, data: pages[calls.length - 1]! };
    });
    expect(result).toEqual({ ok: true, data: pages });
    expect(calls).toEqual([undefined, 'page-1', 'page-2', 'page-3']);
    expect(await readCatalogueFacts(work, 'en', 'episodes', ['TV'],
      readers(classifications(), async () => result))).toEqual({
      format: formatName, years: [2024, 2023, 2022, 2021], count: 12, countName,
      unavailable: false, factObligations: pages.map(item => item.factObligations),
    });
  });

  test('an outstanding fifth page cannot be presented as complete catalogue facts', async () => {
    let calls = 0;
    const result = await readCatalogueStatementPages(async () => ({ ok: true, data: page(calls++, 5) }));
    expect(result).toEqual({ ok: false, failure: 'unavailable' });
    expect(calls).toBe(4);
    expect(await readCatalogueFacts(work, 'en', 'episodes', ['TV'],
      readers(classifications(), async () => result))).toEqual(unavailable);
  });

  test('a cursor cycle refuses incomplete facts before the page budget', async () => {
    const cursors = ['page-1', 'page-2', 'page-1'];
    let calls = 0;
    const result = await readCatalogueStatementPages(async () => {
      const index = calls++;
      return { ok: true, data: { ...page(index, 5), nextCursor: cursors[index]! } };
    });
    expect(result).toEqual({ ok: false, failure: 'unavailable' });
    expect(calls).toBe(3);
  });

  test.each(['missing', 'moved', 'unavailable'] as const)('preserves a continuation refusal (%s)', async failure => {
    let calls = 0;
    const result = await readCatalogueStatementPages(async () => ++calls === 1
      ? { ok: true, data: page(0, 2) } : { ok: false, failure });
    expect(result).toEqual({ ok: false, failure });
    expect(calls).toBe(2);
  });
});

describe('catalogue preview classification completeness', () => {
  test.each([true, false])('a classification continuation withholds all facts (first page match: %s)', async matched => {
    expect(await readCatalogueFacts(work, 'en', 'episodes', ['TV'],
      readers(classifications('next-classifications', matched)))).toEqual(unavailable);
  });

  test.each([true, false])('complete classifications preserve the recorded facts (format match: %s)', async matched => {
    expect(await readCatalogueFacts(work, 'en', 'episodes', ['TV'], readers(classifications(null, matched))))
      .toEqual({ format: matched ? formatName : null, years: [2021], count: 12, countName,
        unavailable: false, factObligations: [page(0, 1).factObligations] });
  });

  test.each(['missing', 'moved', 'unavailable'] as const)('a statement refusal exposes unavailable facts (%s)', async failure => {
    const refusal: Loaded<StatementPage[]> = { ok: false, failure };
    expect(await readCatalogueFacts(work, 'en', 'episodes', ['TV'],
      readers(classifications(), async () => refusal))).toEqual(unavailable);
  });
});
