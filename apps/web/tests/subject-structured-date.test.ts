import { expect, test } from 'bun:test';
import { subjectJsonLd } from '../src/features/pages/jsonld.ts';

test.each([
  ['+00001-00-00T', 9, '0001'],
  ['+2023-02-31T', 10, '2023-02'],
  ['+0004-02-29T', 11, '0004-02-29'],
  ['+2000-02-29T', 11, '2000-02-29'],
  ['+2024-02-29T', 14, '2024-02-29'],
  ['+2023-04-30T', 11, '2023-04-30'],
  ['+12345678901234560400-02-29T', 11, '12345678901234560400-02-29'],
  ...[
    '2023-02-29',
    '1900-02-29',
    '2100-02-29',
    '2024-02-30',
    '2023-04-31',
    '2023-06-31',
    '2023-09-31',
    '2023-11-31',
    '2023-01-32',
    '2023-01-00',
    '2023-00-01',
    '2023-13-01',
    '0000-01-01',
    '-0001-01-01',
    '12345678901234560100-02-29',
  ].map((day) => [`${day}T`, 11, undefined]),
  ['+2024-01-01T', 8, undefined],
  ['+2024-01-01T', 10.5, undefined],
])('Subject structured date %s at precision %s', (time, precision, expected) => {
  for (const content of [
    { time, precision },
    { type: 'value', content: { time, precision } },
  ]) {
    const data = subjectJsonLd({
      subject: {
        id: 'book',
        type: 'schema:Book',
        labels: {},
        descriptions: {},
        aliases: {},
        statements: {
          'schema:datePublished': [
            {
              rank: 'normal',
              property: { data_type: 'time' },
              value: { type: 'value', content },
              qualifiers: [],
              references: [],
            },
          ],
        },
      },
      related: {},
      locale: 'en',
      url: 'https://rezics.com/en/subjects/book',
    } as never);
    if (expected === undefined) expect(data).not.toHaveProperty('datePublished');
    else expect(data.datePublished).toBe(expected);
  }
});
