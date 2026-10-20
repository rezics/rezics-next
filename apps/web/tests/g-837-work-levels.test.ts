import { resourceHref } from '../features/address/path.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { ConnectionsSection, RelationRows, type Franchise } from '../features/work-levels/connections.tsx';
import { PartsSection } from '../features/work-levels/parts.tsx';
import { ConnectionsPreviewView, EditionsPreviewView, PartsPreviewView } from '../features/work-levels/previews.tsx';
import * as fixture from '../features/work-levels/fixtures.ts';
import { copyOf, englishMessages, messages } from '../features/work-levels/messages.ts';
import { collectionGroups, franchisesOf, labelFor, relationRows } from '../features/work-levels/relation-rows.ts';
import { copyOf as entityCopy } from '../features/entity-page/messages.ts';
import { standaloneHrefFor } from '../features/entity-page/route.ts';
import { RelationsView } from '../features/entity-page/views.tsx';
import {
  connectionsHref,
  editionsHref,
  parseConnectionsQuery,
  parseEditionsQuery,
  parseIsbn,
  parseReleaseId,
  releaseHref,
} from '../features/work-levels/route.ts';
import type { AvailableSummary, Loaded, ReadFailure, RelationEntry, RelationsPage } from '../features/work-levels/types.ts';
import { messages as pageMessages } from '../features/work-page/messages.ts';
import { uiLocales } from '../i18n/define.ts';
import { localizedPath } from '../i18n/locale.ts';

const uuid = '01944100-0000-7000-8000-000000000123';
const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const renderToStaticMarkup = (element: ReactElement) => renderMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const linkAttribute = (href: string) => `href="${localizedPath(href, 'en').replaceAll('&', '&amp;')}"`;

describe('explicit Collection purposes across Relations and Connections', () => {
  const cases = [
    [null, 'collections', 'Collections'], ['reading-list', 'readingLists', 'Reading lists'],
    ['recipe-selection', 'recipeSelections', 'Recipe selections'], ['series', 'series', 'Series'],
    ['franchise', 'franchises', 'Franchises'],
  ] as const;
  const entries: RelationEntry[] = cases.map(([kind], index) => {
    const reference = fixture.iri(`d0${index}`);
    const summary = fixture.summary(reference, `Misleading franchise and series ${index}`, 'en', index === 0 ? 'collection' : 'resource');
    return { kind: 'collection', relation: reference, revision: null, evidence: null,
      collectionPurpose: kind === null ? null : { kind, statement: fixture.iri(`d1${index}`), revision: fixture.iri(`d2${index}`), sources: [] },
      counterparts: [summary], rendering: { profile: 'relation-rendering-v1', meaning: null,
        structuralBasis: { profile: 'collection-membership', collection: reference, member: fixture.iri('100') },
        occurrence: null, viewingRole: 'member', bindings: [], projections: [] } };
  });
  const relations: Loaded<RelationsPage> = { ok: true, data: { profile: 'resource-relations-v1',
    resource: fixture.iri('100'), items: entries, next: 'next+/=雪',
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } } };
  const render = renderToStaticMarkup;
  const t = copyOf('en');
  const query = { grain: 'series' as const, partsAfter: 'parts-current', relationsAfter: 'relations-current', membersAfter: 'members-current' };
  const members: Franchise[] = entries.map((entry, index) => ({ collection: entry.counterparts[0]!, parts: new Map(), members: { ok: true,
    data: { collection: entry.relation, next: `member-next-${index}`, members: ['101', '102', '101'].map((id, occurrence) => ({
      occurrence: fixture.iri(`e${index}${occurrence}`), role: 'member', parent: entry.relation, target: fixture.iri(id),
      orderKey: `${occurrence}`, labels: [],
    })) } } }));
  const full = (franchises: readonly Franchise[] = [...members].reverse(), selected: Loaded<RelationsPage> = relations) =>
    render(createElement(ConnectionsSection, { relations: selected, franchises, names: fixture.names, workRef: fixture.workRef,
      current: fixture.current, query, locale: 'en', t, pageMessages: pageMessages.en }));
  const preview = (selected: Loaded<RelationsPage> = relations) => render(createElement(ConnectionsPreviewView, {
    relations: selected, workRef: fixture.workRef, locale: 'en', t, pageMessages: pageMessages.en,
  }));
  const generic = (selected: Loaded<RelationsPage> = relations) => render(createElement(RelationsView, {
    page: selected, cursor: 'relations-current', hrefFor: standaloneHrefFor({ statements: 'facts-current' }, resourceHref('/e/', uuid)),
    locale: 'en', t: entityCopy('en'), messages: pageMessages.en,
  }));

  test('all five purposes retain incidence identity and order independently of names, types and semantic meaning', () => {
    const repeated = entries[0]!;
    const groups = collectionGroups([...entries, repeated]);
    expect(groups.map(group => [group.purpose, group.heading])).toEqual(cases.map(([purpose, heading]) => [purpose, heading]));
    expect(groups[0]!.items).toEqual([
      { relation: repeated.relation, summary: repeated.counterparts[0] },
      { relation: repeated.relation, summary: repeated.counterparts[0] },
    ]);
    expect(franchisesOf(entries)).toEqual(entries.flatMap(entry => entry.counterparts));
    expect(relationRows(entries)).toEqual([]);
    expect(collectionGroups([{ ...repeated, collectionPurpose: undefined, rendering: null }])[0]!.heading).toBe('collections');
    const named = repeated.counterparts[0]!;
    if (named.status !== 'available') throw new Error('Expected the misleading title fixture');
    expect(collectionGroups([{ ...repeated, counterparts: [{ ...named, type: 'work' }] }])[0]!.heading).toBe('collections');
    expect(collectionGroups([{ ...repeated, counterparts: [] }])[0]!.items).toEqual([
      { relation: repeated.relation, summary: { reference: repeated.relation, status: 'unavailable' } },
    ]);
  });

  test('generic Relations, preview and full Connections expose every named purpose region and exact Collection link', () => {
    for (const [prefix, html] of [['relations', generic()], ['connections-preview', preview()], ['connections', full()]] as const) {
      for (const [index, [, key, heading]] of cases.entries()) {
        const summary = entries[index]!.counterparts[0]! as AvailableSummary;
        const section = html.slice(html.indexOf(`aria-labelledby="${prefix}-${key}"`));
        const region = section.slice(0, section.indexOf('</section>'));
        expect(region).toContain(`id="${prefix}-${key}"`);
        expect(region).toContain(`>${heading}</h3>`);
        expect(region).toContain(linkAttribute(resourceHref('/e/', summary.address as CanonicalAddress)));
        expect(region).toContain(summary.name.value);
      }
    }
  });

  test('full Connections joins hydration by exact Collection identity and preserves ordered repeated member occurrences', () => {
    const html = full();
    expect([...html.matchAll(/data-occurrence="([^"]+)"/g)].map(match => match[1])).toEqual(
      members.flatMap(member => member.members.ok ? member.members.data.members.map(item => item.occurrence) : []));
    for (const member of members) {
      const href = connectionsHref(fixture.workRef, { ...query, franchise: member.collection.reference.slice(-36),
        membersAfter: member.members.ok ? member.members.data.next! : '' }, 'franchises');
      expect(html).toContain(linkAttribute(href));
    }
    const repeated = fixture.names.get(fixture.iri('101'));
    if (repeated?.status !== 'available') throw new Error('The repeated member needs its native address');
    expect(html.split(linkAttribute(resourceHref('/w/', repeated.address as CanonicalAddress))).length - 1).toBe(10);
    expect(html).toContain('aria-label="Collection level"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(linkAttribute(connectionsHref(fixture.workRef, { ...query, grain: 'parts', membersAfter: undefined }, 'franchises')));
  });

  test('unhydrated and undisclosed Collections keep their purpose without a fabricated link or member list', () => {
    expect(full([])).toContain('Reading lists');
    expect(full([])).not.toContain('data-occurrence');
    const hidden = { ...entries[1]!, counterparts: [{ reference: entries[1]!.relation, status: 'unavailable' as const }] };
    const selected: Loaded<RelationsPage> = relations.ok ? { ok: true, data: { ...relations.data, items: [hidden] } } : relations;
    for (const html of [generic(selected), preview(selected), full(members, selected)]) {
      expect(html).toContain('Reading lists');
      expect(html).toContain('Name not shown');
      expect(html).not.toContain('Misleading franchise');
      expect(html).not.toContain('data-occurrence');
      expect(html).not.toContain(`href="${localizedPath(resourceHref('/e/', hidden.relation), 'en')}`);
      expect(html).not.toContain('No connections yet');
    }
  });

  for (const failure of ['missing', 'sign-in', 'unavailable'] as const) {
    test(`${failure} remains a refusal in all relation surfaces and in exact Collection member reads`, () => {
      const selected = { ok: false as const, failure };
      for (const html of [generic(selected), preview(selected), full(members, selected)]) {
        expect(html).toContain(failure === 'missing' ? pageMessages.en.regionMissing
          : failure === 'sign-in' ? pageMessages.en.regionDenied : pageMessages.en.regionUnavailable);
        expect(html).not.toContain('Misleading franchise');
        expect(html).not.toContain('No connections yet');
      }
      const html = full([{ ...members[0]!, members: selected }]);
      expect(html).toContain(t.membersUnavailable);
      expect(html).toContain(failure === 'missing' ? pageMessages.en.regionMissing
        : failure === 'sign-in' ? pageMessages.en.regionDenied : pageMessages.en.regionUnavailable);
      expect(html).not.toContain(t.noMembers);
    });
  }

  test('empty member and relation pages retain opaque current/next cursors and preview View all', () => {
    const emptyMembers = { ...members[0]!, members: { ok: true as const, data: {
      collection: entries[0]!.relation, members: [], next: 'empty-next+/=',
    } } };
    const html = full([emptyMembers]);
    expect(html).not.toContain(t.noMembers);
    expect(full([{ ...emptyMembers, members: { ok: true, data: { ...emptyMembers.members.data, next: null } } }])).toContain(t.noMembers);
    expect(html).toContain('membersAfter=empty-next%2B%2F%3D');
    expect(html).toContain('relationsAfter=next%2B%2F%3D%E9%9B%AA');
    expect(html).toContain('partsAfter=parts-current');
    expect(html).toContain(t.firstPage);
    const empty: Loaded<RelationsPage> = relations.ok ? { ok: true, data: { ...relations.data, items: [] } } : relations;
    expect(preview(empty)).toContain(t.allConnections);
    expect(preview(empty)).toContain(`${connectionsHref(fixture.workRef, {}, 'relations')}"`);
    expect(generic(empty)).toContain('relations=next%2B%2F%3D%E9%9B%AA');
    expect(full([], empty)).not.toContain(t.noConnections);
    expect(generic(empty)).not.toContain(entityCopy('en').noRelations);
    expect(render(createElement(ConnectionsSection, { relations: { ok: true, data: { ...empty.data, next: null } },
      franchises: [], names: fixture.names, workRef: fixture.workRef, current: fixture.current, query: { grain: 'series' },
      locale: 'en', t, pageMessages: pageMessages.en }))).toContain(t.noConnections);
  });
});

describe('independent Work reads preserve disclosed results', () => {
  const common = { workRef: fixture.workRef, t: copyOf('en'), pageMessages: pageMessages.en };
  const partsProps = { ...common, wholes: fixture.wholes, names: fixture.names };
  const failedReads: ReadFailure[] = ['missing', 'budget', 'unavailable'];
  const router: AppRouterInstance = {
    bfcacheId: '',
    refresh() {},
    push() {},
    replace() {},
    back() {},
    forward() {},
    prefetch() {},
  };
  const render = (element: ReactElement) =>
    renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));

  for (const failure of failedReads) {
    test(`the parts preview keeps the whole when parts are ${failure}`, () => {
      const markup = render(
        createElement(PartsPreviewView, {
          ...partsProps,
          parts: { ok: false, failure },
        }),
      );
      expect(markup).toContain('Part of');
      expect(markup).toContain('A Certain Magical Index');
      expect(markup).toContain(resourceHref('/w/', fixture.iri('200')));
      expect(markup.includes('role="alert"')).toBe(failure !== 'missing');
    });

    test(`the full parts section keeps the whole when parts are ${failure}`, () => {
      const markup = render(
        createElement(PartsSection, {
          ...partsProps,
          parts: { ok: false, failure },
          query: { grain: 'series' },
          locale: 'en',
        }),
      );
      expect(markup).toContain('Part of');
      expect(markup).toContain('A Certain Magical Index');
      expect(markup).toContain(resourceHref('/w/', fixture.iri('200')));
      expect(markup.includes('role="alert"')).toBe(failure !== 'missing');
    });

    test(`the editions preview keeps releases when realizations are ${failure}`, () => {
      const markup = render(
        createElement(EditionsPreviewView, {
          ...common,
          locale: 'en',
          realizations: { ok: false, failure },
          releases: fixture.releases,
        }),
      );
      expect(markup).toContain('A Certain Magical Index, Vol. 1');
      expect(markup).toContain(releaseHref(fixture.iri('c1')));
      expect(markup.includes('role="alert"')).toBe(failure !== 'missing');
    });

    test(`the editions preview keeps languages when releases are ${failure}`, () => {
      const markup = render(
        createElement(EditionsPreviewView, {
          ...common,
          locale: 'en',
          realizations: fixture.realizations,
          releases: { ok: false, failure },
        }),
      );
      expect(markup).toContain('Japanese');
      expect(markup).toContain(copyOf('en').realizations);
      expect(markup.includes('role="alert"')).toBe(failure !== 'missing');
    });
  }

  test('a missing realizations read does not suppress an unavailable releases read', () => {
    const markup = render(
      createElement(EditionsPreviewView, {
        ...common,
        locale: 'en',
        realizations: { ok: false, failure: 'missing' },
        releases: { ok: false, failure: 'unavailable' },
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(copyOf('en').releasesUnavailable);
  });

  test('an unavailable wholes read does not suppress disclosed parts', () => {
    const markup = render(
      createElement(PartsPreviewView, {
        ...partsProps,
        parts: fixture.parts,
        wholes: { ok: false, failure: 'unavailable' },
      }),
    );
    expect(markup).toContain('A Certain Magical Index NT 1');
  });
});

describe('G-837 page addresses', () => {
  test('the Connections query keeps grain, group and cursors, and refuses what is malformed', () => {
    expect(parseConnectionsQuery({})).toEqual({
      grain: 'series',
      parent: undefined,
      partsAfter: undefined,
      relationsAfter: undefined,
      franchise: undefined,
      membersAfter: undefined,
    });
    expect(
      parseConnectionsQuery({ grain: 'parts', parent: uuid, partsAfter: 'abc' }),
    ).toMatchObject({ grain: 'parts', parent: uuid, partsAfter: 'abc' });
    for (const bad of [
      { grain: 'volumes' },
      { parent: 'not-a-uuid' },
      { franchise: 'x' },
      { grain: ['series', 'parts'] },
      { partsAfter: 'x'.repeat(2049) },
    ])
      expect(parseConnectionsQuery(bad)).toBeNull();
  });

  test('the Editions query accepts cursors only', () => {
    expect(parseEditionsQuery({ releasesAfter: 'r' })).toEqual({
      realizationsAfter: undefined,
      releasesAfter: 'r',
    });
    expect(parseEditionsQuery({ releasesAfter: ['a', 'b'] })).toBeNull();
  });

  test('links carry stable anchors and leave defaults out', () => {
    expect(connectionsHref('sao', {}, 'parts')).toBe(
      `${resourceHref('/w/', 'sao')}/connections#parts`,
    );
    expect(connectionsHref('sao', { grain: 'series' })).toBe(
      `${resourceHref('/w/', 'sao')}/connections`,
    );
    expect(connectionsHref('sao', { grain: 'parts', partsAfter: 'c' }, 'parts')).toBe(
      `${resourceHref('/w/', 'sao')}/connections?grain=parts&partsAfter=c#parts`,
    );
    expect(editionsHref('sao', { releasesAfter: 'r' }, 'releases')).toBe(
      `${resourceHref('/w/', 'sao')}/editions?releasesAfter=r#releases`,
    );
    expect(releaseHref(`https://rezics.com/id/${uuid}`)).toBe(`/releases/${uuid}`);
  });

  test('a release segment is a UUID in any case', () => {
    expect(parseReleaseId(uuid.toUpperCase())).toBe(uuid);
    expect(parseReleaseId('9780316371247')).toBeNull();
  });

  test('an ISBN segment is an ISBN-13, an ISBN-10 spelled as one, or nothing Main is asked about', () => {
    expect(parseIsbn('9780316371247')).toBe('9780316371247');
    expect(parseIsbn('978-0-316-37124-7')).toBe('9780316371247');
    expect(parseIsbn('978%200316371247')).toBe('9780316371247');
    expect(parseIsbn('0316371246')).toBe('9780316371247');
    expect(parseIsbn('0-8044-2957-X')).toBe('9780804429573');
    expect(parseIsbn('9780316371248')).toBeNull();
    expect(parseIsbn('0316371247')).toBeNull();
    expect(parseIsbn('12345')).toBeNull();
    expect(parseIsbn('%E0%A4%A')).toBeNull();
  });
});

const rendering = (entry: RelationEntry) => entry.rendering!;

describe('G-837 relation rows come from Main’s rendering', () => {
  const rows = relationRows(fixture.relationEntries);

  test('franchise entries are not relations; each direction gets a row under the label Main selected', () => {
    expect(rows.map((row) => row.label.text?.value)).toEqual(['Reboot of', 'Spin-offs', '続編元']);
    expect(rows.every((row) => row.style === 'row')).toBe(true);
    expect(
      rows[1]!.items.map((item) => item.target.kind === 'resource' && item.target.reference),
    ).toEqual([fixture.iri('301'), fixture.iri('302')]);
  });

  test('an unresolved source is carried by the row and a fallback label names the language it is in', () => {
    expect(rows[0]!.items[0]!.unresolvedSource).toBe(true);
    expect(rows[1]!.items[0]!.unresolvedSource).toBe(false);
    expect(rows[2]!.label.fallbackLanguage).toBe('ja');
    expect(rows[0]!.label.fallbackLanguage).toBeNull();
  });

  test('the label takes the plural form Main supplies for the count', () => {
    const projection = rendering(fixture.relationEntries[2]!).projections[0]!;
    expect(labelFor(projection, 1).text?.value).toBe('Spin-off');
    expect(labelFor(projection, 2).text?.value).toBe('Spin-offs');
    expect(labelFor({ ...projection, labels: null }, 1).text).toBeNull();
  });

  test('relations to people or characters read as role chips, and withheld or external counterparts stay visible', () => {
    const entry = structuredClone(fixture.relationEntries[2]!);
    entry.counterparts = [fixture.summary(fixture.iri('a1'), 'Reki Kawahara', 'ja', 'resource')];
    const projection = rendering(entry).projections[0]!;
    projection.arguments = [
      { role: 'spin-off', type: 'resource', value: { kind: 'resource', ref: fixture.iri('a1') } },
      { role: 'spin-off', type: 'external', value: { kind: 'external', key: 'OL123A' } },
      { role: 'spin-off', type: 'unavailable-reference', value: { kind: 'unavailable-reference' } },
    ];
    const [chips] = relationRows([entry]);
    expect(chips!.style).toBe('chips');
    expect(chips!.items.map((item) => item.target.kind)).toEqual([
      'resource',
      'external',
      'withheld',
    ]);
    // Each chip names one counterpart, so each takes the singular label, not the row's plural.
    const markup = renderToStaticMarkup(
      createElement(RelationRows, { rows: [chips!], locale: 'en', t: copyOf('en') }),
    );
    expect([...markup.matchAll(/data-role-chip/g)]).toHaveLength(3);
    expect([...markup.matchAll(/Spin-off</g)]).toHaveLength(3);
    expect(markup).not.toContain('Spin-offs');
  });
});

describe('G-837 class guard: no relation row is built on the client', () => {
  // A label no client table could know: if a row shows it, it came from Main's rendering.
  const invented = structuredClone(fixture.relationEntries[1]!);
  rendering(invented).projections[0]!.labels = {
    noun: 'Zorblax of',
    heading: 'Zorblaxes of',
    plurals: { one: 'Zorblax of', other: 'Zorblaxes of' },
    grammaticalForms: [],
  };
  const html = (locale: 'en' | 'ja', entries: RelationEntry[]) =>
    renderToStaticMarkup(
      createElement(RelationRows, { rows: relationRows(entries), locale, t: copyOf(locale) }),
    );

  test('a row shows exactly Main’s label and the counterpart’s own name, nothing around them', () => {
    const markup = html('en', [invented]);
    expect(markup).toContain('Zorblax of');
    expect(markup).toContain('とある魔術の禁書目録');
    expect(markup).not.toMatch(/Zorblax of\s+of/);
    // The name's language and direction travel with it, isolated from the row.
    expect(markup).toMatch(/<bdi lang="ja" dir="ltr">とある魔術の禁書目録<\/bdi>/);
  });

  test('an inverse direction adds no "of" and a missing label is the neutral word, never a guess from the kind', () => {
    const missing = structuredClone(invented);
    rendering(missing).projections[0]!.labels = null;
    const markup = html('ja', [missing]);
    expect(markup).toContain(copyOf('ja').relatedFallback);
    expect(markup).not.toMatch(/Reboot|Sequel|Adaptation/i);
  });

  test('the feature names no relation kind and its catalogs hold no relation wording', () => {
    const directory = join(import.meta.dir, '../features/work-levels');
    const sources = readdirSync(directory).filter(
      (name) =>
        /\.tsx?$/.test(name) && !/(fixtures|\.stories)\./.test(name) && name !== 'messages.ts',
    );
    const kinds =
      /\b(reboot|spin-?off|sequel|prequel|adaptation|rewrite|remake|derivation kind)s?\b/i;
    for (const name of sources) {
      const code = readFileSync(join(directory, name), 'utf8').replace(
        /^\s*(\/\/|\*|\/\*).*$/gm,
        '',
      );
      expect(code, name).not.toMatch(kinds);
      expect(code, name).not.toMatch(/['"`]\s*of\s*['"`]|\+\s*['"`] of/);
    }
    for (const locale of uiLocales) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(`${key} ${typeof value === 'string' ? value : ''}`, `${locale}.${key}`).not.toMatch(
          kinds,
        );
      }
    }
  });
});

describe('G-837 catalogs', () => {
  test('every locale supplies every key and keeps its placeholders', () => {
    for (const locale of uiLocales) {
      expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(englishMessages).sort());
    }
    expect(copyOf('de').coversWorks(3)).toBe('Enthält 3 Werke');
    expect(copyOf('zh-Hans').coversWorks(1)).toBe('涵盖 1 部作品');
    expect(copyOf('fr').labelIn({ language: 'japonais' })).toBe('en japonais');
  });
});
