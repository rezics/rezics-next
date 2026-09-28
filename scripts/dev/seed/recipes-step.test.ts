import { expect, test } from 'bun:test';
import { scaleExact } from '../../../services/main/src/modules/recipe/quantity.ts';
import { steps } from './cli.ts';
import { seedOfficialZones } from './official-zones-step.ts';
import { pancakeOperations, seedRecipes } from './recipes-step.ts';

test('G-415: Kitchen pancake seed has an exact quantity that visibly scales from four to six servings', () => {
  const operations = pancakeOperations('https://rezics.com/id/00000000-0000-0000-0000-000000000001');
  expect(operations).toHaveLength(10);
  const flour = operations.find(item => item.sourceKey === 'flour');
  if (flour?.qualifier.type !== 'ingredient-line') throw new Error('Flour ingredient missing');
  const scaled = scaleExact({ numerator: BigInt(flour.qualifier.amount.numerator),
    denominator: BigInt(flour.qualifier.amount.denominator) }, { numerator: 3n, denominator: 2n });
  expect(scaled).toEqual({ numerator: 9n, denominator: 4n });
  expect(operations.filter(item => item.role === 'step')).toHaveLength(3);
  expect(new Set(operations.map(item => item.sourceKey)).size).toBe(operations.length);
  expect(steps.indexOf(seedRecipes)).toBe(steps.indexOf(seedOfficialZones) + 1);
});
