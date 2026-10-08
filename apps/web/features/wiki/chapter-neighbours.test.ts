import { afterEach, describe, expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { mainDouble, pageRequest } from '../entity-page/request-fixture.ts';
import { entityHref } from '../entity-page/route.ts';
import type { EntityProjection } from '../entity-page/types.ts';
import { iriOf } from '../work-page/route.ts';
import { zoneContentText } from '../language/untagged.ts';
import { buildEntity } from './entity.ts';
import type { ZoneSite } from './links.ts';
import { loadPosition, positionOptions } from './state.ts';

let double: ReturnType<typeof mainDouble> | undefined;
afterEach(() => double?.restore());

const uuid = (n: number) => `01944200-0000-7000-8000-${String(n).padStart(12, '0')}`;
const iri = (n: number) => iriOf(uuid(n));
const name = (value: string) => ({ value, language: 'en', direction: direction('en', value), basis: 'requested' as const });
const here = localizedPath(spaceHref('franchise-wiki', 'site'), 'en');
const labels = (value: string) => [{ value, language: 'en' }];

function chapterItem(id: number, work: number, structure: number, title?: string, ordinal?: number) {
  return {
    occurrence: iri(id), work: iri(work), structure: iri(structure), revision: iri(structure), parent: iri(structure),
    segmentKey: 'main', orderKey: String(id), role: 'chapter' as const, target: 'https://schema.org/DigitalDocument',
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(title ? { labels: labels(title) } : { labels: [] as { value: string; language: string }[] }),
  };
}

function positionPage(work: number, resolved: string, items: ReturnType<typeof chapterItem>[], scope: 'resume' | 'positions',
  nextCursor: string | null) {
  return {
    profile: 'reading-positions-v1', work: iri(work), resolved, scope, items, nextCursor, next: nextCursor,
    complete: nextCursor === null,
  };
}

type Item = ReturnType<typeof chapterItem>;
type Side = Item | 'bound' | null;
const step = (side: Side) => side === null ? { status: 'none' } : side === 'bound' ? { status: 'bound' }
  : { status: 'found', occurrence: side.occurrence };

/** Main's answer to `around`: the chapters either side, whether the position has reached it, and the found items. */
function aroundPage(work: number, around: number, previous: Side, next: Side, reached = true) {
  const items = [previous, next].filter((side): side is Item => typeof side === 'object' && side !== null);
  return {
    profile: 'reading-positions-v1', work: iri(work), resolved: iri(around), scope: 'neighbours', items,
    nextCursor: null, next: null, complete: true,
    neighbours: { previous: step(previous), next: step(next), reached },
  };
}

/** Main's answer to `firstSeen`. */
function appearancePage(work: number, found: Item | null) {
  return {
    profile: 'reading-positions-v1', work: iri(work), resolved: 'start', scope: 'first-appearance',
    items: found ? [found] : [], nextCursor: null, next: null, complete: true,
    appearance: found ? step(found) : { status: 'none' },
  };
}

const aroundOf = (url: URL) => url.searchParams.get('around');
const aroundCalls = (calls: { url: URL }[]) => calls.filter((call) => aroundOf(call.url));

function projection(id: number): EntityProjection {
  return {
    target: { resource: iri(id), base: 'occurrence', types: [] }, registry: { default: true },
    summary: { status: 'available', reference: iri(id), type: 'occurrence', base: 'occurrence', name: name('Chapter') },
    sections: [],
  } as unknown as EntityProjection;
}

const siteOf = (zone: number): ZoneSite => ({
  zone: uuid(zone), ref: 'franchise-wiki', segments: ['chapters', 'characters'],
  choice: { kind: 'default' }, main: undefined,
});

const lists = [{ segment: 'characters', name: zoneContentText('Characters') }];

function member(id: number, value: string) {
  return { id: iri(id), name: name(value), types: [] as string[] };
}

describe('Chapter neighbours', () => {
  test('a resumed middle chapter links the previous and next chapters, and an earlier chapter still reveals', async () => {
    const zone = 110;
    const work = 111;
    const structure = 112;
    const first = 113;
    const middle = 114;
    const last = 115;
    const elizabeth = 116;
    const darcy = 117;
    const characters: Record<string, ReturnType<typeof member>[]> = {
      [iri(first)]: [member(elizabeth, 'Elizabeth')],
      [iri(middle)]: [member(elizabeth, 'Elizabeth')],
      [iri(last)]: [member(elizabeth, 'Elizabeth'), member(darcy, 'Darcy')],
    };
    const chapters = {
      [first]: chapterItem(first, work, structure, 'Chapter 1'),
      [middle]: chapterItem(middle, work, structure, 'Chapter 2'),
      [last]: chapterItem(last, work, structure, 'Chapter 3'),
    };
    const around: Record<string, ReturnType<typeof aroundPage>> = {
      [iri(first)]: aroundPage(work, first, null, chapters[middle]),
      [iri(middle)]: aroundPage(work, middle, chapters[first], chapters[last]),
      [iri(last)]: aroundPage(work, last, chapters[middle], null),
    };
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`) {
        if (url.searchParams.get('path') === '/franchise')
          return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
        if (url.searchParams.get('path') === '/characters')
          return { kind: 'index', items: characters[url.searchParams.get('position') ?? ''] ?? [], nextCursor: null };
      }
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        const asked = aroundOf(url);
        if (asked) return around[asked] ?? 404;
        return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
      }
      if (url.pathname === `/v1/compositions/${uuid(structure)}`)
        return { occurrences: [{ occurrence: iri(last), state: 'active', labels: labels('Chapter 3') }], next: null };
      return 404;
    });
    const { state, middlePage, lastPage, firstPage } = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const open = (id: number) => state ? buildEntity({
        id: uuid(id), locale: 'en', projection: projection(id), site: siteOf(zone), fullPage: entityHref(uuid(id)),
        state, mount: 'chapters', lists,
      }) : null;
      return { state, middlePage: await open(middle), lastPage: await open(last), firstPage: await open(first) };
    }, { signedIn: true });
    expect(state?.chooser.scope).toBe('resume');
    expect(state?.chooser.items).toHaveLength(1);
    expect(positionOptions(state!, here, 'en').map((option) => option.label.value)).toEqual(['Chapter 3']);
    expect(middlePage?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(middlePage?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(middlePage?.chapter?.reached).toBe(true);
    expect(lastPage?.chapter?.previous?.name.value).toBe('Chapter 2');
    expect(lastPage?.chapter?.next).toBeNull();
    expect(lastPage?.chapter?.reveals.flatMap((list) => list.members.map((item) => item.name.value))).toEqual(['Darcy']);
    expect(firstPage?.chapter?.previous).toBeNull();
    expect(firstPage?.chapter?.next?.name.value).toBe('Chapter 2');
    expect(firstPage?.chapter?.reached).toBe(true);
    expect(firstPage?.chapter?.reveals.flatMap((list) => list.members.map((item) => item.name.value))).toEqual(['Elizabeth']);
    // One resume read for the control, then one bounded read per chapter page.
    const positions = double!.calls.filter((call) => call.url.pathname.includes('/reading-positions/'));
    expect(positions.map((call) => aroundOf(call.url))).toEqual([null, iri(middle), iri(last), iri(first)]);
    for (const call of aroundCalls(positions)) expect(call.url.searchParams.get('cursor')).toBeNull();
  });

  test('a chapter with no disclosed name is skipped, and a chapter the reader may not see has no page chapter', async () => {
    const zone = 210;
    const work = 211;
    const structure = 212;
    const first = 213;
    const hidden = 214;
    const unnamed = 215;
    const last = 216;
    const chapters = {
      [first]: chapterItem(first, work, structure, 'Chapter 1'),
      [unnamed]: chapterItem(unnamed, work, structure, undefined, 2),
      [last]: chapterItem(last, work, structure, 'Chapter 3'),
    };
    const around: Record<string, ReturnType<typeof aroundPage>> = {
      [iri(first)]: aroundPage(work, first, null, chapters[unnamed]),
      [iri(unnamed)]: aroundPage(work, unnamed, chapters[first], chapters[last]),
      [iri(last)]: aroundPage(work, last, chapters[unnamed], null),
    };
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes` && url.searchParams.get('path') === '/franchise')
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        const asked = aroundOf(url);
        if (asked) return around[asked] ?? 404;
        return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
      }
      if (url.pathname === `/v1/compositions/${uuid(structure)}`)
        return { occurrences: [{ occurrence: iri(last), state: 'active', labels: labels('Chapter 3') }], next: null };
      return 404;
    });
    const { state, firstPage, lastPage, unnamedPage, hiddenPage } = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const open = (id: number) => state ? buildEntity({
        id: uuid(id), locale: 'en', projection: projection(id), site: siteOf(zone), fullPage: entityHref(uuid(id)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { state, firstPage: await open(first), lastPage: await open(last), unnamedPage: await open(unnamed),
        hiddenPage: await open(hidden) };
    }, { signedIn: true });
    const neighbourNames = [lastPage?.chapter?.previous?.name.value, lastPage?.chapter?.next?.name.value];
    expect(neighbourNames).toEqual(['Chapter 1', undefined]);
    expect(neighbourNames).not.toContain('2');
    expect(neighbourNames).not.toContain(uuid(hidden));
    expect(firstPage?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(unnamedPage?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(unnamedPage?.chapter?.next?.name.value).toBe('Chapter 3');
    // Main answers a chapter the reader may not see as one that does not exist.
    expect(hiddenPage?.chapter).toBeNull();
    expect(state?.chooser.items.map((item) => item.occurrence)).toEqual([iri(last)]);
  });

  test('the chapter still opens when the neighbour read cannot be made', async () => {
    const zone = 310;
    const work = 311;
    const structure = 312;
    const last = 313;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url)) return 503;
        return positionPage(work, iri(last), [chapterItem(last, work, structure, 'Chapter 3')], 'resume', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(last), locale: 'en', projection: projection(last), site: siteOf(zone), fullPage: entityHref(uuid(last)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { state, entity };
    }, { signedIn: true });
    expect(page.entity?.chapter).toMatchObject({ reached: true, previous: null, next: null });
  });

  test('a chapter far into a long Work reads its neighbours once, however far they are from the start', async () => {
    const zone = 410;
    const work = 411;
    const structure = 412;
    const before = 413;
    const reader = 414;
    const after = 415;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url) === iri(reader)) return aroundPage(work, reader,
          chapterItem(before, work, structure, 'Chapter 239'), chapterItem(after, work, structure, 'Chapter 241'));
        if (aroundOf(url)) return 404;
        return positionPage(work, iri(reader), [chapterItem(reader, work, structure, 'Chapter 240')], 'resume', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(reader), locale: 'en', projection: projection(reader), site: siteOf(zone), fullPage: entityHref(uuid(reader)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { entity };
    }, { signedIn: true });
    expect(page.entity?.chapter?.previous?.name.value).toBe('Chapter 239');
    expect(page.entity?.chapter?.next?.name.value).toBe('Chapter 241');
    const lookups = aroundCalls(double!.calls);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.url.searchParams.get('cursor')).toBeNull();
    expect(lookups[0]!.url.searchParams.get('limit')).toBeNull();
  });

  test('a side Main could not settle within its bound is not linked, and a chapter past the reader is not reached', async () => {
    const zone = 510;
    const work = 511;
    const structure = 512;
    const readerAt = 513;
    const ahead = 514;
    const elizabeth = 515;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`) {
        if (url.searchParams.get('path') === '/franchise')
          return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
        return { kind: 'index', items: [member(elizabeth, 'Elizabeth')], nextCursor: null };
      }
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url) === iri(ahead)) return aroundPage(work, ahead, chapterItem(readerAt, work, structure, 'Chapter 99'),
          'bound', false);
        if (aroundOf(url)) return 404;
        return positionPage(work, iri(readerAt), [chapterItem(readerAt, work, structure, 'Chapter 99')], 'resume', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(ahead), locale: 'en', projection: projection(ahead), site: siteOf(zone), fullPage: entityHref(uuid(ahead)),
        state, mount: 'chapters', lists,
      }) : null;
      return { entity };
    }, { signedIn: true });
    expect(page.entity?.chapter).toMatchObject({ reached: false, reveals: [], next: null });
    expect(page.entity?.chapter?.previous?.name.value).toBe('Chapter 99');
    // A chapter that is not reached reads no list at all: Main has not revealed it.
    expect(double!.calls.filter((call) => call.url.searchParams.get('path') === '/characters')).toHaveLength(0);
  });

  test('an unstarted reader takes the opening page for the control and reads neighbours with the position it chose', async () => {
    const zone = 610;
    const work = 611;
    const structure = 612;
    const first = 613;
    const middle = 614;
    const last = 615;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url) === iri(middle)) return aroundPage(work, middle, chapterItem(first, work, structure, 'Chapter 1'),
          chapterItem(last, work, structure, 'Chapter 3'), false);
        if (aroundOf(url)) return 404;
        return positionPage(work, 'start', [
          chapterItem(first, work, structure, 'Chapter 1'),
          chapterItem(middle, work, structure, 'Chapter 2'),
          chapterItem(last, work, structure, 'Chapter 3'),
        ], 'positions', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(middle), locale: 'en', projection: projection(middle), site: siteOf(zone), fullPage: entityHref(uuid(middle)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { state, entity };
    }, { signedIn: true });
    expect(page.state?.chooser.scope).toBe('positions');
    expect(page.entity?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(page.entity?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(page.entity?.chapter?.reached).toBe(false);
    const lookups = aroundCalls(double!.calls);
    expect(lookups).toHaveLength(1);
    // The reader who has not started reads from the first chapter, and every read of the page says so.
    expect(lookups[0]!.url.searchParams.get('position')).toBe(iri(first));
  });

  test('a record page reads where it first appeared from Main, after its own relations', async () => {
    const zone = 710;
    const work = 711;
    const structure = 712;
    const first = 713;
    const last = 714;
    const elizabeth = 715;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes` && url.searchParams.get('path') === '/franchise')
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (url.searchParams.get('firstSeen') === iri(elizabeth)) return appearancePage(work, chapterItem(first, work, structure, 'Chapter 1'));
        if (aroundOf(url)) return 404;
        return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
      }
      if (url.pathname === `/v1/compositions/${uuid(structure)}`)
        return { occurrences: [{ occurrence: iri(last), state: 'active', labels: labels('Chapter 3') }], next: null };
      if (url.pathname === `/v1/resources/${uuid(elizabeth)}/relations`)
        return { items: [], next: null };
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(elizabeth), locale: 'en', projection: {
          ...projection(elizabeth),
          target: { resource: iri(elizabeth), base: 'resource', types: [] },
          sections: [{ id: 'relations', href: `/v1/resources/${uuid(elizabeth)}/relations`, actions: [] }],
        } as unknown as EntityProjection, site: siteOf(zone), fullPage: entityHref(uuid(elizabeth)),
        state, mount: 'characters', lists: [],
      }) : null;
      return { state, entity };
    }, { signedIn: true });
    expect(page.entity?.name.value).toBe('Chapter');
    expect(page.entity?.firstSeen?.name.value).toBe('Chapter 1');
    expect(page.state?.chooser.items).toHaveLength(1);
    const order = double!.calls.map((call) => call.url.pathname);
    const relationsAt = order.findIndex((path) => path.endsWith('/relations'));
    const appearedAt = double!.calls.findIndex((call) => call.url.pathname.includes('/reading-positions/')
      && call.url.searchParams.get('firstSeen'));
    expect(relationsAt).toBeGreaterThanOrEqual(0);
    expect(appearedAt).toBeGreaterThan(relationsAt);
    expect(aroundCalls(double!.calls)).toHaveLength(0);
  });

  test('a record\'s first chapter is linked by the label the appearance read returns', async () => {
    const zone = 810;
    const work = 811;
    const structure = 812;
    const first = 813;
    const last = 814;
    const elizabeth = 815;
    const appearance = {
      ...chapterItem(first, work, structure),
      labels: labels('Chapter 1'),
      displayLabel: 'Ch. 1',
    };
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes` && url.searchParams.get('path') === '/franchise')
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (url.searchParams.get('firstSeen') === iri(elizabeth)) return appearancePage(work, appearance);
        if (aroundOf(url)) return 404;
        return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
      }
      if (url.pathname === `/v1/resources/${uuid(elizabeth)}/relations`)
        return { items: [], next: null };
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(elizabeth), locale: 'en', projection: {
          ...projection(elizabeth),
          target: { resource: iri(elizabeth), base: 'resource', types: [] },
          sections: [{ id: 'relations', href: `/v1/resources/${uuid(elizabeth)}/relations`, actions: [] }],
        } as unknown as EntityProjection, site: siteOf(zone), fullPage: entityHref(uuid(elizabeth)),
        state, mount: 'characters', lists: [],
      }) : null;
      return { entity };
    }, { signedIn: true });
    expect(page.entity?.firstSeen?.name.value).toBe('Chapter 1');
    expect(page.entity?.firstSeen?.href?.startsWith('/')).toBe(true);
  });

  /** Members a complete reveal would claim. An unsettled previous side must claim none. */
  const claimed = (reveals: { complete: boolean; members: { name: { value: string } }[] }[] | undefined) =>
    (reveals ?? []).filter(list => list.complete).flatMap(list => list.members.map(member => member.name.value));

  test('a previous side the scan could not settle does not claim the list was revealed here', async () => {
    const zone = 910;
    const work = 911;
    const structure = 912;
    const middle = 913;
    const last = 914;
    const elizabeth = 915;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`) {
        if (url.searchParams.get('path') === '/franchise')
          return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
        if (url.searchParams.get('path') === '/characters')
          return { kind: 'index', items: [member(elizabeth, 'Elizabeth')], nextCursor: null };
      }
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url) === iri(middle)) return aroundPage(work, middle, 'bound',
          chapterItem(last, work, structure, 'Chapter 3'));
        if (aroundOf(url)) return 404;
        return positionPage(work, iri(middle), [chapterItem(middle, work, structure, 'Chapter 2')], 'resume', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(middle), locale: 'en', projection: projection(middle), site: siteOf(zone), fullPage: entityHref(uuid(middle)),
        state, mount: 'chapters', lists,
      }) : null;
      return { entity };
    }, { signedIn: true });
    expect(page.entity?.chapter?.reached).toBe(true);
    expect(page.entity?.chapter?.previous).toBeNull();
    expect(page.entity?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(claimed(page.entity?.chapter?.reveals)).toEqual([]);
  });

  test('a neighbour read that fails does not claim the list was revealed here', async () => {
    const zone = 1010;
    const work = 1011;
    const structure = 1012;
    const middle = 1013;
    const elizabeth = 1014;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`) {
        if (url.searchParams.get('path') === '/franchise')
          return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
        if (url.searchParams.get('path') === '/characters')
          return { kind: 'index', items: [member(elizabeth, 'Elizabeth')], nextCursor: null };
      }
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (aroundOf(url)) return 503;
        return positionPage(work, iri(middle), [chapterItem(middle, work, structure, 'Chapter 2')], 'resume', null);
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const entity = state ? await buildEntity({
        id: uuid(middle), locale: 'en', projection: projection(middle), site: siteOf(zone), fullPage: entityHref(uuid(middle)),
        state, mount: 'chapters', lists,
      }) : null;
      return { entity };
    }, { signedIn: true });
    expect(page.entity?.chapter).toMatchObject({ reached: true, previous: null, next: null });
    expect(claimed(page.entity?.chapter?.reveals)).toEqual([]);
  });
});
