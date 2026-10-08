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
import { READING_ORDER_PAGES } from './read.ts';
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
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`) {
        if (url.searchParams.get('path') === '/franchise')
          return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
        if (url.searchParams.get('path') === '/characters')
          return { kind: 'index', items: characters[url.searchParams.get('position') ?? ''] ?? [], nextCursor: null };
      }
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        const position = url.searchParams.get('position');
        if (!position) return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
        return positionPage(work, iri(last), [
          chapterItem(first, work, structure, 'Chapter 1'),
          chapterItem(middle, work, structure, 'Chapter 2'),
          chapterItem(last, work, structure, 'Chapter 3'),
        ], 'positions', null);
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
    expect(state?.readingOrder).toBe(state?.chooser.items);
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
    const positions = double!.calls.filter((call) => call.url.pathname.includes('/reading-positions/'));
    expect(positions.map((call) => call.url.searchParams.get('position'))).toEqual([null, iri(last)]);
  });

  test('a chapter the order omits is not linked, and a chapter with no disclosed name is skipped', async () => {
    const zone = 210;
    const work = 211;
    const structure = 212;
    const first = 213;
    const hidden = 214;
    const unnamed = 215;
    const last = 216;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes` && url.searchParams.get('path') === '/franchise')
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (!url.searchParams.get('position'))
          return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
        return positionPage(work, iri(last), [
          chapterItem(first, work, structure, 'Chapter 1'),
          chapterItem(unnamed, work, structure, undefined, 2),
          chapterItem(last, work, structure, 'Chapter 3'),
        ], 'positions', null);
      }
      if (url.pathname === `/v1/compositions/${uuid(structure)}`)
        return { occurrences: [{ occurrence: iri(last), state: 'active', labels: labels('Chapter 3') }], next: null };
      return 404;
    });
    const { state, lastPage, unnamedPage } = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const open = (id: number) => state ? buildEntity({
        id: uuid(id), locale: 'en', projection: projection(id), site: siteOf(zone), fullPage: entityHref(uuid(id)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { state, lastPage: await open(last), unnamedPage: await open(unnamed) };
    }, { signedIn: true });
    const neighbourNames = [lastPage?.chapter?.previous?.name.value, lastPage?.chapter?.next?.name.value];
    expect(neighbourNames).toEqual(['Chapter 1', undefined]);
    expect(neighbourNames).not.toContain('Chapter 2');
    expect(neighbourNames).not.toContain('2');
    expect(neighbourNames).not.toContain(uuid(hidden));
    expect(unnamedPage?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(unnamedPage?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(state?.chooser.items.map((item) => item.occurrence)).toEqual([iri(last)]);
  });

  test('the chapter still opens when the reading order cannot be read', async () => {
    const zone = 310;
    const work = 311;
    const structure = 312;
    const last = 313;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (!url.searchParams.get('position'))
          return positionPage(work, iri(last), [chapterItem(last, work, structure, 'Chapter 3')], 'resume', null);
        return 503;
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
    expect(page.state?.readingOrder).toBe(page.state?.chooser.items);
    expect(page.entity?.chapter).toMatchObject({ reached: true, previous: null, next: null });
  });

  test('the order read stops once the next chapter is in hand', async () => {
    const zone = 410;
    const work = 411;
    const structure = 412;
    const early = 413;
    const last = 414;
    const after = 415;
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        const cursor = url.searchParams.get('cursor');
        if (!url.searchParams.get('position'))
          return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
        if (!cursor) return positionPage(work, iri(last), [chapterItem(early, work, structure, 'Chapter 1')], 'positions', 'page-2');
        if (cursor === 'page-2') return positionPage(work, iri(last), [
          chapterItem(last, work, structure, 'Chapter 3'),
          chapterItem(after, work, structure, 'Chapter 4'),
        ], 'positions', 'page-3');
        return 503;
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
    expect(page.entity?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(page.entity?.chapter?.next?.name.value).toBe('Chapter 4');
    const cursors = double!.calls
      .filter((call) => call.url.pathname.includes('/reading-positions/'))
      .map((call) => call.url.searchParams.get('cursor'));
    expect(cursors).toEqual([null, null, 'page-2']);
    expect(cursors).not.toContain('page-3');
  });

  test('an order that stops before the reader still opens that chapter and keeps earlier ones reached', async () => {
    const zone = 510;
    const work = 511;
    const structure = 512;
    const readerAt = 513;
    const early = Array.from({ length: READING_ORDER_PAGES }, (_, index) => 520 + index);
    double = mainDouble((url) => {
      if (url.pathname === `/v1/zones/${uuid(zone)}/routes`)
        return { kind: 'index', items: [{ id: iri(work), title: name('Franchise') }], nextCursor: null };
      if (url.pathname === `/v1/reading-positions/${uuid(work)}`) {
        if (!url.searchParams.get('position'))
          return positionPage(work, iri(readerAt), [chapterItem(readerAt, work, structure, 'Chapter 99')], 'resume', null);
        const cursor = url.searchParams.get('cursor');
        const index = cursor ? Number(cursor) : 0;
        if (index >= READING_ORDER_PAGES) return 503;
        return positionPage(work, iri(readerAt), [chapterItem(early[index]!, work, structure, `Earlier ${index + 1}`)],
          'positions', String(index + 1));
      }
      return 404;
    });
    const page = await pageRequest(async () => {
      const state = await loadPosition(uuid(zone), 'franchise', '');
      const open = (id: number) => state ? buildEntity({
        id: uuid(id), locale: 'en', projection: projection(id), site: siteOf(zone), fullPage: entityHref(uuid(id)),
        state, mount: 'chapters', lists: [],
      }) : null;
      return { state, current: await open(readerAt), first: await open(early[0]!) };
    }, { signedIn: true });
    expect(page.current?.chapter).toMatchObject({ reached: true, previous: null, next: null });
    expect(page.first?.chapter?.reached).toBe(true);
    expect(page.first?.chapter?.next?.name.value).toBe('Earlier 2');
    const orderCalls = double!.calls.filter((call) => call.url.pathname.includes('/reading-positions/')
      && call.url.searchParams.get('position'));
    expect(orderCalls).toHaveLength(READING_ORDER_PAGES);
  });

  test('an unstarted reader uses the opening page and does not read it again', async () => {
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
        if (url.searchParams.get('position')) return 503;
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
    expect(page.state?.readingOrder).toBe(page.state?.chooser.items);
    expect(page.entity?.chapter?.previous?.name.value).toBe('Chapter 1');
    expect(page.entity?.chapter?.next?.name.value).toBe('Chapter 3');
    expect(double!.calls.filter((call) => call.url.pathname.includes('/reading-positions/'))).toHaveLength(1);
  });

  test('a character page reads its relations before the resumed reading order', async () => {
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
        if (!url.searchParams.get('position'))
          return positionPage(work, iri(last), [chapterItem(last, work, structure)], 'resume', null);
        return positionPage(work, iri(last), [
          chapterItem(first, work, structure, 'Chapter 1'),
          chapterItem(last, work, structure, 'Chapter 3'),
        ], 'positions', null);
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
    expect(page.state?.chooser.items).toHaveLength(1);
    const order = double!.calls.map((call) => call.url.pathname);
    const relationsAt = order.findIndex((path) => path.endsWith('/relations'));
    const widenedAt = double!.calls.findIndex((call) => call.url.pathname.includes('/reading-positions/')
      && call.url.searchParams.get('position'));
    expect(relationsAt).toBeGreaterThanOrEqual(0);
    expect(widenedAt).toBeGreaterThan(relationsAt);
  });
});
