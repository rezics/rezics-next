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
  expect(
    MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS.every((dependency) =>
      dependency.axes.length === MEMBERS_PREPARATION_SOURCE_AXES.length &&
      MEMBERS_PREPARATION_SOURCE_AXES.every((axis) => dependency.axes.includes(axis)),
    ),
  ).toBe(true);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.knownSubtotal).toEqual({
    candidateKeys: 0,
    nativeRows: 45,
    identityMetadataRows: 0,
    nativePoints: 45,
    witnessKeys: 0,
    statements: 16,
    bytes: 19_924_992,
    emptySeeks: 45,
    engineRequests: 0,
  });
  expect(MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]?.multiplicity).toBe(1);
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.id.definitionGetters).toBe(15);
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.definitionGetters).toBe(11);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.missing.map(({ name }) => name)).toContain(
    'selected-runtime-source-field-and-final-authority',
  );
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.missing.map(({ name }) => name)).toContain(
    'search-scope-members-query-aggregate',
  );

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
    sumMembersPreparationSourceTerms([
      { ...MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS[0]!, name: 'unpriced-child' },
    ]),
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
