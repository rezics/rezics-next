import { describe, expect, test } from 'bun:test';
import { resourceHref, type AddressTarget } from '../features/address/path.ts';
import { workHref } from '../features/discover/scope.ts';
import type { MainClient } from '../features/discover/types.ts';
import {
  PositionReadError,
  positionPickerPage,
  readReadingPositionPage,
  type ReadingPositionItem,
} from '../features/wiki/position-picker.ts';
import { EntityPickerSource } from '../../../packages/ui/src/components/entity-picker-state.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iri = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const item = (
  n: number,
  labels = [{ value: `Chapter ${n}`, language: 'en' }],
): ReadingPositionItem => ({
  occurrence: iri(n),
  work: iri(9999),
  structure: iri(9998),
  revision: iri(9997),
  parent: iri(9998),
  segmentKey: 'main',
  orderKey: String(n),
  role: 'chapter',
  target: null,
  ordinal: n,
  labels,
});
const page = (items: ReadingPositionItem[], nextCursor: string | null = null) => ({
  profile: 'reading-positions-v1',
  work: iri(9999),
  resolved: 'start',
  items,
  nextCursor,
  next: nextCursor,
  complete: nextCursor === null,
});
function client(get: (query: Record<string, unknown>) => Promise<unknown>): MainClient {
  return {
    v1: {
      'reading-positions': ({ work }: { work: string }) => ({
        get: ({ query }: { query: Record<string, unknown> }) => get({ work, ...query }),
      }),
    },
  } as unknown as MainClient;
}

describe('G-945 durable discovery links', () => {
  test('UUID, IRI, SID and named policy links all use the address owner, preserving scope', () => {
    const sid = resourceHref('/w/', iri(1)).split('/').at(-1)!;
    const targets: AddressTarget[] = [
      uuid(1),
      iri(1),
      sid,
      {
        prefix: '/w/',
        key: 'a-named-work',
        suffixSource: 'A named work',
      },
    ];
    for (const target of targets) {
      expect(workHref(target, { kind: 'global' })).toBe(resourceHref('/w/', target));
      expect(workHref(target, { kind: 'realm', realm: uuid(2) })).toBe(
        `${resourceHref('/w/', target)}?scope=realm&realm=${uuid(2)}`,
      );
      expect(workHref(target, { kind: 'mine' })).toBe(`${resourceHref('/w/', target)}?scope=mine`);
    }
    expect(workHref(iri(1), { kind: 'global' })).not.toContain(uuid(1));
  });
});

describe('G-945 searchable reading positions', () => {
  test('one page read preserves query, actor, chosen boundary and opaque cursor', async () => {
    const calls: Record<string, unknown>[] = [];
    const main = client(async (query) => {
      calls.push(query);
      return { data: page([item(1501)]), error: null };
    });
    const data = await readReadingPositionPage(main, {
      work: iri(9999),
      q: '雪の章',
      cursor: 'opaque-next',
      position: iri(10),
      actingSubject: iri(11),
      limit: 20,
      language: 'ja',
    });
    expect(calls).toEqual([
      {
        work: uuid(9999),
        q: '雪の章',
        cursor: 'opaque-next',
        position: iri(10),
        actingSubject: iri(11),
        limit: 20,
        language: 'ja',
      },
    ]);
    expect(data).toMatchObject({
      items: [{ occurrence: iri(1501) }],
      nextCursor: null,
      complete: true,
    });
  });
  test('continuation keeps the search and retries a transient failure without dropping previous results', async () => {
    const calls: Record<string, unknown>[] = [];
    let fail = true;
    const main = client(async (query) => {
      calls.push(query);
      if (query.cursor && fail) {
        fail = false;
        return { data: null, error: { status: 503 } };
      }
      return {
        data: query.cursor ? page([item(2400)]) : page([item(1501)], 'beyond-1501'),
        error: null,
      };
    });
    const source = new EntityPickerSource(async ({ q, cursor }) =>
      positionPickerPage(
        await readReadingPositionPage(main, { work: iri(9999), q, cursor: cursor ?? undefined }),
        '/wiki?cursor=record-page',
        'en',
        null,
      ),
    );
    await source.search('Chapter');
    await source.more();
    expect(source.getSnapshot()).toMatchObject({
      error: true,
      nextCursor: 'beyond-1501',
      items: [{ value: uuid(1501), label: 'Chapter 1501' }],
    });
    await source.retry();
    expect(calls.map((call) => [call.q, call.cursor])).toEqual([
      ['Chapter', undefined],
      ['Chapter', 'beyond-1501'],
      ['Chapter', 'beyond-1501'],
    ]);
    expect(source.getSnapshot().items.map((choice) => choice.value)).toEqual([
      uuid(1501),
      uuid(2400),
    ]);
    expect(source.getSnapshot()).toMatchObject({ complete: true, error: false, nextCursor: null });
  });
  test('names retain content language, number-only positions remain selectable and choosing drops a record cursor', () => {
    const items = [
      item(1, [
        { value: 'Opening', language: 'en' },
        { value: '雪の章', language: 'ja' },
      ]),
      item(2, []),
      { ...item(3, []), displayLabel: '第三幕' },
    ];
    const choices = positionPickerPage(
      { items, nextCursor: 'next', complete: false },
      '/wiki?sort=newest&cursor=old&position=all#cast',
      'ja',
      uuid(1),
    );
    expect(choices.items[0]).toMatchObject({
      label: '雪の章',
      text: { lang: 'ja', dir: 'ltr' },
      current: true,
      href: `/wiki?sort=newest&position=${uuid(1)}#cast`,
    });
    expect(choices.items[1]).toMatchObject({ label: '2', text: { lang: '' } });
    expect(choices.items[2]).toMatchObject({ label: '第三幕', text: { lang: '' } });
    expect(choices).toMatchObject({ nextCursor: 'next', complete: false });
  });
  test('changing search starts a new remote traversal, including a chapter past a thousand positions', async () => {
    const queries: Record<string, unknown>[] = [];
    const main = client(async (query) => {
      queries.push(query);
      return {
        data: query.q === '2400' ? page([item(2400)]) : page([item(1)], 'twenty'),
        error: null,
      };
    });
    const source = new EntityPickerSource(async ({ q, cursor }) =>
      positionPickerPage(
        await readReadingPositionPage(main, { work: iri(9999), q, cursor: cursor ?? undefined }),
        '/wiki',
        'en',
        null,
      ),
    );
    await source.search('');
    await source.search('2400');
    expect(queries.map((query) => [query.q, query.cursor])).toEqual([
      ['', undefined],
      ['2400', undefined],
    ]);
    expect(source.getSnapshot()).toMatchObject({
      items: [{ label: 'Chapter 2400' }],
      complete: true,
    });
  });
  test('stale continuations and denied reads fail rather than returning an empty or widened list', async () => {
    for (const status of [401, 403, 409]) {
      let calls = 0;
      const main = client(async () => {
        calls++;
        return { data: null, error: { status } };
      });
      await expect(
        readReadingPositionPage(main, { work: iri(9999), q: 'chapter', cursor: 'old' }),
      ).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    }
  });
  test('a first-page basis change retries once, and nonprogressing or contradictory pages fail', async () => {
    let calls = 0;
    const main = client(async () =>
      ++calls === 1
        ? { data: null, error: { status: 409 } }
        : { data: page([item(1)]), error: null },
    );
    expect((await readReadingPositionPage(main, { work: iri(9999) })).items).toHaveLength(1);
    expect(calls).toBe(2);
    for (const broken of [
      { ...page([]), complete: false },
      { ...page([]), complete: false, nextCursor: 'same' },
      { ...page([]), nextCursor: 'same' },
    ]) {
      await expect(
        readReadingPositionPage(
          client(async () => ({ data: broken, error: null })),
          { work: iri(9999), cursor: 'same' },
        ),
      ).rejects.toBeInstanceOf(PositionReadError);
    }
  });
});
