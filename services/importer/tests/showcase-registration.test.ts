import { expect, test } from 'bun:test';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { converter_revision as crossMediaRevision } from '@rezics/conversion/cross-media-entities';
import {
  selectedFamilyAdmission,
  selectedFamilyAliases,
  selectedFamilyRevisions,
} from '../src/registration-contract.ts';
import { bindSourceRegistration, createSelectedFamilySourceRegistration } from '../src/source-registry.ts';

test('selected-family registration binds declared aliases and composed revisions', () => {
  expect(selectedFamilyRevisions.bangumi).toBe(`${crossMediaRevision}+${bangumiRevision}`);
  expect(selectedFamilyRevisions.vndb).toBe(crossMediaRevision);
  for (const kind of ['bangumi', 'vndb'] as const) {
    const admission = selectedFamilyAdmission(kind);
    const registration = bindSourceRegistration(admission);
    expect(registration.source).toBe(selectedFamilyAliases[kind]);
    expect(registration.converter_revision).toBe(selectedFamilyRevisions[kind]);
    const selected = createSelectedFamilySourceRegistration(kind, selectedFamilyAliases[kind]);
    expect(selected.sourceKind).toBe(registration.sourceKind);
    expect(selected.source).toBe(registration.source);
    expect(selected.converter_revision).toBe(registration.converter_revision);
  }
});
