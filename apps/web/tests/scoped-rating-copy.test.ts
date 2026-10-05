import { expect, test } from 'bun:test';
import { translate } from '../features/scoped-rating/format.ts';
import { messages } from '../features/scoped-rating/messages.ts';
import type { UiLocale } from '../i18n/define.ts';

const locales = Object.keys(messages) as UiLocale[];

test('the ranking prior is told as a weight in every language, never as a number of ratings', () => {
  expect(locales).toHaveLength(8);
  for (const locale of locales) {
    const t = translate(messages[locale], locale);
    const told = t.rankingPrior({ mean: '7.20', weight: '200' });
    expect(told, locale).toContain('7.20');
    expect(told, locale).toContain('200');
    // "200 ratings" in the language's own plural form is exactly what the prior is not.
    expect(told, locale).not.toContain(t.ratingCount(200));
  }
  expect(translate(messages.en, 'en').rankingPrior({ mean: '7.20', weight: '200' })).toContain('weight of 200');
});

test('a frame set across two Works has its own words in every language, apart from the one for a repeated kind', () => {
  for (const locale of locales) {
    const t = translate(messages[locale], locale);
    expect(t.failWorkMismatch, locale).not.toBe(t.failInvalid);
    if (locale !== 'en') expect(t.failWorkMismatch, locale).not.toBe(translate(messages.en, 'en').failWorkMismatch);
  }
});
