import { expect, test } from 'bun:test';
import { subjectJsonLd } from '../src/features/pages/jsonld.ts';
import fixture from '../src/kernel/recorded/subject.json';
import { GREGORIAN_CALENDAR } from '../src/subject/time-presentation';

const property = 'schema:datePublished';
const [publication] = fixture.subject.statements[property];

const dates: [date: string, precision: number, expected: string | undefined][] = [
  ['+00001-00-00', 9, '0001'],
  ['+2023-02-00', 10, '2023-02'],
  ['+0004-02-29', 11, '0004-02-29'],
  ['+2000-02-29', 11, '2000-02-29'],
  ['+2024-02-29', 11, '2024-02-29'],
  ['+2023-04-30', 11, '2023-04-30'],
  ['+9234567890120400-02-29', 11, '+9234567890120400-02-29'],
  ['+2023-02-29', 11, undefined],
  ['+1900-02-29', 11, undefined],
  ['+2100-02-29', 11, undefined],
  ['+2024-02-30', 11, undefined],
  ['+2023-04-31', 11, undefined],
  ['+2023-06-31', 11, undefined],
  ['+2023-09-31', 11, undefined],
  ['+2023-11-31', 11, undefined],
  ['+2023-01-32', 11, undefined],
  ['+2023-01-00', 11, undefined],
  ['+2023-00-01', 11, undefined],
  ['+2023-13-01', 11, undefined],
  ['+0000-01-01', 11, undefined],
  ['-0001-01-01', 11, undefined],
  ['+9234567890120100-02-29', 11, undefined],
  ['+12345678901234560400-02-29', 11, undefined],
  ['+2023-02-31', 10, undefined],
  ['+2024-02-29', 14, undefined],
  ['+2024-01-01', 8, undefined],
  ['+2024-01-01', 10.5, undefined],
];

test.each(dates)('Subject structured date %s at precision %s', (date, precision, expected) => {
  const data = subjectJsonLd({
    subject: {
      ...fixture.subject,
      sourceRecords: [],
      statements: {
        [property]: [
          {
            ...publication!,
            rank: 'normal',
            property: { id: property, data_type: 'time' },
            value: {
              type: 'value',
              content: { time: `${date}T00:00:00Z`, precision, calendarmodel: GREGORIAN_CALENDAR },
            },
          },
        ],
      },
    },
    related: {},
    locale: 'en',
    url: 'https://rezics.com/en/subjects/book',
  })['@graph'][0];
  if (expected === undefined) expect(data).not.toHaveProperty('datePublished');
  else expect(data.datePublished).toBe(expected);
});
