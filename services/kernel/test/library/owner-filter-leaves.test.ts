import { expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest } from '@rezics/definitions';
import type { FilterDocument } from '@rezics/filter';
import type { LeafEvidence } from '../../src/semantic/scope-leaf-evidence.ts';
import { compileCurrentOwnerFilter, currentOwnerClauseKey } from '../../src/search/current-filter-plan.ts';
import { fixture, libraryProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import {
  evaluateOwnerFilterLeaves,
  matchOwnerFilterCatalogue,
  matchOwnerFilterState,
  matchOwnerFilterSupport,
  ownerFilterStateWinner,
  type OwnerFilterEntryFact,
  type OwnerFilterNativeFact,
} from '../../src/library/owner-filter.ts';

async function meaning() {
  const release = await compileCatalogue(fixture(libraryProfile('fixture.parent'), libraryProfile('fixture.child')));
  const digest = releaseDigest(release);
  const pin = {
    provenance: 'profile' as const,
    releaseDigest: digest,
    acceptingType: 'ex:Child',
    profileId: 'fixture.child',
  };
  return { release, pin, releases: new Map([[digest, release]]) };
}

test('state compares the native live winner before predicate matching and preserves missing sequence uncertainty', async () => {
  const { pin, releases, release } = await meaning();
  const states = release.libraryProfiles![pin.profileId]!.entryStateSet!;
  const first = states.states[0]!;
  const second = states.states.find((state) => state.id !== first.id)!;
  expect(second).toBeDefined();
  const older: OwnerFilterEntryFact = {
    kind: 'entry',
    subjectId: 'older-original',
    state: first.id,
    ownerWriteSeq: 9007199254740993n,
    pin,
  };
  const newer: OwnerFilterEntryFact = {
    ...older,
    subjectId: 'newer-original',
    state: second.id,
    ownerWriteSeq: 9007199254740994n,
  };
  const leaf = { profileId: pin.profileId, stateSetId: states.id, in: [first.id] };
  expect(matchOwnerFilterState(leaf, ownerFilterStateWinner([older, newer]), releases)).toBe(false);
  expect(matchOwnerFilterState(leaf, ownerFilterStateWinner([newer, older]), releases)).toBe(false);
  // Clear removes the live competitor. Undo's fresh sequence can then win with the original accepted meaning.
  expect(matchOwnerFilterState(leaf, ownerFilterStateWinner([older]), releases)).toBe(true);
  const restored = { ...older, ownerWriteSeq: 9007199254740995n };
  expect(matchOwnerFilterState(leaf, ownerFilterStateWinner([newer, restored]), releases)).toBe(true);
  expect(matchOwnerFilterState(leaf, ownerFilterStateWinner([]), releases)).toBe(false);
  expect(ownerFilterStateWinner([newer, { ...older, ownerWriteSeq: null }])).toBe('not_proven');
  expect(matchOwnerFilterState(leaf, newer, new Map())).toBe('not_proven');
});

test('label presence needs no profile while retained session and holding use their accepting pin', async () => {
  const { pin, release, releases } = await meaning();
  const profile = release.libraryProfiles![pin.profileId]!;
  const progress = profile.progress!.allowed[0]!;
  const kind = profile.copies!.kinds[0]!;
  const status = kind.statuses[0]!;
  const label: OwnerFilterNativeFact = {
    kind: 'label',
    subjectId: 'label-only',
    labelId: 'label',
    assignmentId: 'assignment',
  };
  expect(matchOwnerFilterSupport({ presence: true }, label, new Map())).toBe(true);
  expect(matchOwnerFilterSupport({ label: { id: 'label' } }, label, new Map())).toBe(true);
  expect(matchOwnerFilterSupport({ label: { id: 'other' } }, label, releases)).toBe(false);
  const session: OwnerFilterNativeFact = {
    kind: 'session',
    subjectId: 'session-only',
    sessionId: 'session',
    lifecycle: 'completed',
    mode: progress.mode,
    unit: progress.units[0]!.id,
    pin,
  };
  expect(matchOwnerFilterSupport({ presence: true }, session, releases)).toBe(true);
  expect(
    matchOwnerFilterSupport({ session: { profileId: pin.profileId, lifecycle: 'completed' } }, session, releases),
  ).toBe(true);
  expect(
    matchOwnerFilterSupport({ session: { profileId: pin.profileId, lifecycle: 'active' } }, session, releases),
  ).toBe(false);
  // Presence depends on current native support, independently of accepted profile meaning.
  expect(matchOwnerFilterSupport({ presence: true }, { ...session, pin: null }, releases)).toBe(true);
  expect(
    matchOwnerFilterSupport(
      { session: { profileId: pin.profileId, lifecycle: 'completed' } },
      { ...session, pin: null },
      releases,
    ),
  ).toBe('not_proven');
  const copy: OwnerFilterNativeFact = {
    kind: 'holding',
    subjectId: 'copy-only',
    copyId: 'copy',
    copyKind: kind.id,
    status: status.id,
    pin,
  };
  expect(matchOwnerFilterSupport({ presence: true }, copy, releases)).toBe(true);
  expect(matchOwnerFilterSupport({ holding: { profileId: pin.profileId } }, copy, releases)).toBe(true);
  expect(
    matchOwnerFilterSupport(
      { holding: { profileId: pin.profileId, kind: kind.id, status: status.id } },
      copy,
      releases,
    ),
  ).toBe(true);
  expect(
    matchOwnerFilterSupport(
      { holding: { profileId: pin.profileId, kind: 'another-kind', status: status.id } },
      copy,
      releases,
    ),
  ).toBe(false);
  expect(
    matchOwnerFilterSupport(
      { holding: { profileId: pin.profileId, kind: kind.id, status: 'another-status' } },
      copy,
      releases,
    ),
  ).toBe(false);
  expect(matchOwnerFilterSupport({ holding: { profileId: pin.profileId } }, copy, new Map())).toBe('not_proven');
});

test('native evidence feeds every owner/catalogue leaf to the shared Boolean compiler before evaluation', () => {
  const state = { owner: { state: { profileId: 'profile', stateSetId: 'set', in: ['completed'] } } };
  const filter: FilterDocument = {
    and: [
      { type: { in: ['ex:Book'] } },
      { owner: { presence: true } },
      {
        or: [
          state,
          { owner: { label: { id: '00000000-0000-4000-8000-000000000001' } } },
          { owner: { session: { profileId: 'profile', lifecycle: 'completed' } } },
          { owner: { holding: { profileId: 'profile', kind: 'physical', status: 'kept' } } },
        ],
      },
      { not: state },
    ],
  };
  const plan = compileCurrentOwnerFilter(filter);
  expect(plan.leaves).toHaveLength(6);
  const values = new Map(
    plan.leaves.map((leaf) => [
      currentOwnerClauseKey(leaf),
      leaf.kind === 'catalogue' || 'presence' in leaf.leaf.owner,
    ]),
  );
  const label = plan.leaves.find((leaf) => leaf.kind === 'owner' && 'label' in leaf.leaf.owner)!;
  values.set(currentOwnerClauseKey(label), true);
  expect(evaluateOwnerFilterLeaves(plan, values)).toBe(true);
  const stateKey = currentOwnerClauseKey(
    plan.leaves.find((leaf) => leaf.kind === 'owner' && 'state' in leaf.leaf.owner)!,
  );
  const unknown = new Map<string, boolean | 'not_proven'>(values);
  unknown.set(stateKey, 'not_proven');
  expect(evaluateOwnerFilterLeaves(plan, unknown)).toBe('not_proven');
  // Even a branch whose sibling is already true must have a current admitted result.
  values.delete(
    currentOwnerClauseKey(plan.leaves.find((leaf) => leaf.kind === 'owner' && 'holding' in leaf.leaf.owner)!),
  );
  expect(() => evaluateOwnerFilterLeaves(plan, values)).toThrow('Incomplete owner-filter observations');
});

test('catalogue partial/basis-changed evidence cannot become negative evidence under NOT', () => {
  const leaf = { kind: 'catalogue' as const, clause: { facet: 'type' as const, values: ['ex:Book'] } };
  const evidence: Extract<LeafEvidence, { state: 'current' }> = {
    state: 'current',
    basis: 'native-basis',
    type: null,
    facts: [],
    coverage: null,
    progress: null,
    usage: { keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 },
  };
  expect(matchOwnerFilterCatalogue(leaf, evidence)).toBe('not_proven');
  expect(matchOwnerFilterCatalogue(leaf, { ...evidence, coverage: { kind: 'selection', basis: 'stale' } })).toBe(
    'not_proven',
  );
  expect(matchOwnerFilterCatalogue(leaf, { ...evidence, coverage: { kind: 'selection', basis: evidence.basis } })).toBe(
    false,
  );
  expect(matchOwnerFilterCatalogue(leaf, { ...evidence, type: 'ex:Book' })).toBe(true);
  expect(matchOwnerFilterCatalogue(leaf, { state: 'basis_changed', usage: evidence.usage })).toBe('not_proven');
});
