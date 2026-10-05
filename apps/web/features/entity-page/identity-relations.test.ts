import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RatingInline, ratingsUntilMean } from '../catalogue/rating.tsx';
import { figuresOfRating } from '../scoped-rating/score.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import { Distribution, Mean } from '../work-page/ratings.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import {
  identityEntry,
  identityData,
  alter,
  persona,
  saber,
  identityRatings,
} from './identity-fixtures.ts';
import {
  bindingSummary,
  fromRole,
  identityEntries,
  resourceBinding,
} from './identity-relations.ts';
import { identityContinuation, IdentitySectionsView } from './identity-views.tsx';
import { messages, copyOf } from './messages.ts';
import { parseEntityCursors, standaloneHrefFor } from './route.ts';
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
    expect(relationRows([forward])[0]!.items[0]!.creditedName).toBeUndefined();
    const appearance = identityEntry('work', 'character', alter);
    expect(relationRows([appearance])[0]!.items[0]!.creditedName).toEqual({
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
