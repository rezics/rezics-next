import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConditionEditor } from '../src/search/condition-editor';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import { hitCalendarDate, releaseDateText } from '../src/search/release-search-date';
import { ResultRow, type Fact } from '../src/search/results';
import { listKeyFacts } from '../src/media/type-presentation';

test('the universal editor preserves precise endpoints instead of rendering numeric year inputs', () => {
  const locale = 'ja';
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: {
        statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29', lte: '2024-03' } },
      },
      metadata: {
        types: { 'schema:Release': { facets: ['schema:datePublished'] } },
        properties: { 'schema:datePublished': { datatype: 'time' } },
      },
      locale,
      languages: ['ja'],
      onChange() {},
      onLanguages() {},
    }),
  );
  expect(html).toContain('value="2024-02-29"');
  expect(html).toContain('value="2024-03"');
  expect(html).toContain(m.refinement_lower({}, { locale }));
  expect(html).not.toContain(m.refinement_year_hint({}, { locale }));
});

test('all eight locales retain recorded date precision in actual result metadata and list facts', () => {
  const property = 'schema:datePublished';
  const dates: Fact[] = [
    { kind: 'time', year: 2024 },
    { kind: 'time', year: 2024, month: 2 },
    { kind: 'time', year: 2024, month: 2, day: 29 },
  ];
  expect(locales).toHaveLength(8);
  for (const locale of locales) {
    const texts = dates.map((date) => {
      if (date.kind !== 'time') throw new Error('Expected a time fact');
      const facts = { [property]: [date] };
      const text = releaseDateText(date, locale)!;
      const html = renderToStaticMarkup(
        createElement(ResultRow, {
          hit: { id: '018f0000-0000-7000-8000-000000000001', type: 'wd:Q20631656', labels: { en: 'Edition' }, facts },
          locale,
          hitTypes: {},
          yearProperties: [property],
        }),
      );
      expect(html).toContain(`>${text}</span>`);
      expect(listKeyFacts(facts, [property], [], locale)).toEqual([{ property, text }]);
      expect(hitCalendarDate(facts)).toEqual({
        year: date.year,
        ...(date.month === undefined ? {} : { month: date.month }),
        ...(date.day === undefined ? {} : { day: date.day }),
      });
      return text;
    });
    expect(new Set(texts).size).toBe(3);
  }
  expect(releaseDateText({ year: 2024, month: 2 }, 'en')).toBe('February 2024');
  expect(releaseDateText({ year: 2024, month: 2, day: 29 }, 'en')).toBe('February 29, 2024');
});

test('date display keeps astronomical years and rejects malformed facts without inventing a year', () => {
  for (const year of [0, -400, 99, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    const yearText = new Intl.NumberFormat('en', { useGrouping: false }).format(year);
    expect(releaseDateText({ year, month: 2, day: 29 }, 'en')).toBe(
      year % 4 === 0 ? `February 29, ${yearText}` : undefined,
    );
    expect(releaseDateText({ year, month: 2 }, 'en')).toBe(`February ${yearText}`);
  }
  for (const date of [
    { year: 2023, month: 2, day: 29 },
    { year: 2024, day: 3 },
    { year: 2024, month: 13 },
  ]) {
    expect(releaseDateText(date, 'en')).toBeUndefined();
    expect(hitCalendarDate({ date: [{ kind: 'time', ...date }] })).toBeUndefined();
  }
  expect(hitCalendarDate({ date: [null, null, null, { kind: 'time', year: 2024 }] })).toBeUndefined();
});
