import { describe, expect, test } from 'bun:test';
import type { CanonicalAddress } from '@rezics/model/address';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { RatingInline, ratingsUntilMean } from '../catalogue/rating.tsx';
import { figuresOfRating } from '../scoped-rating/score.ts';
import { equivalentCounterparts } from '../tracking/series-progress-panel.tsx';
import { RelationRows } from '../work-levels/connections.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { franchisesOf, relationPageGroups, relationRows } from '../work-levels/relation-rows.ts';
import type { RelationEntry, RelationsPage } from '../work-levels/types.ts';
import { Distribution, Mean } from '../work-page/ratings.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import {
  identityEntry,
  identityData,
  identitySummary,
  alter,
  persona,
  saber,
  identityRatings,
} from './identity-fixtures.ts';
import {
  bindingSummary,
  fromRole,
  identityEntries,
  remainingIdentityRelations,
  resourceBinding,
  type IdentityData,
} from './identity-relations.ts';
import { identityContinuation, IdentitySectionsView } from './identity-views.tsx';
import { messages, copyOf } from './messages.ts';
import { parseEntityCursors, standaloneHrefFor } from './route.ts';
import { resourceHref } from '../address/path.ts';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const renderToStaticMarkup = (element: ReactElement) =>
  renderMarkup(createElement(AppRouterContext.Provider, { value: router }, element));

describe('Identity relations', () => {
  test('a missing native meaning keeps repeated and refused counterparts as neutral rows for every helper consumer', () => {
    const source = identityEntry('hub', 'variant', alter);
    const unknown: RelationEntry = { ...source, rendering: null,
      counterparts: [alter, alter, { reference: persona.reference, status: 'unavailable' }] };
    const absent: RelationEntry = { ...source, rendering: null, counterparts: [] };
    const entries = [unknown, absent, unknown];
    const rows = relationRows(entries);
    expect(rows.map(row => row.projection)).toEqual([null, null, null]);
    expect(rows.map(row => row.label.text)).toEqual([null, null, null]);
    expect(rows.map(row => row.items.map(item => item.target.kind))).toEqual([
      ['resource', 'resource', 'resource'], ['withheld'], ['resource', 'resource', 'resource'],
    ]);
    expect(rows[0]!.items.map(item => item.evidence)).toEqual(Array(3).fill(source.evidence));
    const html = renderToStaticMarkup(createElement(RelationRows, { rows, locale: 'en', t: levelsCopy('en') }));
    expect(html.match(/Saber Alter/g)).toHaveLength(4);
    expect(html).toContain(levelsCopy('en').relatedFallback);
    expect(html).toContain(levelsCopy('en').nameNotShown);
    expect(html).not.toContain('data-appearance-part');
    const page: RelationsPage = { profile: 'resource-relations-v1', resource: saber.reference, items: entries,
      next: 'opaque:+/%?=&雪', sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
    const grouped = relationPageGroups(page);
    expect(grouped.page).toBe(page);
    expect(grouped.rows).toEqual([]);
    expect(grouped.unrendered).toEqual(entries);
    expect(page.items).toBe(entries);
    const structural: RelationEntry = { ...source, kind: 'collection', collectionPurpose: null,
      rendering: { profile: 'relation-rendering-v1', meaning: null,
        structuralBasis: { profile: 'collection-membership', collection: source.relation, member: saber.reference },
        occurrence: null, viewingRole: 'member', bindings: [], projections: [] },
      counterparts: [alter, { reference: persona.reference, status: 'unavailable' }] };
    const direct = relationRows([structural, structural]);
    expect(direct.map(row => row.projection)).toEqual([null, null]);
    expect(direct.map(row => row.items.map(item => item.target))).toEqual(Array(2).fill([
      { kind: 'resource', reference: alter.reference, summary: alter },
      { kind: 'resource', reference: persona.reference, summary: structural.counterparts[1] },
    ]));
    const groupedStructural = relationPageGroups({ ...page, items: [structural, structural] });
    expect(groupedStructural.rows).toEqual([]);
    expect(groupedStructural.unrendered).toEqual([]);
    expect(groupedStructural.collections.flatMap(group => group.items.map(item => item.summary)))
      .toEqual([...structural.counterparts, ...structural.counterparts]);
  });

  test('empty selected family and discovery pages keep their own current/next tokens and generic continuity', () => {
    const current = 'family-current:+/%?=&雪', next = 'family-next:+/%?=&雪';
    const variantCurrent = 'variant-current:+/%?=&雪', variantNext = 'variant-next:+/%?=&雪';
    const base = resourceHref('/e/', alter.reference);
    const query = new URLSearchParams({ family: current, variants: variantCurrent, relations: 'generic-current:+/%', position: 'at', frame: 'frame' });
    const page: RelationsPage = { profile: 'resource-relations-v1', resource: alter.reference, items: [], next,
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
    const html = renderToStaticMarkup(createElement(IdentitySectionsView, {
      data: { ok: true, data: { sections: [{ kind: 'family', hub: null, members: [], page, cursor: current, cursorKey: 'family',
        next: { resource: alter, cursor: next }, discovery: { page: { ...page, next: variantNext }, cursor: variantCurrent, fallback: [] } }] } },
      self: alter, locale: 'en', t: copyOf('en'), messages: workMessages.en,
      currentHref: `${base}?${query}`, hrefFor: standaloneHrefFor({}, base),
    }));
    const escaped = (href: string) => `/en${href}`.replaceAll('&', '&amp;');
    const family = new URLSearchParams(query); family.set('family', next);
    const discovery = new URLSearchParams(query); discovery.set('variants', variantNext); discovery.delete('family');
    expect(html).toContain(`href="${escaped(`${base}?${family}#identity-family`)}"`);
    expect(html).toContain(`href="${escaped(`${base}?${discovery}#identity-family`)}"`);
    const firstFamily = new URLSearchParams(query); firstFamily.delete('family');
    const firstDiscovery = new URLSearchParams(query); firstDiscovery.delete('family'); firstDiscovery.delete('variants');
    expect(html).toContain(`href="${escaped(`${base}?${firstFamily}#identity-family`)}"`);
    expect(html).toContain(`href="${escaped(`${base}?${firstDiscovery}#identity-family`)}"`);
    expect(html.match(/First page/g)).toHaveLength(2);
    expect(html.match(/More relations/g)).toHaveLength(2);
    expect(html).not.toContain(copyOf('en').noVariants);
    expect(html).toContain('id="identity-family"');
    expect(page.items).toEqual([]);
    expect(page.next).toBe(next);
  });

  test('a terminal empty selected page retains restart navigation and refused family counterparts stay unlinked', () => {
    const entry = identityEntry('hub', 'variant', alter);
    const withheld: RelationEntry = { ...entry, rendering: null,
      counterparts: [{ reference: alter.reference, status: 'unavailable' }] };
    const data: IdentityData = { sections: [{ kind: 'family', hub: null, members: [], next: null,
      cursor: 'terminal:+/%', cursorKey: 'family', fallback: [withheld, { ...entry, counterparts: [persona, persona] }] }] };
    const html = renderToStaticMarkup(createElement(IdentitySectionsView, {
      data: { ok: true, data }, self: saber, locale: 'en', t: copyOf('en'), messages: workMessages.en,
      currentHref: `${resourceHref('/e/', saber.reference)}?family=terminal%3A%2B%2F%25&relations=generic&variants=discovery`,
      hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
    }));
    expect(html).toContain('First page');
    expect(html).not.toContain(copyOf('en').noVariants);
    expect(html).not.toContain('More relations');
    expect(html).not.toContain(alter.reference);
    expect(html).toContain(copyOf('en').nameNotShown);
    expect(html.match(/>Persona<\/bdi>/g)).toHaveLength(2);
    expect(html).toContain(`href="/en${resourceHref('/e/', persona.address as CanonicalAddress)}"`);
    expect(html).toContain('relations=generic&amp;variants=discovery#identity-family');
  });

  test('family discovery cursors are single bounded values and cannot carry a former hub token', () => {
    expect(parseEntityCursors({ variants: 'opaque:+/%?=&雪' })).toEqual({ variants: 'opaque:+/%?=&雪' });
    expect(parseEntityCursors({ variants: ['a', 'b'] })).toBeNull();
    expect(parseEntityCursors({ variants: 'a'.repeat(2049) })).toBeNull();
    const href = identityContinuation(`${resourceHref('/e/', saber.reference)}?relations=generic&family=former&position=at&frame=f`, 'variants', 'opaque:+/%?=&雪');
    const url = new URL(href, 'https://rezics.test');
    expect(url.searchParams.get('variants')).toBe('opaque:+/%?=&雪');
    expect(url.searchParams.get('family')).toBeNull();
    expect(url.searchParams.get('relations')).toBe('generic');
    expect(url.searchParams.get('position')).toBe('at');
    expect(url.searchParams.get('frame')).toBe('f');
    expect(url.hash).toBe('#identity-family');
  });

  test('only actually displayed occurrences leave the generic page, with repetitions and the complete native page retained', () => {
    const shown = identityEntry('unit', 'character', alter);
    const unknownRole = identityEntry('unrecognized', 'character', saber);
    const withheld: RelationEntry = { ...shown, relation: `${shown.relation}-withheld`,
      counterparts: [{ reference: alter.reference, status: 'unavailable' }] };
    const structural: RelationEntry = { ...shown, kind: 'collection', collectionPurpose: null, rendering: null };
    const items = [shown, unknownRole, shown, withheld, structural];
    const page: RelationsPage = { profile: 'resource-relations-v1', resource: saber.reference, items,
      next: 'opaque:+/%?=&雪', sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
    const data: IdentityData = { relations: page, sections: [{ kind: 'represents', hub: null, next: null,
      members: [{ summary: alter, entry: shown, hub: false, kind: null, ratings: null, applicability: [] }] }] };
    const rest = remainingIdentityRelations(page, { ok: true, data });
    expect(rest.entries).toEqual([unknownRole, shown, withheld, structural]);
    expect(rest.entries[1]).toBe(shown);
    expect(rest.page).toBe(page);
    expect(rest.page.items).toBe(items);
    expect(rest.page.sourcePosition).toBe(page.sourcePosition);
    const grouped = relationPageGroups(rest.page, { entries: rest.entries });
    expect(grouped.page).toBe(page);
    expect(grouped.page.next).toBe('opaque:+/%?=&雪');
    expect(grouped.rows.flatMap(row => row.items).filter(item => item.relation === shown.relation)).toHaveLength(1);
    expect(data.relations).toBe(page);
    expect(page.items).toBe(items);
    expect(page.items).toEqual([shown, unknownRole, shown, withheld, structural]);
    expect(page.next).toBe('opaque:+/%?=&雪');

    const extra = { ...shown, counterparts: [alter, persona] };
    const compound = { ...page, items: [extra] };
    expect(remainingIdentityRelations(compound, { ok: true, data: { ...data, relations: compound } }).entries).toEqual([extra]);
  });

  test('a refused, absent, mismatched or empty specialized read cannot narrow the generic native page', () => {
    const entry = identityEntry('unit', 'character', alter);
    const page: RelationsPage = { profile: 'resource-relations-v1', resource: saber.reference, items: [entry], next: null,
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
    expect(remainingIdentityRelations(page, undefined).entries).toBe(page.items);
    for (const failure of ['identity', 'unavailable', 'missing'] as const)
      expect(remainingIdentityRelations(page, { ok: false, failure }).entries).toBe(page.items);
    expect(remainingIdentityRelations(page, { ok: true, data: { sections: [] } }).entries).toBe(page.items);
    expect(remainingIdentityRelations(page, { ok: true, data: { relations: page, sections: [] } }).entries).toEqual(page.items);
    const changed = { ...page, sourcePosition: { ...page.sourcePosition, sequence: '2' } };
    expect(remainingIdentityRelations(page, { ok: true, data: { relations: changed, sections: [] } }).entries).toBe(page.items);
    expect(remainingIdentityRelations({ ...page, items: [] }, { ok: true, data: { relations: page, sections: [] } }).entries).toEqual([]);
  });

  test('structural membership retains its Collection binding without becoming identity or equivalent progress', () => {
    const collection = { ...identitySummary('520', 'Collection'), type: 'collection' as const };
    const entry = identityEntry('member', 'collection', collection);
    const structural: RelationEntry = {
      ...entry,
      kind: 'collection',
      collectionPurpose: null,
      rendering: {
        ...entry.rendering!,
        meaning: null,
        structuralBasis: { profile: 'collection-membership', collection: collection.reference, member: saber.reference },
      },
    };
    const variant = identityEntry('hub', 'variant', alter, persona);
    const definitions = new Map([['variant-of' as const, variant.rendering!.meaning!.definition]]);
    expect(identityEntries([structural, variant], definitions, 'variant-of')).toEqual([variant]);
    expect(resourceBinding(structural, 'collection')).toBe(collection.reference);
    expect(franchisesOf([structural])).toEqual([collection]);
    const allRows = relationRows([structural, variant]);
    expect(allRows[0]!.projection).toBeNull();
    expect(allRows[0]!.items.map(item => item.target)).toEqual([{ kind: 'resource', reference: collection.reference, summary: collection }]);
    expect(allRows.slice(1)).toEqual(relationRows([variant]));

    const counterpart = identityEntry('original', 'equivalent', { ...alter, type: 'work' });
    const relations: RelationsPage = {
      profile: 'resource-relations-v1', resource: saber.reference, items: [structural, counterpart], next: 'next-page',
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
    };
    expect(equivalentCounterparts({ ...relations, next: null }, counterpart.rendering!.meaning!.definition))
      .toEqual([{ work: alter.reference, title: alter.name.value }]);
    expect(equivalentCounterparts(relations, counterpart.rendering!.meaning!.definition)).toEqual([]);
    expect(equivalentCounterparts({ ...relations, items: [structural] }, counterpart.rendering!.meaning!.definition))
      .toEqual([]);
    expect(structural.rendering?.meaning).toBeNull();
    if (!structural.rendering || !('structuralBasis' in structural.rendering))
      throw new Error('Collection structural basis unavailable');
    expect(structural.rendering.structuralBasis).toEqual({
      profile: 'collection-membership', collection: collection.reference, member: saber.reference,
    });
    expect(structural.collectionPurpose).toBeNull();
    expect(relations.next).toBe('next-page');
    const grouped = relationPageGroups(relations, { together: true });
    expect(grouped.page).toBe(relations);
    expect(grouped.page.next).toBe('next-page');
    expect(grouped.collections[0]!.purpose).toBeNull();
    expect(grouped.collections[0]!.items).toEqual([{ relation: structural.relation, summary: collection }]);
    expect(grouped.rows).toEqual(relationRows([counterpart], { together: true }));
    expect(grouped.unrendered).toEqual([]);
  });

  test('exact definition and role select a variant; display labels cannot retarget the relation', () => {
    const entry = identityEntry('hub', 'variant', alter, persona);
    const definitions = new Map([['variant-of' as const, entry.rendering!.meaning!.definition]]);
    expect(identityEntries([entry], definitions, 'variant-of')).toEqual([entry]);
    expect(identityEntries([entry], definitions, 'represents')).toEqual([]);
    expect(resourceBinding(entry, 'variant')).toBe(alter.reference);
    expect(bindingSummary(entry, 'kind', saber)).toEqual(persona);
    expect(bindingSummary(entry, 'unknown', saber)).toBeNull();
  });
  test('a variant page can use its hub direction while preserving the occurrence and credited name', () => {
    const entry = identityEntry('variant', 'hub', alter, persona);
    const viewed = fromRole(entry, 'hub');
    expect(viewed.relation).toBe(entry.relation);
    expect(entry.rendering!.viewingRole).toBe('variant');
    expect(viewed.rendering!.viewingRole).toBe('hub');
    const forward = identityEntry('hub', 'variant', alter, persona);
    expect(relationRows([forward])[0]!.items[0]!.creditedName).toBeUndefined();
    const appearance = identityEntry('work', 'character', alter);
    expect(relationRows([appearance])[0]!.items[0]!.creditedName).toEqual({
      lexical: 'Saber',
      language: 'en',
    });
    const argument = appearance.rendering!.projections[0]!.arguments[0]!;
    argument.creditedName = {
      lexical: 'Hidden Alias', language: 'en', reference: alter.reference, status: 'unavailable',
    } as typeof argument.creditedName;
    const withheld = relationRows([appearance])[0]!.items[0]!.creditedName;
    expect(withheld).toEqual({
      reference: alter.reference,
      status: 'unavailable',
    });
    expect(JSON.stringify(withheld)).not.toContain('Hidden Alias');
    const html = renderToStaticMarkup(createElement(RelationRows, {
      rows: relationRows([appearance]), locale: 'en', t: levelsCopy('en'),
    }));
    expect(html).toContain('data-role-chip');
    expect(html).toContain('Name not shown');
    expect(html).toContain('character');
    expect(html).not.toContain('Hidden Alias');
    expect(html).not.toContain(alter.reference);
    const recorded = renderToStaticMarkup(createElement(RelationRows, {
      rows: relationRows([identityEntry('work', 'character', alter)]), locale: 'en', t: levelsCopy('en'),
    }));
    expect(recorded).not.toContain('character');
  });
  test('family continuation retains the Realm and spoiler position and is a single bounded cursor', () => {
    const path = resourceHref('/e/', saber.reference);
    const href = identityContinuation(
      `${path}?scope=realm&realm=r&position=chapter#old`,
      'family',
      'next+/=',
    );
    expect(href).toBe(
      `${path}?scope=realm&realm=r&position=chapter&family=next%2B%2F%3D#identity-family`,
    );
    expect(parseEntityCursors({ family: 'next' })).toEqual({ family: 'next' });
    expect(parseEntityCursors({ family: ['a', 'b'] })).toBeNull();
    expect(parseEntityCursors({ family: 'a'.repeat(2049) })).toBeNull();
    expect(
      identityContinuation(
        `${path}?scope=realm&realm=r&position=chapter&family=stale`,
        'family',
        null,
      ),
    ).toBe(`${path}?scope=realm&realm=r&position=chapter#identity-family`);
  });
});

describe('Compact identity summaries', () => {
  const draw = (
    kind: Parameters<typeof identityData>[0],
    state: Parameters<typeof identityData>[1],
  ) =>
    renderToStaticMarkup(
      createElement(IdentitySectionsView, {
        data: identityData(kind, state),
        self: alter,
        locale: 'en',
        t: copyOf('en'),
        messages: workMessages.en,
        hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
      }),
    );
  test('family summaries use names, human kind labels and count units without credit pills or full histograms', () => {
    const html = draw('family', 'populated');
    expect(html).toContain('Alternate self');
    expect(html).toContain('Counterpart from another world');
    expect(html).toContain('Main entry');
    expect(html).toContain('7 ratings');
    expect(html).not.toContain('data-role-chip');
    expect(html).not.toContain('data-credited-name');
    expect(html).not.toContain('grid-cols-[3.75rem');
    expect(html.match(/data-identity-question/g)).toHaveLength(1);
  });
  test('zero votes show no strip and no threshold arithmetic', () => {
    const html = draw('family', 'zero');
    expect(html.match(/No ratings yet\./g)).toHaveLength(3);
    expect(html).not.toContain('data-rating-strip');
    expect(html).not.toContain('more ratings');
  });
  test('holders, represented characters and held titles carry no ratings', () => {
    for (const kind of ['holders', 'represents', 'titles'] as const) {
      const html = draw(kind, 'populated');
      expect(html).not.toContain('data-identity-ratings');
      expect(html).not.toContain('data-identity-question');
      expect(html).not.toContain('data-credited-name');
    }
  });
  test('the legend uses the localized Context presentation rather than the authored question', () => {
    const data = identityData('family', 'populated');
    if (!data.ok) throw new Error('fixture unavailable');
    const context = data.data.sections[0]!.legend!.context;
    context.question = 'Authored model question';
    context.displayQuestion = {
      ...context.displayQuestion,
      value: 'Question présentée',
      language: 'fr',
    };
    const html = renderToStaticMarkup(
      createElement(IdentitySectionsView, {
        data,
        self: alter,
        locale: 'en',
        t: copyOf('en'),
        messages: workMessages.en,
        hrefFor: standaloneHrefFor({}, resourceHref('/e/', saber.reference)),
      }),
    );
    expect(html).not.toContain('Authored model question');
    expect(html.match(/Question présentée/g)).toHaveLength(1);
    expect(html).toContain('lang="fr"');
  });
});

describe('Honest target scores', () => {
  test('below-threshold means render counts and progress without stars or a manufactured zero', () => {
    const read = identityRatings(1);
    if (!read.ok) throw new Error('fixture unavailable');
    const figures = figuresOfRating(read.data.summary)!;
    const html = renderToStaticMarkup(
      createElement(Mean, { figures, locale: 'en', messages: workMessages.en }),
    );
    expect(html).toContain('1 rating');
    expect(html).toContain('4 more ratings will reveal the average.');
    expect(html).not.toContain('lucide-star');
    expect(html).not.toContain('Average');
    const inline = renderToStaticMarkup(
      createElement(RatingInline, {
        rating: { mean: null, count: 1, max: 10, displayThreshold: 5 },
        locale: 'en',
      }),
    );
    expect(inline).not.toContain('<svg');
    expect(inline).toContain('1 rating');
  });
  test('zero observations draw no histogram, and the distance to disclosure is told in words', () => {
    const read = identityRatings(0);
    if (!read.ok) throw new Error('fixture unavailable');
    const html = renderToStaticMarkup(
      createElement(Distribution, {
        figures: figuresOfRating(read.data.summary)!,
        locale: 'en',
        messages: workMessages.en,
      }),
    );
    expect(html).toBe('');
    expect(ratingsUntilMean(0, 5, 'en')).toBe('5 more ratings will reveal the average.');
    expect(ratingsUntilMean(5, 5, 'en')).toBeNull();
    expect(ratingsUntilMean(4, 5, 'en')).toBe('1 more rating will reveal the average.');
  });
  test('a mean appears at the threshold and each identity keeps its own population', () => {
    const read = identityRatings(5);
    if (!read.ok) throw new Error('fixture unavailable');
    const html = renderToStaticMarkup(
      createElement(Mean, {
        figures: figuresOfRating(read.data.summary)!,
        locale: 'en',
        messages: workMessages.en,
      }),
    );
    expect(html).toContain('data-rating-mean="shown"');
    expect(html).toContain('5 ratings');
    expect(html).not.toContain('more ratings');
  });
  test('all eight locales carry disclosure progress text', () => {
    expect(Object.keys(messages)).toHaveLength(8);
    for (const locale of Object.keys(messages) as (keyof typeof messages)[]) {
      expect(ratingsUntilMean(1, 5, locale)).toContain('4');
    }
  });
});
