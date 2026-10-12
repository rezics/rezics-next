import { describe, expect, test, vi } from 'vitest';
import { direction } from '@rezics/main/language';
import type { AdaptContext } from './adapt.ts';
import { loadShelfModule, shelfWorks } from './modules.ts';
import type { ZoneRouteRead } from './types.ts';
import type { PresentationModule } from '../zones/presentation.ts';

const iri = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const collection = iri(1);
const context: AdaptContext = { locale: 'en', ref: 'harbor', realm: iri(2), zone: iri(3),
  mounts: new Map([[collection, 'reading']]) };
const module: PresentationModule = { id: 'reading-shelf', type: 'shelf', title: 'Reading',
  source: { kind: 'collection', collection }, options: { limit: 2 } };
type CollectionIndex = Extract<ZoneRouteRead, { kind: 'index' }>;
type Work = Extract<CollectionIndex['items'][number], { title: unknown }>;

function work(index: number): Work {
  const id = iri(10 + index);
  const title = `Reading ${index + 1}`;
  return { id, revision: iri(20 + index), mainVersion: iri(30 + index),
    title: { value: title, language: 'en', direction: direction('en', title), basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: id, resourceType: 'work' },
    types: [], tagline: null, completionStatus: null, chapterCount: null, wordCount: null,
    lastUpdatedAt: null, inZone: true };
}

function page(size: number, nextCursor: string | null): CollectionIndex {
  // These visible non-Work members cannot fill a shelf's selected Work window.
  const otherMembers = Array.from({ length: 2 }, (_, index) => ({ id: iri(40 + index), types: [],
    name: { value: `Guide ${index + 1}`, language: 'en', direction: direction('en', `Guide ${index + 1}`), basis: 'requested' as const },
    address: { prefix: '/e/', key: `guide-${index + 1}`, suffixSource: '' }, inZone: true }));
  return { profile: 'zone-route-v1', kind: 'index', zone: context.zone!, path: '/reading',
    name: 'Harbor', language: 'en', direction: direction('en', 'Harbor'), realm: context.realm, revision: iri(4),
    listing: 'listed', discovery: { indexable: true, robots: 'index', referrerPolicy: null },
    sourcePosition: { dataEpoch: '00000000-0000-4000-8000-000000000005', sequence: '1' },
    mount: { occurrence: iri(6), segment: 'reading', target: collection }, collection,
    items: [...otherMembers, ...Array.from({ length: size }, (_, index) => work(index))], nextCursor,
    cost: { pageSize: 24, maxNavigation: 50, immutableRangeRows: 101, membershipQueries: 1,
      mountRows: 2, typeRowsPerResource: 8, typeQueriesPerPage: 1, summaryBatch: 50,
      maxGraphReads: 2048, maxGraphBytes: 8 * 1024 * 1024, deadlineMs: 10_000 } };
}

async function load(size: number, nextCursor: string | null) {
  const route = vi.fn(async () => ({ ok: true as const, data: page(size, nextCursor) }));
  const state = await loadShelfModule(module, context, (source, context) => shelfWorks(source, context, route));
  expect(route).toHaveBeenCalledTimes(1);
  expect(route).toHaveBeenCalledWith(context.zone, '/reading');
  return state;
}

describe('Collection index to shelf window', () => {
  test.each([0, 1])('a continuing index with %i Works stays visibly failed', async size => {
    expect(await load(size, 'next-collection-page')).toEqual({ state: 'failed' });
  });

  test('a terminal index with no Works is empty', async () => {
    expect(await load(0, null)).toEqual({ state: 'empty' });
  });

  test('a terminal short index preserves its one Work', async () => {
    expect(await load(1, null)).toMatchObject({ state: 'ready', data: { tabs: [{
      items: [{ id: work(0).id }],
    }] } });
  });

  test.each([null, 'next-collection-page'])('a filled index succeeds with continuation %s', async nextCursor => {
    const state = await load(3, nextCursor);
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('The selected shelf window did not load');
    expect(state.data.tabs[0]?.items.map(item => item.id)).toEqual([work(0).id, work(1).id]);
  });
});
