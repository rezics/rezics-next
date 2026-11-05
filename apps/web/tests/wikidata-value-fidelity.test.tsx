import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Subject } from '../src/subject/types';
import { quantityPresentation } from '../src/subject/quantity-presentation';
import { GREGORIAN_CALENDAR, JULIAN_CALENDAR, timePresentation } from '../src/subject/time-presentation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { CandidateValue } = await import('../src/features/pages/data');
const { subjectJsonLd } = await import('../src/features/pages/jsonld');

const supported = {
  time: '+10000-02-00T00:00:00Z',
  precision: 10,
  calendarmodel: JULIAN_CALENDAR,
  timezone: -330,
  before: 2,
  after: 1,
};

test('ordinary and candidate time reading preserves exact signed partial values and discloses all admitted metadata', () => {
  const reading = timePresentation(supported, 'en');
  expect(reading).toMatchObject({
    state: 'supported',
    date: '+10000-02',
    precision: 10,
    calendar: 'julian',
  });
  expect(reading.text).toContain('+10000-02');
  expect(reading.text).toContain('month');
  expect(reading.text).toContain('Julian calendar');
  expect(reading.text).toContain('-330 min');
  expect(reading.text).toContain('before 2, after 1');
  expect(
    timePresentation(
      {
        time: '-0044-00-00T00:00:00Z',
        precision: 9,
        calendarmodel: JULIAN_CALENDAR,
      },
      'en',
    ),
  ).toMatchObject({ state: 'supported', date: '-0044', precision: 9 });
  const html = renderToStaticMarkup(
    createElement(CandidateValue, {
      snak: {
        property: { id: 'schema:datePublished', data_type: 'time' },
        value: { type: 'value', content: supported },
      } as never,
      related: {},
      locale: 'en',
    }),
  );
  expect(html).toContain('+10000-02');
  expect(html).toContain('Julian calendar');
});

test('unsupported calendars, precisions and uncertainty stay distinct and structured dates are omitted', () => {
  expect(timePresentation({ ...supported, calendarmodel: 'https://example.org/calendar' }, 'en')).toMatchObject({
    state: 'unsupported',
    reason: 'calendar',
  });
  expect(timePresentation({ ...supported, precision: 12 }, 'en')).toMatchObject({
    state: 'unsupported',
    reason: 'precision',
  });
  expect(timePresentation({ ...supported, before: -1 }, 'en')).toMatchObject({
    state: 'unsupported',
    reason: 'uncertainty',
  });
  expect(timePresentation({ ...supported, timezone: Number.MAX_SAFE_INTEGER + 1 }, 'en')).toMatchObject({
    state: 'unsupported',
    reason: 'timezone',
  });
  expect(timePresentation({ type: 'somevalue' }, 'en').text).toContain('Unknown');
  expect(timePresentation({ type: 'novalue' }, 'en').text).toContain('No time');
  expect(
    timePresentation(
      {
        time: '+2024-03-07T00:00:00Z',
        precision: 11,
        calendarmodel: GREGORIAN_CALENDAR,
      },
      'en',
    ),
  ).toMatchObject({ state: 'supported', structuredDate: '2024-03-07' });
  for (const content of [
    { ...supported, calendarmodel: 'https://example.org/calendar' },
    { ...supported, precision: 12 },
    { ...supported, before: 1 },
    { ...supported, timezone: 60 },
    { time: '-0044-03-15T00:00:00Z', precision: 11, calendarmodel: JULIAN_CALENDAR },
  ]) {
    const jsonld = subjectJsonLd({
      subject: {
        id: '00000000-0000-4000-8000-00000000f001',
        type: 'schema:Book',
        labels: { en: 'Work' },
        descriptions: {},
        aliases: {},
        statements: {
          'schema:datePublished': [
            {
              id: '00000000-0000-4000-8000-00000000f002',
              rank: 'normal',
              property: { id: 'schema:datePublished', data_type: 'time' },
              value: { type: 'value', content },
              qualifiers: [],
              references: [],
              rezics: {
                release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                revision: 1,
              },
            },
          ],
        },
      } as unknown as Subject,
      related: {},
      locale: 'en',
      url: 'https://example.org/work',
    });
    expect(jsonld).not.toHaveProperty('datePublished');
    expect(jsonld.name).toBe('Work');
  }
});

test('quantity presentation remains lexical for amount and both bounds', () => {
  expect(
    quantityPresentation(
      {
        amount: '+9007199254740993.000100',
        lowerBound: '+9007199254740992.000100',
        upperBound: '+9007199254740994.000100',
        unit: 'http://www.wikidata.org/entity/Q11574',
      },
      {},
      'en',
    ),
  ).toEqual({
    numbers: '+9007199254740993.000100 (≥ +9007199254740992.000100; ≤ +9007199254740994.000100)',
    unitLabel: 's',
  });
});
