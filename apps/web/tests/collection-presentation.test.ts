import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseListPresentation } from '@rezics/ui/cover';
import { CollectionMemberDetails } from '../src/library/collection-member-row';
import {
  collectionMemberRatio,
  collectionPageAddress,
  type CollectionListPresentations,
} from '../src/library/collection-presentation';
import { collectionFilterAddress } from '../src/library/collection-filter-params';
import { subjectOf, type CollectionMember } from '../src/library/reads';
import { getLocale, locales, overwriteGetLocale } from '../src/paraglide/runtime.js';
import recording from '../src/kernel/recorded/library-collection-members.json';
import definitions from '../src/kernel/recorded/definitions-release.json';
import subjectRecording from '../src/kernel/recorded/subject.json';
import agentRecording from '../src/kernel/recorded/agent-page.json';
import { collectionStoryMembers, routes } from '../src/kernel/fake/collection-stories';
import { routes as pageRoutes, setCollectionStoryMode } from '../src/kernel/fake/collection-page-stories';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const presentations: CollectionListPresentations = {
  'schema:Book': parseListPresentation(definitions.release.types['schema:Book'].listPresentation)!,
  'schema:Movie': parseListPresentation(definitions.release.types['schema:Movie'].listPresentation)!,
};
const book = { ...recording.members[2]!, subject: subjectOf(recording.members[2]!.subject) };
const renderDetails = (member: Pick<CollectionMember, 'subject' | 'facts'>, listPresentations = presentations) =>
  renderToStaticMarkup(createElement(CollectionMemberDetails, { member, listPresentations }));

test('Book and Film facts use released order, localized supplied labels and existing number/unit formatting', () => {
  const previous = getLocale;
  const labels = Object.fromEntries(locales.map((locale) => [locale, `Supplied credit (${locale})`]));
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      for (const [type, credit, amount, unit] of [
        ['schema:Book', 'schema:author', 123456, 'words'],
        ['schema:Movie', 'schema:director', 95.5, 'min'],
      ] as const) {
        const quantity = type === 'schema:Book' ? 'schema:wordCount' : 'schema:duration';
        const html = renderDetails({
          subject: { ...book.subject!, type },
          facts: {
            [quantity]: [{ kind: 'quantity', amount, unit }],
            'schema:datePublished': [{ kind: 'time', year: 1943 }],
            [credit]: [{ kind: 'item', id: 'supplied-credit', labels }],
            'schema:genre': [{ kind: 'code', value: 'Unconfigured value' }],
          },
        });
        const year = new Intl.NumberFormat(locale, { useGrouping: false }).format(1943);
        const number = `${new Intl.NumberFormat(locale).format(amount)} ${unit}`;
        expect(html).toContain(labels[locale]!);
        expect(html).toContain(`lang="${locale}"`);
        expect(html).toContain(year);
        expect(html).toContain(number);
        expect(html.indexOf(labels[locale]!)).toBeLessThan(html.indexOf(year));
        expect(html.indexOf(year)).toBeLessThan(html.indexOf(number));
        expect(html).not.toContain('Unconfigured value');
      }
    }
  } finally {
    overwriteGetLocale(previous);
  }
});

test('absent, complete-empty, withheld and explicitly cleared facts stay absent without title heuristics', () => {
  for (const facts of [undefined, {}, { 'schema:author': [], 'schema:datePublished': [] }]) {
    const html = renderDetails({ subject: book.subject, ...(facts === undefined ? {} : { facts }) });
    expect(html).toContain(`data-context-state="${facts === undefined ? 'unknown' : 'empty'}"`);
    expect(html).not.toContain('1943');
  }
  const supplied: Pick<CollectionMember, 'subject' | 'facts'> = {
    subject: book.subject,
    facts: { 'schema:datePublished': [{ kind: 'time', year: 1943 }] },
  };
  const cleared = { 'schema:Book': { imageAspect: 'portrait' as const, keyFacts: [] } };
  expect(renderDetails(supplied, cleared)).not.toContain('1943');
  expect(renderDetails({ ...supplied, subject: null })).toBe('');
  const partial = renderDetails(supplied);
  expect(partial).toContain('1943');
  expect(partial).not.toContain('author');
  expect(partial).not.toContain('Unknown');
  const invalid = renderDetails({
    subject: book.subject,
    facts: {
      'schema:author': [{ kind: 'item', id: 'unlabelled', labels: {} }],
      'schema:datePublished': [{ kind: 'time', year: NaN }],
      'schema:wordCount': [{ kind: 'quantity', amount: Infinity, unit: 'words' }],
    },
  });
  expect(invalid).toContain('data-context-state="unavailable"');
  expect(invalid).not.toContain('NaN');
  expect(invalid).not.toContain('Infinity');
});

test('Collection geometry follows actual Type hints while owner/dominant Collection kind leaves member facts intact', () => {
  const member = {
    ...book,
    facts: { 'schema:datePublished': [{ kind: 'time' as const, year: 1943 }] },
  };
  const configured: CollectionListPresentations = {
    ...presentations,
    'schema:Book': { imageAspect: 'square', keyFacts: ['schema:datePublished'] },
  };
  expect(collectionMemberRatio(member.subject, {}, configured)).toBe('1:1');
  expect(collectionMemberRatio({ type: 'schema:Movie' }, {}, presentations)).toBe('5:7');
  expect(collectionMemberRatio({ type: 'concept:Book' }, {}, presentations)).toBe('5:7');
  for (const presentationKind of ['schema:Book', 'schema:Movie', null]) {
    const html = renderToStaticMarkup(
      createElement(CollectionReadMembers, {
        members: [member],
        layout: 'grid',
        presentationKind,
        listPresentations: configured,
        onCopy: () => {},
      }),
    );
    expect(html).toContain('data-ratio="1:1"');
    expect(html).toContain('1943');
    expect(html).toContain(book.note!);
    expect(html).toContain(`/subjects/${book.subject!.id}/`);
    expect(html).not.toContain('<img');
  }
});

test('Collection Book fixture art belongs to its actual title and supplies safe author and work publication facts', async () => {
  expect(collectionStoryMembers.map((member) => member.id)).toEqual(recording.members.map((member) => member.id));
  expect(collectionStoryMembers.map((member) => member.note)).toEqual(recording.members.map((member) => member.note));
  const [snow, genji, prince, kokoro] = collectionStoryMembers;
  expect(snow!.subject.cover).toBeNull();
  expect(genji!.subject.cover).toBeNull();
  expect(prince!.subject.label.value).toBe(subjectRecording.summary.label.value);
  expect(prince!.subject.cover).toEqual(subjectRecording.summary.cover);
  expect(kokoro!.subject.label.value).toBe(agentRecording.reads.r2.body.links[0]!.summary.label.value);
  expect(kokoro!.subject.cover).toEqual(agentRecording.reads.r2.body.links[0]!.summary.cover);
  expect(prince!.subject.cover!.media).not.toBe(kokoro!.subject.cover!.media);
  for (const [member, author, year] of [
    [snow!, 'Yasunari Kawabata', 1937],
    [genji!, 'Murasaki Shikibu', undefined],
    [prince!, 'Antoine de Saint-Exupéry', 1943],
    [kokoro!, 'Natsume Sōseki', 1914],
  ] as const) {
    expect(member.facts['schema:author']).toContainEqual(
      expect.objectContaining({ kind: 'item', labels: expect.objectContaining({ en: author }) }),
    );
    expect(member.facts['schema:datePublished']).toEqual(year === undefined ? undefined : [{ kind: 'time', year }]);
  }
  // Both fake routes feeding the existing pages use the same presentation boundary; recordings stay untouched.
  const request = new Request('https://rezics.test/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2/members');
  const route = routes[0]!;
  const result = await route.story!({
    request,
    recordings: { 'library-collection-members': recording },
    match: (route.path as RegExp).exec(new URL(request.url).pathname),
  });
  expect(result?.members).toEqual(collectionStoryMembers);
  for (const mode of ['many', 'public-reader', 'presentation'] as const) {
    setCollectionStoryMode(mode);
    const pageRoute = pageRoutes.find(
      (route) =>
        route.method === 'GET' && route.path instanceof RegExp && route.path.test(new URL(request.url).pathname),
    )!;
    const page = await pageRoute.story!({ request, recordings: {}, match: null });
    expect(page?.members).toEqual(collectionStoryMembers);
  }
  setCollectionStoryMode('many');
  expect(recording.members.every((member) => member.subject.cover === null && !('facts' in member))).toBe(true);
});

test('an unlabelled author reference stays absent while a supplied publication year remains visible', () => {
  const html = renderDetails({
    subject: book.subject,
    facts: {
      'schema:author': [{ kind: 'item', id: 'private-or-unknown-author', labels: {} }],
      'schema:datePublished': [{ kind: 'time', year: 1943 }],
    },
  });
  expect(html).not.toContain('private-or-unknown-author');
  expect(html).toContain(new Intl.NumberFormat(getLocale(), { useGrouping: false }).format(1943));
});

test('unset presentation stays mixed and exact member hints do not follow a parent or Collection Type', async () => {
  const { collectionPresentationOf } = await import('../src/library/collection-presentation');
  expect(collectionPresentationOf({ presentationKind: 'schema:Book', presentationKindSource: 'mixed' })).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
  });
  const hints: CollectionListPresentations = {
    work: { imageAspect: 'landscape', keyFacts: [] },
    character: { imageAspect: 'portrait', keyFacts: [] },
    person: { imageAspect: 'square', keyFacts: [] },
  };
  expect(
    ['work', 'character', 'person', 'unreleased'].map((type) => collectionMemberRatio({ type }, {}, hints)),
  ).toEqual(['16:9', '5:7', '1:1', '5:7']);
});

test('grid/list and predicate addresses retain view state and reset only invalid cursors', () => {
  const search = { type: 'schema:Book', 'f.schema:genre': ['novel', 'essay'] };
  const address = (cursor: string | undefined, layout: 'grid' | 'list') =>
    new URL(collectionPageAddress('zh-Hant', 'collection', cursor, search, layout), 'https://site.test');
  const grid = address('opaque+/=', 'grid');
  const list = address('opaque+/=', 'list');
  const first = new URL(collectionPageAddress('ja', 'collection', undefined), 'https://site.test');
  const filtered = new URL(
    collectionFilterAddress(
      'zh-Hant',
      'collection',
      { 'schema:genre': ['film'] },
      {},
      {},
      search.type,
      grid.searchParams,
    ),
    'https://site.test',
  );
  expect([grid.searchParams.get('layout'), list.searchParams.has('layout')]).toEqual(['grid', false]);
  expect([
    list.searchParams.get('cursor'),
    list.searchParams.get('type'),
    list.searchParams.getAll('f.schema:genre'),
  ]).toEqual(['opaque+/=', 'schema:Book', ['novel', 'essay']]);
  expect([first.search, filtered.searchParams.has('cursor'), filtered.searchParams.get('layout')]).toEqual([
    '',
    false,
    'grid',
  ]);
});

test('native order and reorder preserve duplicate Subject occurrences and later-page boundaries', async () => {
  const { reorderCollectionMembers } = await import('../src/library/collection-presentation');
  const { buildCollectionMemberEditPlan } = await import('../src/library/collection-editor');
  const initial = [0, 1, 2].map((index) => ({ ...book, id: `occurrence-${index}`, subjectId: book.subject!.id }));
  const desired = reorderCollectionMembers(initial, initial[2]!.id, null, true);
  expect(desired.map((member) => member.id)).toEqual(['occurrence-2', 'occurrence-0', 'occurrence-1']);
  expect(desired.every((member) => member.subjectId === book.subject!.id && member.subject === book.subject)).toBe(
    true,
  );
  expect(buildCollectionMemberEditPlan(initial, desired, true)).toEqual([
    { kind: 'move', memberId: 'occurrence-2', after: null },
  ]);
  expect(reorderCollectionMembers(initial, 'occurrence-2', null, false)).toEqual(initial);
  expect(reorderCollectionMembers(initial, 'occurrence-0', 'occurrence-2', false)).toEqual(initial);
  expect(reorderCollectionMembers(initial, 'occurrence-2', 'off-page', true)).toEqual(initial);
});

test('presentation choice distinguishes automatic, released owner choice and retained unavailable identity without layout semantics', async () => {
  const { presentationTypeChoice, presentationChoiceState, presentationChanges } =
    await import('../src/library/collection-presentation-review/model');
  const { CollectionPresentationFields } = await import('../src/library/collection-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const options = [{ id: 'schema:Book', label: 'Released book label' }];
  expect(presentationTypeChoice(null, null, options, presentations)).toMatchObject({
    availability: 'automatic',
    state: 'retained',
    presentation: null,
  });
  expect(presentationTypeChoice(null, 'schema:Book', options, presentations)).toMatchObject({
    availability: 'released',
    state: 'replacement',
    label: 'Released book label',
    presentation: presentations['schema:Book'],
  });
  expect(presentationTypeChoice('retired:Type', 'retired:Type', null, undefined)).toMatchObject({
    id: 'retired:Type',
    availability: 'unavailable',
    state: 'retained',
    label: null,
    presentation: null,
  });
  expect(presentationChoiceState('retired:Type', null)).toBe('automatic');
  expect(
    presentationChanges({ kind: null, coverMediaId: 'saved' }, { kind: 'schema:Book', coverMediaId: 'saved' }),
  ).toEqual({ type: true, cover: false });
  const html = renderToStaticMarkup(
    createElement(CollectionPresentationFields, {
      types: null,
      kind: 'retired:Type',
      savedKind: 'retired:Type',
      coverMediaId: null,
      onKindChange() {},
    }),
  );
  expect(html).toContain('value="retired:Type" selected=""');
  expect(html).toContain(m.library_collection_types_unavailable());
  expect(html).toContain(m.collection_choice_type_unavailable());
  expect(html).not.toContain('>retired:Type<');
  expect(html).not.toContain('data-collection-layout');
  expect(html).not.toContain('data-collection-presentation="ordered"');
  expect(collectionMemberRatio(book.subject, {}, presentations)).toBe('5:7');
});
