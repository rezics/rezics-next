import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resourceHref, spaceHref } from '../features/address/path.ts';
import { copyOf } from '../features/entity-page/messages.ts';
import { followHref, queryOfHref } from '../features/entity-page/href.ts';
import { ProjectionFactsView, reachOf } from '../features/entity-page/projection-views.tsx';
import { StatementsView } from '../features/entity-page/views.tsx';
import { standaloneHrefFor } from '../features/entity-page/route.ts';
import * as entityFixture from '../features/entity-page/fixtures.ts';
import type { StatementItem, StatementPage } from '../features/entity-page/types.ts';
import { messages as workMessages } from '../features/work-page/messages.ts';
import { keepReading } from '../features/wiki/links.ts';
import { continuityParam, offContinuity, parseContinuity } from '../features/wiki/continuity.ts';
import type { MainClient } from '../features/discover/types.ts';
import { nameOccurrences } from '../features/scoped-rating/occurrence-names.ts';
import { MAX_RELEASE_PAGES, relatedEventSource, releaseSource } from '../features/scoped-rating/sources.ts';
import { EntityPickerSource } from '../../../packages/ui/src/components/entity-picker-state.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';

const actor = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa';
const self = resourceHref('/e/', actor);
const characters = spaceHref('wiki', 'site', ['characters']);
const withMatch = (item: StatementItem, match: { dimensions: number; exact: number }): StatementItem =>
  ({ ...item, frameMatch: { ...match, score: match.dimensions * 16 + match.exact } }) as StatementItem;

describe('a place’s facts', () => {
  const base = entityFixture.statements();
  const items = base.groups.flatMap(group => group.items);
  const page = (list: StatementItem[]): StatementPage => ({ ...base, groups: list.map(item => ({ predicate: item.predicate ?? 'https://schema.org/name', items: [item] })) });
  const html = (list: StatementItem[]) => renderToStaticMarkup(createElement(ProjectionFactsView, { page: { ok: true, data: page(list) },
    names: new Map(), cursor: undefined, hrefFor: standaloneHrefFor({}, self), t: copyOf('en'), messages: workMessages.en }));

  test('a claim’s reach is how many of the place’s own coordinates it names, then how many kinds of place it constrains', () => {
    expect(reachOf(withMatch(items[0]!, { dimensions: 2, exact: 1 }))).toBe('here');
    expect(reachOf(withMatch(items[0]!, { dimensions: 1, exact: 0 }))).toBe('wider');
    expect(reachOf(withMatch(items[0]!, { dimensions: 0, exact: 0 }))).toBe('everywhere');
    // A read that carried no match (an unframed one) makes no claim about reach.
    expect(reachOf(items[0]!)).toBe('everywhere');
  });

  test('facts keep Main’s order and are set out by reach, the most specific first, whatever order they came in', () => {
    const out = html([withMatch(items[0]!, { dimensions: 0, exact: 0 }), withMatch(items[1]!, { dimensions: 1, exact: 0 }),
      withMatch(items[2]!, { dimensions: 2, exact: 1 })]);
    const order = [...out.matchAll(/data-fact-reach="(\w+)"/g)].map(match => match[1]);
    expect(order).toEqual(['here', 'wider', 'everywhere']);
    expect(out).toContain('Stated for this exact place');
    expect(out).toContain('Holds everywhere');
  });

  test('a reach nothing is stated for draws no heading, and a place with no facts says so quietly', () => {
    expect(html([withMatch(items[0]!, { dimensions: 1, exact: 0 })])).not.toContain('data-fact-reach="here"');
    expect(html([])).toContain('No statements yet');
  });

  test('a failed read says so in the section and offers the way back to the first page', () => {
    const out = renderToStaticMarkup(createElement(ProjectionFactsView, { page: { ok: false, failure: 'moved' }, names: new Map(),
      cursor: 'c2', hrefFor: standaloneHrefFor({ statements: 'c2' }, self), t: copyOf('en'), messages: workMessages.en }));
    expect(out).toContain('Statements could not be loaded.');
    expect(out).toContain(self);
  });
});

describe('a section link keeps the frames it names', () => {
  test('a repeated key is one array, the way the client sends it', () => {
    expect(queryOfHref('/v1/resources/a/statements?frame=x&frame=y&position=all')).toEqual({ frame: ['x', 'y'], position: 'all' });
    expect(queryOfHref('/v1/resources/a/statements')).toEqual({});
  });

  test('the section’s own query is added to the link’s and wins, and an undefined value never erases one', async () => {
    const seen: unknown[] = [];
    // `followHref` walks the link's path through the client, so plain nested objects stand in for it.
    const walk = { v1: { resources: { a: { statements: { get: async (options: { query: unknown }) => { seen.push(options.query); return { data: {}, error: null }; } } } } } };
    await followHref(walk, '/v1/resources/a/statements?frame=x&frame=y&position=all', { actingSubject: actor, cursor: undefined, position: undefined })();
    expect(seen[0]).toEqual({ frame: ['x', 'y'], position: 'all', actingSubject: actor });
    await followHref(walk, '/v1/resources/a/statements', { frame: ['c'] })();
    expect(seen[1]).toEqual({ frame: ['c'] });
  });
});

describe('a Zone keeps the reader’s place in every link', () => {
  const canon = '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0d';
  const at = { kind: 'at' as const, continuity: canon };
  test('the position and the continuity travel together, and a default is never written', () => {
    const site = { choice: { kind: 'all' as const }, continuity: { choice: at, fallback: offContinuity } };
    expect(keepReading(site, characters)).toBe(`${characters}?position=all&continuity=${canon}`);
    const defaulted = { choice: { kind: 'default' as const }, continuity: { choice: at, fallback: at } };
    expect(keepReading(defaulted, characters)).toBe(characters);
    // Turning the Zone's default off is something the address must say.
    const turnedOff = { choice: { kind: 'default' as const }, continuity: { choice: offContinuity, fallback: at } };
    expect(keepReading(turnedOff, characters)).toBe(`${characters}?continuity=off`);
    expect(keepReading({ choice: { kind: 'default' as const } }, self)).toBe(self);
  });

  test('the choice an address carries outranks the default, and `off` is a choice', () => {
    expect(parseContinuity({ continuity: 'off' }, at)).toEqual(offContinuity);
    expect(continuityParam(offContinuity, at)).toBe('off');
  });
});

describe('places a subject can be rated in', () => {
  const place = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000e1';
  const match = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000e2';
  const map = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000e3';
  const named = (iri: string, value: string, frameDimension?: string) => ({ data: { registry: { frameDimension },
    summary: { status: 'available', reference: iri, name: { value, language: 'en', direction: 'ltr' } } }, error: null });
  const pages = new Map([[match.slice(-36), named(match, 'Harbor Invitational', 'event')], [map.slice(-36), named(map, 'Haven', 'event')]]);

  function fakeMain(options: { statements: unknown; incoming?: unknown; rated?: { frames: string[] }[] }) {
    const calls: { name: string; body?: unknown }[] = [];
    const resources = (target: { resource: string }) => ({
      page: { get: async () => pages.get(target.resource) ?? { data: null, error: { status: 404 } } },
      statements: { get: async () => ({ data: options.statements, error: null }) },
    });
    const main = { v1: { resources, projections: { get: async () => ({ data: { items: options.rated ?? [] }, error: null }) },
      graph: { queries: { post: async (body: unknown) => { calls.push({ name: 'graph', body }); return options.incoming === null ? { data: null, error: { status: 422 } } : { data: options.incoming ?? { claims: [] }, error: null }; } } } } };
    return { main: (() => main) as unknown as () => MainClient, calls };
  }
  const aboutMatch = { groups: [{ predicate: 'x', items: [{ kind: 'statement', value: { kind: 'resource', iri: match } }] }] };

  test('the events a subject takes part in, and the parts of them, are offered by name', async () => {
    const { main, calls } = fakeMain({ statements: aboutMatch, incoming: { claims: [{ subject: map }, { subject: place }] } });
    const loaded = await relatedEventSource({ subject: place, actingSubject: actor, main }).load({ q: '', cursor: null });
    expect(loaded.items.map(item => item.label)).toEqual(['Harbor Invitational', 'Haven']);
    expect(loaded.items.every(item => item.candidate.dimension === 'event')).toBe(true);
    // The match is asked about once, as the one who points at it: who is part of it.
    expect(calls).toEqual([{ name: 'graph', body: { profile: 'statement-graph-v1', actingSubject: actor, anchor: match, direction: 'incoming' } }]);
    const found = await relatedEventSource({ subject: place, actingSubject: actor, main }).load({ q: 'hav', cursor: null });
    expect(found.items.map(item => item.label)).toEqual(['Haven']);
  });

  test('the events a subject has been rated in are offered even where the reverse read refuses', async () => {
    const { main } = fakeMain({ statements: aboutMatch, incoming: null, rated: [{ frames: [map] }, { frames: [match, map] }] });
    const loaded = await relatedEventSource({ subject: place, actingSubject: actor, main }).load({ q: '', cursor: null });
    expect(loaded.items.map(item => item.label)).toEqual(['Harbor Invitational', 'Haven']);
  });

  test('a reader who is not signed in is offered the events the subject names, and no one else’s', async () => {
    const { main, calls } = fakeMain({ statements: aboutMatch, incoming: { claims: [{ subject: map }] } });
    const loaded = await relatedEventSource({ subject: place, main }).load({ q: '', cursor: null });
    expect(loaded.items.map(item => item.label)).toEqual(['Harbor Invitational']);
    expect(calls).toEqual([]);
  });

  test('a resource that is not an event is not offered as one, and an unreadable subject offers nothing', async () => {
    const { main } = fakeMain({ statements: { groups: [{ predicate: 'x', items: [{ kind: 'statement', value: { kind: 'resource', iri: place } }] }] } });
    expect((await relatedEventSource({ subject: place, actingSubject: actor, main }).load({ q: '', cursor: null })).items).toEqual([]);
    expect((await relatedEventSource({ subject: 'not-an-iri', actingSubject: actor, main }).load({ q: '', cursor: null })).items).toEqual([]);
  });

  test('the releases of a Work are the game versions or editions a rating can be in, and each source has its own key', async () => {
    const work = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000c1';
    const release = { id: 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000d1', title: { value: 'Summer balance', language: 'en' } };
    const main = (() => ({ v1: { works: () => ({ releases: { get: async () => ({ data: { items: [release], nextCursor: null }, error: null }) } }) } })) as unknown as () => MainClient;
    const source = releaseSource({ work, main });
    expect(source.dimension).toBe('release');
    expect((await source.load({ q: '', cursor: null })).items[0]).toMatchObject({ value: release.id, label: 'Summer balance',
      candidate: { dimension: 'release', iri: release.id } });
    expect(source.id).not.toBe(releaseSource({ work: fixture.subject.iri, main }).id);
  });

  describe('a title search over pages that do not match', () => {
    const work = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000c1';
    const releaseId = (n: number) => `https://rezics.com/id/019a5c00-0000-7000-8000-${String(n).padStart(12, '0')}`;
    /**
     * One page of titles per entry. A token names the entry's index and the read it came from, which changes each time a
     * call is refused, as Main's cursors change with the basis they were issued on. `refuse` answers a call with an error.
     */
    function pagedReleases(pages: string[][], refuse?: (call: number, cursor: string | undefined) => { status: number; value: unknown } | null) {
      const cursors: (string | undefined)[] = [];
      let read = 0;
      const main = (() => ({ v1: { works: () => ({ releases: { get: async ({ query }: { query: { cursor?: string } }) => {
        const refused = refuse?.(cursors.length, query.cursor);
        cursors.push(query.cursor);
        if (refused) {
          read++;
          return { data: null, error: refused };
        }
        const index = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
        return { data: { items: pages[index]!.map((title, at) => ({ id: releaseId(index * 100 + at), title: { value: title, language: 'en' } })),
          nextCursor: index + 1 < pages.length ? `${index + 1}.${read}` : null }, error: null };
      } } }) } })) as unknown as () => MainClient;
      return { cursors, source: releaseSource({ work, main }) };
    }
    const unavailable = { status: 503, value: null };
    const moved = { status: 409, value: { code: 'read_basis_changed' } };
    const invalidCursor = { status: 400, value: { code: 'invalid_work_read' } };
    const manyPages = () => {
      const pages = Array.from({ length: MAX_RELEASE_PAGES + 2 }, (_, index) => [`Page ${index}`]);
      pages[MAX_RELEASE_PAGES + 1] = ['Summer balance'];
      return pages;
    };

    test('a first page with no match is followed by the page that has one', async () => {
      const { cursors, source } = pagedReleases([['Alpha', 'Beta'], ['Gamma', 'Summer balance']]);
      const loaded = await source.load({ q: 'balance', cursor: null });
      expect(loaded.items.map(item => item.label)).toEqual(['Summer balance']);
      expect(loaded.complete).toBe(true);
      expect(cursors).toEqual([undefined, '1.0']);
    });

    test('an empty filter reads one page and keeps the next token', async () => {
      const { cursors, source } = pagedReleases([['Alpha'], ['Beta']]);
      const loaded = await source.load({ q: '', cursor: null });
      expect(loaded.items.map(item => item.label)).toEqual(['Alpha']);
      expect([loaded.nextCursor, loaded.complete]).toEqual(['1.0', false]);
      expect(cursors).toEqual([undefined]);
    });

    test('past the bound the picker is left with the next token, and offering it reaches the match', async () => {
      const { cursors, source } = pagedReleases(manyPages());
      const picker = new EntityPickerSource(source.load);
      await picker.search('balance');
      expect(picker.getSnapshot()).toMatchObject({ items: [], complete: false, nextCursor: `${MAX_RELEASE_PAGES}.0`, error: false });
      expect(cursors).toHaveLength(MAX_RELEASE_PAGES);
      await picker.more();
      expect(picker.getSnapshot().items.map(item => item.label)).toEqual(['Summer balance']);
      expect(picker.getSnapshot().complete).toBe(true);
    });

    test('a page that cannot be read is an error to retry, not an empty result', async () => {
      await expect(pagedReleases([['Alpha']], () => unavailable).source.load({ q: 'x', cursor: null })).rejects.toThrow();
      const midway = pagedReleases([['Alpha'], ['Beta'], ['Summer balance']], call => call === 1 ? unavailable : null);
      const picker = new EntityPickerSource(midway.source.load);
      await picker.search('zzz');
      expect(picker.getSnapshot()).toMatchObject({ items: [], error: true });
    });

    test.each([['moved under the read', moved], ['no longer accepts the cursor', invalidCursor]])(
      'a read Main %s restarts from the first page, never from the stale cursor', async (_reason, answer) => {
        const stale = `${MAX_RELEASE_PAGES}.0`;
        let refusals = 0;
        const { cursors, source } = pagedReleases(manyPages(), (_call, cursor) => cursor === stale && refusals++ === 0 ? answer : null);
        const picker = new EntityPickerSource(source.load);
        await picker.search('balance');
        expect(picker.getSnapshot().nextCursor).toBe(stale);
        const before = cursors.length;
        await picker.more();
        // The refused cursor is sent once; the same call then reads again from the first page.
        expect(cursors.slice(before, before + 2)).toEqual([stale, undefined]);
        expect(cursors.filter(cursor => cursor === stale)).toHaveLength(1);
        expect(picker.getSnapshot()).toMatchObject({ error: false, nextCursor: `${MAX_RELEASE_PAGES}.1` });
        await picker.more();
        expect(picker.getSnapshot().items.map(item => item.label)).toEqual(['Summer balance']);
      });

    test('a read that is refused again after its restart is an error, and an invalid first page is not retried', async () => {
      const always = pagedReleases(manyPages(), () => moved);
      await expect(always.source.load({ q: 'balance', cursor: null })).rejects.toThrow();
      expect(always.cursors).toEqual([undefined, undefined]);
      const first = pagedReleases(manyPages(), () => invalidCursor);
      await expect(first.source.load({ q: 'balance', cursor: null })).rejects.toThrow();
      expect(first.cursors).toEqual([undefined]);
    });
  });
});

describe('episodes are named as their story names them', () => {
  const structure = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000f1';
  const [one, two] = [fixture.placeEpisode1, fixture.placeEpisode2];
  const occurrenceOf = (read: typeof one) => read.summary?.status === 'available' ? read.summary.parts!.frames[0]!.reference : '';
  function fakeMain(labels: Record<string, { value: string; language: string }[]>) {
    const calls: string[] = [];
    const main = { v1: {
      resources: (_: unknown) => ({ parts: { get: async () => { calls.push('parts'); return { data: { structure }, error: null }; } } }),
      compositions: (_: unknown) => ({ get: async () => { calls.push('composition');
        return { data: { occurrences: Object.entries(labels).map(([occurrence, list]) => ({ occurrence, state: 'active', labels: list })), next: null }, error: null }; } }),
    } };
    return { main: main as unknown as MainClient, calls };
  }

  test('each frame takes its label in the reader’s language, from one read of the Work’s order', async () => {
    const { main, calls } = fakeMain({
      [occurrenceOf(one!)]: [{ value: 'Episode 1', language: 'en' }, { value: '第1話', language: 'ja' }],
      [occurrenceOf(two!)]: [{ value: 'Episode 2', language: 'en' }],
    });
    const named = await nameOccurrences(main, [one!.summary, two!.summary], 'ja', actor);
    const frame = (summary: (typeof named)[number]) => summary?.status === 'available' ? summary.parts!.frames[0]!.name : null;
    expect(frame(named[0]!)).toMatchObject({ value: '第1話', language: 'ja' });
    // No label in the reader's language: the one it was written in, never the Work's name.
    expect(frame(named[1]!)).toMatchObject({ value: 'Episode 2', language: 'en' });
    expect(calls).toEqual(['parts', 'composition']);
  });

  test('a frame with no readable label keeps the name it came with, and a read that fails is not an error', async () => {
    const { main } = fakeMain({});
    const kept = await nameOccurrences(main, [one!.summary], 'en');
    expect(kept[0]).toEqual(one!.summary);
    const broken = (() => { throw new Error('offline'); }) as unknown as MainClient;
    expect(await nameOccurrences(broken, [one!.summary], 'en').catch(() => 'threw')).toEqual([one!.summary]);
  });
});

describe('an owner’s own property', () => {
  test('names and links the resource it points at, instead of printing its record', () => {
    const base = entityFixture.statements();
    const target = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000b1';
    const property = { kind: 'component-property', revision: base.resource, predicate: 'https://rezics.com/vocab/semanticWork',
      value: { kind: 'resource', ref: target }, qualifiers: { applicability: [], interpretationDefinitions: [] }, sources: [] } as unknown as StatementItem;
    const page: StatementPage = { ...base, groups: [{ predicate: property.predicate!, items: [property] }] };
    const names = new Map([[target, fixture.placeEpisode1.summary!]]);
    const out = renderToStaticMarkup(createElement(StatementsView, { page: { ok: true, data: page }, names, cursor: undefined,
      hrefFor: standaloneHrefFor({}, self), t: copyOf('en'), messages: workMessages.en }));
    expect(out).not.toContain('&quot;kind&quot;');
    expect(out).toContain('Elizabeth Bennet');
  });
});
