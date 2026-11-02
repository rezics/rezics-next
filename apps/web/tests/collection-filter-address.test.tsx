import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectionFilterAddress, readCollectionFilterParams } from '../src/library/collection-filter-params';
import { collectionFilterSearch, readCollectionFilterAddress } from '../src/library/collection-filter-address-read';
import { CollectionFilterAddressState } from '../src/library/collection-filter-address-state';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { m } from '../src/paraglide/messages.js';

const type = 'schema:Book';
const tag = 'schema:keywords';
const count = 'schema:wordCount';
const ids = Array.from({ length: 65 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const release = {
  types: { [type]: { bases: [], facets: [tag, count] } },
  properties: { [tag]: { datatype: 'wikibase-item' }, [count]: { datatype: 'quantity', units: ['1'] } },
};
const parse = (query: URLSearchParams) => readCollectionFilterParams(query, release, type);

test('all 64 values are admitted in order; a 65th value rejects the whole facet, including duplicate overflow', () => {
  const query = new URLSearchParams(ids.slice(0, 64).map((id) => [`f.${tag}`, id]));
  expect(parse(query).selected[tag]).toEqual(ids.slice(0, 64));
  expect(parse(query).document).toEqual({ statement: { property: tag, in: ids.slice(0, 64) } });
  for (const tail of [ids[64]!, ids[0]!]) {
    const tooMany = new URLSearchParams(query);
    tooMany.append(`f.${tag}`, tail);
    tooMany.set(`r.${count}`, '0,9');
    const state = parse(tooMany);
    expect(state.document).toBeUndefined();
    expect(state.selected).toEqual({});
    expect(state.ranges[count]).toEqual({ from: 0, to: 9 });
    expect(state.issues).toEqual([{ key: `f.${tag}`, reason: 'limit' }]);
  }
});

test('repeated ranges are ambiguous even when identical; mixed invalid facets cannot broaden the read', () => {
  for (const tail of ['1,9', '2,8']) {
    const query = new URLSearchParams([
      [`f.${tag}`, ids[0]!],
      [`r.${count}`, '1,9'],
      [`r.${count}`, tail],
    ]);
    expect(parse(query)).toMatchObject({
      selected: { [tag]: [ids[0]] },
      ranges: {},
      issues: [{ reason: 'ambiguous' }],
    });
    expect(parse(query).document).toBeUndefined();
  }
  for (const invalid of ['', 'invalid']) {
    const query = new URLSearchParams([
      [`f.${tag}`, ids[0]!],
      [`f.${tag}`, invalid],
      [`r.${count}`, '0,'],
    ]);
    expect(parse(query)).toMatchObject({
      selected: {},
      ranges: { [count]: { from: 0 } },
      issues: [{ reason: 'invalid' }],
    });
    expect(parse(query).document).toBeUndefined();
  }
});

test('display hints cannot hide a predicate after the old transport field limit or change filter meaning', () => {
  const hints = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`l.hint${i}`, 'Display only']));
  const search = collectionFilterSearch({ ...hints, [`f.${tag}`]: ids, [`r.${count}`]: ['0,', '1,'] });
  expect(readCollectionFilterAddress(search, release, type).filterStatus).toBe('failed');
  expect(Object.keys(search)).toHaveLength(19);
  const query = new URLSearchParams([
    [`f.${tag}`, ids[0]!],
    ['layout', 'grid'],
  ]);
  const document = parse(query).document;
  query.set(`l.${tag}`, 'An untrusted display hint');
  expect(parse(query).document).toEqual(document);
  expect(parse(query).issues).toEqual([]);
});

test('correction is explicit, inspectable and preserves context; only a changed predicate retires its cursor', () => {
  const search = `?layout=grid&otherCursor=keep&cursor=opaque%2Fpage&type=${type}&f.${tag}=${ids[0]}&r.${count}=1,9&r.${count}=2,8`;
  const state = parse(new URLSearchParams(search));
  const html = renderToStaticMarkup(
    createElement(CollectionFilterAddressState, { id: 'c', type, params: state, search }),
  );
  expect(html).toContain('role="alert"');
  for (const message of [
    m.collection_filter_address_rejected(),
    m.collection_filter_address_ambiguous(),
    m.collection_filter_address_original(),
    m.collection_filter_address_correct(),
  ])
    expect(html).toContain(message);
  expect(html).toContain(`f.${tag}=${ids[0]}`);
  expect(html).toContain('r.schema:wordCount=2,8');
  const corrected = new URL(
    collectionFilterAddress('en', 'c', state.selected, state.ranges, {}, type, new URLSearchParams(search)),
    'https://site.test',
  );
  expect(corrected.searchParams.get('layout')).toBe('grid');
  expect(corrected.searchParams.get('otherCursor')).toBe('keep');
  expect(corrected.searchParams.has('cursor')).toBe(false);
  expect(parse(corrected.searchParams).document).toBeDefined();
  corrected.searchParams.set('cursor', 'opaque/page');
  const same = new URL(
    collectionFilterAddress('en', 'c', state.selected, {}, { [tag]: 'New label' }, type, corrected.searchParams),
    corrected,
  );
  expect(same.searchParams.get('cursor')).toBe('opaque/page');
  const clear = new URL(collectionFilterAddress('en', 'c', {}, {}, {}, type, corrected.searchParams), corrected);
  expect(clear.searchParams.has('cursor')).toBe(false);
  expect(clear.searchParams.get('layout')).toBe('grid');
  expect(parse(clear.searchParams).document).toBeUndefined();
});

test('rejected addresses dispatch no members request for curated or dynamic Collections', async () => {
  for (const membershipKind of ['curated', 'dynamic']) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input) => {
        calls.push(new URL(String(input)).pathname);
        return Response.json({
          collection: {
            id: 'c',
            membershipKind,
            builtinKind: 'everything',
            title: 'Collection',
            visibility: 'public',
            curatorAccountId: 'owner',
            revision: 1,
            memberCount: 7,
          },
        });
      },
    });
    const admission = readCollectionFilterAddress({ [`f.${tag}`]: ids, [`r.${count}`]: '0,' }, release, type);
    const page = await loadEditableCollectionPage(
      client,
      new Request('https://site.test'),
      {},
      { id: 'c', ...admission },
      'anonymous',
    );
    expect(page.filterStatus).toBe('failed');
    expect(page.members).toEqual([]);
    expect(calls).toEqual(['/v1/collections/c']);
  }
});
