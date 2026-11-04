import { expect, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { literaryAddress, literaryDestination } from '../src/features/catalogue/literary-reader/navigation';
import { literaryIds } from '../src/features/catalogue/literary-reader/examples';
import { literaryVisitLocation } from '../src/features/catalogue/literary-visit/navigation';
import { profileRelationWindows } from '../src/features/pages/views';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

test('destination return preserves the selected stream row address and never borrows a different node cursor', () => {
  const selected = {
    node: 'members-released',
    property: 'wdt:P179',
    direction: 'inverse' as const,
  };
  const context = { id: literaryIds.author } as import('@rezics/composition').SelectedContext;
  const original = literaryAddress({
    id: literaryIds.series,
    label: 'Harbour stories',
    locale: 'ja',
    view: 'contents',
    realm: literaryIds.author,
    context,
    stream: selected,
    continuation: { node: selected.node, cursor: 'native opaque cursor' },
    focus: 'members:assertion',
  });
  expect(subjectVisitReturn(original, 'ja')).toBe(original);
  const destination = new URL(
    literaryDestination(literaryIds.member, 'Harbour work', 'ja', original, literaryIds.author, context),
    'https://site.test',
  );
  const returned = destination.searchParams.get('via')!;
  expect(subjectVisitReturn(returned, 'ja')).toBe(original);
  const address = new URL(returned, 'https://site.test');
  expect(address.pathname).toContain('/contents');
  expect(address.hash).toBe('#literary-reader');
  expect(address.searchParams.get('realm')).toBe(literaryIds.author);
  expect(address.searchParams.get('context')).toBe(context.id);
  expect(address.searchParams.get('node')).toBe(selected.node);
  expect(address.searchParams.get('streamProperty')).toBe(selected.property);
  expect(address.searchParams.get('streamDirection')).toBe(selected.direction);
  expect(address.searchParams.get('cursor')).toBe('native opaque cursor');
  expect(address.searchParams.get('focus')).toBe('members:assertion');

  const history = [{
    view: 'contents' as const,
    node: selected.node,
    cursor: 'older opaque cursor',
    streamProperty: selected.property,
    streamDirection: selected.direction,
    focus: 'members:assertion',
  }];
  const withHistory = literaryAddress({
    id: literaryIds.series,
    label: 'Harbour stories',
    locale: 'ja',
    view: 'contents',
    stream: selected,
    previous: history,
  });
  expect(subjectVisitReturn(withHistory, 'ja')).toBe(withHistory);
  expect(literaryVisitLocation(new URL(withHistory, 'https://site.test').search).previous).toEqual(history);
  expect(
    literaryVisitLocation(`?history=${encodeURIComponent(JSON.stringify([{ view: 'contents', node: selected.node, streamProperty: selected.property }]))}`).invalid,
  ).toBe(true);

  const changed = new URL(
    literaryAddress({
      id: literaryIds.series,
      label: 'Harbour stories',
      locale: 'ja',
      view: 'contents',
      stream: { node: 'members-other', property: 'schema:isPartOf', direction: 'forward' },
      continuation: { node: selected.node, cursor: 'native opaque cursor' },
    }),
    'https://site.test',
  );
  expect(changed.searchParams.get('node')).toBe('members-other');
  expect(changed.searchParams.has('cursor')).toBe(false);
  expect(
    subjectVisitReturn(
      `/ja/subjects/${literaryIds.series}/title/contents?cursor=unpaired#literary-reader`,
      'ja',
    ),
  ).toBeUndefined();
  expect(
    subjectVisitReturn(
      `/ja/subjects/${literaryIds.series}/title/contents?node=members-released&streamProperty=wdt%3AP179#literary-reader`,
      'ja',
    ),
  ).toBeUndefined();
});

test('aliased native reads keep a continuation attached only to its supplied node', () => {
  const document: CompositionDocument = {
    format: 'rezics.composition.v1',
    content: [
      { type: 'SubjectList', props: { id: 'members-primary', title: 'Members', property: 'wdt:P179', limit: 12, paged: true } },
      { type: 'SubjectList', props: { id: 'members-alias', title: 'Other members', property: 'wdt:P179', limit: 12, paged: true } },
    ],
  };
  const shared = planReads(platformRegistry, document, {
    subject: literaryIds.series,
    account: null,
  });
  const sharedKey = shared.nodes['members-primary']!;
  expect(shared.nodes['members-alias']).toBe(sharedKey);
  const body = {
    links: [{ subject: literaryIds.member, target: literaryIds.member }],
    relations: [{ subject: literaryIds.member, target: literaryIds.member }],
    next: 'next-native-cursor',
    freshness: { caught_up: true },
  };
  const uncontinued = profileRelationWindows({
    subject: literaryIds.series,
    document,
    reads: { [sharedKey]: { status: 200, body } },
  }, { includeAliases: true });
  expect(uncontinued.map(({ node }) => node)).toEqual(['members-primary', 'members-alias']);
  expect(uncontinued.map(({ rows }) => rows)).toEqual([body.links, body.links]);

  const continuation = { node: 'members-primary', cursor: 'primary-only-cursor' };
  const continued = planReads(platformRegistry, document, {
    subject: literaryIds.series,
    account: null,
    continuation,
  });
  const primaryKey = continued.nodes['members-primary']!;
  const aliasKey = continued.nodes['members-alias']!;
  expect(aliasKey).not.toBe(primaryKey);
  const cursorOwned = profileRelationWindows({
    subject: literaryIds.series,
    continuation,
    document,
    reads: { [primaryKey]: { status: 200, body } },
  }, { includeAliases: true });
  expect(cursorOwned.map(({ node }) => node)).toEqual(['members-primary', 'members-alias']);
  expect(cursorOwned[0]).toMatchObject({ node: 'members-primary', status: 200, next: 'next-native-cursor' });
  expect(cursorOwned[1]).toMatchObject({ node: 'members-alias', rows: [], valid: false });
  expect(cursorOwned[1]!.status).toBeUndefined();
});
