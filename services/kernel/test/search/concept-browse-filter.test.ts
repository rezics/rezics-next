import { expect, test } from 'bun:test';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import { compileFilter } from '../../src/search/filter.ts';

test('concept filters do not compile as root-only statement filters', () => {
  expect(() =>
    compileFilter(
      {
        statement: {
          property: 'schema:genre',
          in: ['018f0000-0000-7000-8000-00a000000011'],
          concept: { scheme: '018f0000-0000-7000-8000-00a000000010', includeChildren: true },
        },
      },
      { prefix: 'f', relationOverflow: true },
    ),
  ).toThrow(SearchUnavailableError);
});
