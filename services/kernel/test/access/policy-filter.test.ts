import { expect, test } from 'bun:test';
import { lowerCollectionListResidual } from '../../src/access/policy-filter.ts';

test('lowerer admits only the fixed Collection row filter', () => {
  expect(
    lowerCollectionListResidual({ format: 'rezics-access-residual/1', root: { op: 'constant', value: true } }),
  ).toMatchObject({ status: 'ready', source: 'curator' });
  expect(
    lowerCollectionListResidual({
      format: 'rezics-access-residual/1',
      root: { op: 'operand', name: 'public.floor' },
    }),
  ).toEqual({ status: 'ready', source: 'public', parameters: { policy_visibility: 'public' } });
  expect(
    lowerCollectionListResidual({
      format: 'rezics-access-residual/1',
      root: { op: 'operand', name: 'account.owner' } as never,
    }),
  ).toEqual({ status: 'unavailable' });
});
