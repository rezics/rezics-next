import { expect, test } from 'bun:test';
import {
  MEMBERS_PREPARATION_SOURCE_AXES,
  MEMBERS_PREPARATION_SOURCE_DECLARATION,
  MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS,
  MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS,
  MEMBERS_PREPARATION_SOURCE_PATHS,
  sumMembersPreparationSourceTerms,
} from '../../src/search/scope-members-source-declaration.ts';
import { MEMBERS_DEFINITION_QUERY_BOUNDS } from '../../src/search/scope-members-work-cost.ts';

test('the Members Source subtotal composes finite named axes and refuses an incomplete quote', () => {
  expect(MEMBERS_PREPARATION_SOURCE_AXES).toEqual([
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
    'engineRequests',
  ]);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.status).toBe('incomplete');
  expect('cost' in MEMBERS_PREPARATION_SOURCE_DECLARATION).toBe(false);
  for (const dependency of MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS)
    expect(dependency.axes).toEqual(MEMBERS_PREPARATION_SOURCE_AXES);
  expect(MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS.map(({ name, multiplicity }) => [name, multiplicity])).toEqual([
    ['library-source-metadata-prefix', 1],
    ['read-members-snapshot', 8],
    ['members-terminal', 99],
    ['group', 1],
    ['closure', 100],
    ['first-members-ordinal', 99],
  ]);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.knownSubtotal).toEqual({
    candidateKeys: 5_298,
    nativeRows: 166_193,
    identityMetadataRows: 1_584,
    nativePoints: 867,
    witnessKeys: 5_298,
    statements: 331,
    bytes: 22_253_184,
    emptySeeks: 360,
    engineRequests: 0,
  });
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.id.definitionGetters).toBe(15);
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.definitionGetters).toBe(11);
  const missing = MEMBERS_PREPARATION_SOURCE_DECLARATION.missing.map(({ name }) => name);
  expect(missing).toContain('selected-runtime-source-field-and-final-authority');
  expect(missing).not.toContain('search-scope-members-query-aggregate');

  expect(
    sumMembersPreparationSourceTerms([
      MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!,
      { ...MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!, multiplicity: 2 },
    ]),
  ).toEqual({
    candidateKeys: 0,
    nativeRows: 135,
    identityMetadataRows: 0,
    nativePoints: 135,
    witnessKeys: 0,
    statements: 48,
    bytes: 59_774_976,
    emptySeeks: 135,
    engineRequests: 0,
  });
  expect(MEMBERS_DEFINITION_QUERY_BOUNDS.releaseProjection).toEqual({
    maxExpandedVarlenaBytes: 1024 ** 3,
    byteMultiplier: 6,
    fixedBytes: 1024,
  });
  expect(() =>
    sumMembersPreparationSourceTerms([{ ...MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!, name: 'unpriced-child' }]),
  ).toThrow('Unknown or unbounded Members Source term');
  expect(() =>
    sumMembersPreparationSourceTerms([
      {
        ...MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!,
        cost: { ...MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!.cost, bytes: Number.POSITIVE_INFINITY },
      },
    ]),
  ).toThrow('Unknown or unbounded Members Source term');
});
