import { expect, test } from 'bun:test';
import { isBound, repeatBound, sumBounds } from '@rezics/bounds';
import {
  MEMBERS_PREPARATION_SOURCE_AXES,
  MEMBERS_PREPARATION_SOURCE_COST,
  MEMBERS_PREPARATION_SOURCE_DECLARATION,
  MEMBERS_PREPARATION_SOURCE_PATHS,
  MEMBERS_PREPARATION_SOURCE_TERMS,
} from '../../src/search/scope-members-source-declaration.ts';
import { COLLECTION_SOURCE_WORK_COST } from '../../src/library/collection-source-work-native.ts';
import { MEMBERS_DEFINITION_QUERY_BOUNDS } from '../../src/search/scope-members-work-cost.ts';
import { MEMBERS_SELECTED_CHILDREN } from '../../src/library/members-preparation-work.ts';

test('the selected Members Source has a complete static bound for the declared call paths', () => {
  expect(MEMBERS_PREPARATION_SOURCE_AXES).toEqual([
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'emptySeeks',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'engineRequests',
  ]);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.status).toBe('complete');
  expect(isBound(MEMBERS_PREPARATION_SOURCE_DECLARATION.cost)).toBe(true);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.cost).toEqual(MEMBERS_PREPARATION_SOURCE_COST);
  expect(MEMBERS_PREPARATION_SOURCE_DECLARATION.cost).toEqual(sumBounds(...Object.values(MEMBERS_PREPARATION_SOURCE_TERMS)));
  expect(MEMBERS_PREPARATION_SOURCE_TERMS.collectionState).toEqual(
    repeatBound(COLLECTION_SOURCE_WORK_COST.state, MEMBERS_PREPARATION_SOURCE_PATHS.id.membersSnapshots),
  );
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.id.membersSnapshots).toBe(8);
  expect(MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.membersSnapshots).toBe(4);
  expect(MEMBERS_SELECTED_CHILDREN.source).toEqual(MEMBERS_PREPARATION_SOURCE_DECLARATION.cost);
  expect(MEMBERS_DEFINITION_QUERY_BOUNDS.releaseProjection).toEqual({
    maxExpandedVarlenaBytes: 1024 ** 3,
    byteMultiplier: 6,
    fixedBytes: 1024,
  });
});
