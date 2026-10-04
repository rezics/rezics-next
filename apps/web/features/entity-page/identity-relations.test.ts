import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RatingInline, ratingsUntilMean } from '../catalogue/rating.tsx';
import { relationRows } from '../work-levels/relation-rows.ts';
import { Distribution, Mean } from '../work-page/ratings.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { identityEntry, alter, persona, saber, identityRatings } from './identity-fixtures.ts';
import {
  bindingSummary,
  fromRole,
  identityEntries,
  resourceBinding,
} from './identity-relations.ts';
import { identityContinuation } from './identity-views.tsx';
import { messages } from './messages.ts';
import { parseEntityCursors } from './route.ts';
import { resourceHref } from '../address/path.ts';

describe('Identity relations', () => {
  test('exact definition and role select a variant; display labels cannot retarget the relation', () => {
    const entry = identityEntry('hub', 'variant', alter, persona);
    const definitions = new Map([['variant-of' as const, entry.rendering!.meaning.definition]]);
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
    expect(relationRows([forward])[0]!.items[0]!.creditedName).toEqual({
      lexical: 'Saber',
      language: 'en',
    });
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
  });
});

describe('Honest target scores', () => {
  test('below-threshold means render counts and progress without stars or a manufactured zero', () => {
    const read = identityRatings(1);
    if (!read.ok) throw new Error('fixture unavailable');
    const summary = read.data.summary;
    const html = renderToStaticMarkup(
      createElement(Mean, { summary, locale: 'en', messages: workMessages.en }),
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
  test('zero observations retain all ten histogram buckets and the distance to disclosure', () => {
    const read = identityRatings(0);
    if (!read.ok) throw new Error('fixture unavailable');
    const html = renderToStaticMarkup(
      createElement(Distribution, {
        summary: read.data.summary,
        locale: 'en',
        messages: workMessages.en,
      }),
    );
    expect(html.match(/<li /g)).toHaveLength(10);
    expect(ratingsUntilMean(0, 5, 'en')).toBe('5 more ratings will reveal the average.');
    expect(ratingsUntilMean(5, 5, 'en')).toBeNull();
    expect(ratingsUntilMean(4, 5, 'en')).toBe('1 more rating will reveal the average.');
  });
  test('a mean appears at the threshold and each identity keeps its own population', () => {
    const read = identityRatings(5);
    if (!read.ok) throw new Error('fixture unavailable');
    const html = renderToStaticMarkup(
      createElement(Mean, { summary: read.data.summary, locale: 'en', messages: workMessages.en }),
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
