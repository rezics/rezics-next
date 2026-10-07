import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { commandProfiles } from '../compiler/generate.ts';
import { profileSource } from '../compiler/shacl.ts';
import { structureWorkCompositionProfile } from '../definitions/structure-work-composition-v1.ts';
import { structureCompositionProfile } from '../definitions/structure-composition-v1.ts';

test('G-830: Work membership has a qualified occurrence and never a top-level exclusion predicate', () => {
  const owner = profileSource(structureWorkCompositionProfile);
  const kernel = profileSource(structureCompositionProfile);
  expect(owner).toContain('rv:RequiredPart');
  expect(owner).toContain('rv:OptionalPart');
  expect(owner).toContain('rv:ExtraPart');
  expect(owner).toContain('rv:displayLabel');
  expect(owner).toContain('rv:WorkComposition');
  expect(owner).toContain('rv:PartRole');
  expect(kernel).not.toContain('rv:WorkComposition');
  expect(kernel).not.toContain('rv:PartRole');
  expect(createHash('sha256').update(kernel).digest('hex')).toBe('d6bcd8a0f349a7d9926298317e24086ce038a4596c5fcb73f0a1d09a5c105bf0');
  expect(commandProfiles([structureWorkCompositionProfile], { established: {}, canonicalOrder: [], demandOrder: [] })
    .profiles[0]!.sha256).toBe(createHash('sha256').update(owner).digest('hex'));
  expect(owner).not.toContain('sh:path schema:isPartOf');
  expect(owner).not.toContain('schema:Book');
});
