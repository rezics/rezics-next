import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '../src/index.ts';

test('released weight, source metric and spoiler remain qualifiers of one descendant tag statement', () => {
  const input = {
    and: [
      { type: { in: ['schema:Book'] } },
      {
        statement: {
          property: 'schema:genre',
          in: ['018f0000-0000-7000-8000-00a000000011'],
          concept: { scheme: '018f0000-0000-7000-8000-00a000000010', includeChildren: true },
          qualifiers: [
            { property: 'rezics:sourceTagWeight', range: { gte: 2, lte: 3, unit: '1' } },
            { property: 'rezics:sourceTagWeightMetric', in: ['vndbTagsRating'] },
            { property: 'rezics:spoilerLevel', in: ['0', '1', '2'] },
          ],
        },
      },
    ],
  } as const;
  const parsed = parseFilter(input);
  const admitted = admitFilter(parsed, bundledRelease, { spoilerThreshold: 1 });
  expect(admitted).toEqual({
    and: [
      input.and[0],
      {
        statement: {
          ...input.and[1]!.statement,
          qualifiers: [
            input.and[1]!.statement!.qualifiers[0],
            input.and[1]!.statement!.qualifiers[1],
            { property: 'rezics:spoilerLevel', in: ['0', '1'] },
          ],
        },
      },
    ],
  });
  expect(parsed).toEqual(input);
});
