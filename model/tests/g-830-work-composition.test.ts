import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { structureWorkCompositionProfile } from '../definitions/structure-work-composition-v1.ts';
import { structureCompositionProfile } from '../definitions/structure-composition-v1.ts';

test('G-830: Work membership has a qualified occurrence and never a top-level exclusion predicate', () => {
  const owner = renderProfile(structureWorkCompositionProfile);
  const kernel = renderProfile(structureCompositionProfile);
  expect(owner).toContain('rv:RequiredPart');
  expect(owner).toContain('rv:OptionalPart');
  expect(owner).toContain('rv:ExtraPart');
  expect(owner).toContain('rv:displayLabel');
  expect(kernel).toContain('rv:WorkComposition');
  expect(kernel).toContain('rv:PartRole');
  expect(owner).not.toContain('sh:path schema:isPartOf');
  expect(owner).not.toContain('schema:Book');
});
