import { expect, test } from 'bun:test';
import { isStructuralProperty } from '../src/modules/entity-page/structural-properties.ts';
import { RV } from '../src/modules/work/activate.ts';

test('the owner pointer is structure, not a fact of the page', () => {
  expect(isStructuralProperty(`${RV}semanticWork`)).toBe(true);
});

test('descriptive properties stay in the statements disclosure', () => {
  for (const predicate of ['https://schema.org/name', 'https://schema.org/description', `${RV}semanticHead`])
    expect(isStructuralProperty(predicate)).toBe(false);
});
