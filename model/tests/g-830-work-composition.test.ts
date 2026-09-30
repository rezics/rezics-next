import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import lock from '../accepted/profiles/structure-work-composition-v1.json';
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
  expect(owner).toContain('rv:WorkComposition');
  expect(owner).toContain('rv:PartRole');
  expect(kernel).not.toContain('rv:WorkComposition');
  expect(kernel).not.toContain('rv:PartRole');
  expect(createHash('sha256').update(kernel).digest('hex')).toBe('0043acb8748937d04d177a90695b06ac23fcccd5742b7d0da3c728e2d468d746');
  expect(lock).toEqual({ sha256: createHash('sha256').update(owner).digest('hex') });
  expect(owner).not.toContain('sh:path schema:isPartOf');
  expect(owner).not.toContain('schema:Book');
});
