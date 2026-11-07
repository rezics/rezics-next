import { expect, test } from 'bun:test';
import type { AccountActor } from '../../src/request/access.ts';

const original = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const moved = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const deleted = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const missing = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const liveDeletedName = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const resolutions: string[] = [];
let observationCurrent = true;
const attributions = new Map<
  string,
  { id: string; kind: 'actor'; displayName: string } | { displayName: 'Deleted account' } | null
>([[original, { id: original, kind: 'actor', displayName: 'Owner' }]]);

import {
  createLibraryPresentationApplication,
  createSubjectPresentationApplication,
} from '../../src/library/application/index.ts';
import type { SubjectIdentityObservation, SubjectIdentityCapability } from '../../src/library/contract/index.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { withFollowContribution } from '../../src/library/follow-contribution.ts';

// The consumer seam replaces global module mocks; all existing observable assertions stay intact.
let currentTerminal = original;
const identity: SubjectIdentityCapability<undefined, SubjectIdentityObservation> = {
  validId: () => true,
  redirected: (from, to) => new Error(`${from} redirects to ${to}`),
  readMappings: async (_context, ids) =>
    ids.map((id) => {
      currentTerminal = resolutions.shift() ?? id;
      return { state: 'mapped', terminal: currentTerminal, epoch: 1n };
    }),
  prepareReference: async (_context, id) => async () =>
    id === currentTerminal ? { state: 'present' } : { state: 'redirect', from: id, to: currentTerminal },
};
const deps = {};
const unavailable = () => new ProblemError('dependency_unavailable');
async function fullView<T>(
  _deps: unknown,
  _actor: AccountActor,
  view: string,
  body: T,
  options: { follow?: true; withholdChangedSource?: true } = {},
) {
  const withholdChangedSource = options.follow === true || options.withholdChangedSource === true;
  const subjects = createSubjectPresentationApplication(identity, {
    unavailable,
    observe: async (ids) => ({
      current: async () => observationCurrent,
      summaries: new Map(ids.map((id) => [id, { id, type: 'schema:Book', label: { value: 'Book', language: 'en' } }])),
    }),
  });
  const full = createLibraryPresentationApplication({
    unavailable,
    subjects: (ids) => subjects(undefined, ids, withholdChangedSource),
    account: async () => ({
      value: { id: original, handle: 'owner', displayName: 'Owner' },
      current: async () => true,
    }),
    attributions: async (ids) => ({
      value: new Map(ids.map((id) => [id, attributions.get(id) ?? null])),
      current: async () => true,
    }),
    target: async () => ({ value: null, current: async () => true }),
  });
  return full(view, body, { withholdChangedSource });
}

const actor: AccountActor = {
  kind: 'account',
  accountId: original,
  clientId: 'follow-withhold',
  scopes: ['follow:read', 'library_entry:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const edge = {
  targetId: original,
  targetType: 'subject' as const,
  state: 'following' as const,
  reason: 'explicit' as const,
  updatedAt: '2026-11-06T00:00:00.000Z',
};

test('FULL follow withholds a changed Source and keeps the private edge', async () => {
  observationCurrent = true;
  resolutions.splice(0, resolutions.length, original, moved);
  const withheld = await fullView(deps, actor, 'FULL', { follows: [edge] }, { follow: true });
  expect(withheld.follows[0]).toEqual({ ...edge, target: null });
});

test('point contribution projection cannot replace a FULL target withheld by the Source gate', async () => {
  const contribution = { id: moved, kind: 'actor' as const, displayName: 'Current owner' };
  const withheld = withFollowContribution({ ...edge, target: null }, contribution, true);
  expect(withheld).toEqual({ ...edge, target: null });

  const current = withFollowContribution(
    { ...edge, target: { id: original, type: 'schema:Book', label: 'Book' } },
    contribution,
    true,
  );
  expect(current.target).toEqual(contribution);

  const basic = withFollowContribution({ ...edge }, contribution, false);
  expect(basic.target).toEqual(contribution);
});

test('non-follow FULL still refuses a changed Source', async () => {
  observationCurrent = true;
  resolutions.splice(0, resolutions.length, original, moved);
  await expect(fullView(deps, actor, 'FULL', { libraryEntries: [{ subjectId: original }] })).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
});

test('FULL published-log withholds a changed Source and keeps the public snapshot', async () => {
  observationCurrent = true;
  resolutions.splice(0, resolutions.length, original, moved);
  const snapshot = {
    id: original,
    accountId: actor.accountId,
    subjectId: original,
    sessionState: 'completed' as const,
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: '2026-11-06T01:00:00.000Z',
    note: 'kept',
    publishedAt: '2026-11-06T01:00:00.000Z',
  };
  const withheld = await fullView(deps, actor, 'FULL', { publishedLog: snapshot }, { withholdChangedSource: true });
  expect(withheld.publishedLog).toEqual({
    ...snapshot,
    subject: null,
    account: { id: original, handle: 'owner', displayName: 'Owner' },
    attribution: { id: original, kind: 'actor', displayName: 'Owner' },
  });
});

test('FULL published-log attribution keeps live identity, an id-free deletion label, and unknown', async () => {
  observationCurrent = true;
  attributions.set(deleted, { displayName: 'Deleted account' });
  attributions.set(missing, null);
  attributions.set(liveDeletedName, { id: liveDeletedName, kind: 'actor', displayName: 'Deleted account' });
  const log = (accountId: string) => ({
    id: accountId,
    accountId,
    subjectId: original,
    sessionState: 'completed' as const,
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: '2026-11-06T01:00:00.000Z',
    note: 'kept',
    publishedAt: '2026-11-06T01:00:00.000Z',
  });
  resolutions.splice(
    0,
    resolutions.length,
    original,
    original,
    original,
    original,
    original,
    original,
    original,
    original,
  );
  const page = await fullView(
    deps,
    actor,
    'FULL',
    { publishedLogs: [log(original), log(deleted), log(missing), log(liveDeletedName)] },
    { withholdChangedSource: true },
  );
  expect(page.publishedLogs.map((row) => row.attribution)).toEqual([
    { id: original, kind: 'actor', displayName: 'Owner' },
    { displayName: 'Deleted account' },
    null,
    { id: liveDeletedName, kind: 'actor', displayName: 'Deleted account' },
  ]);
});

test('FULL follow withholds when the summary observation is not current', async () => {
  observationCurrent = false;
  resolutions.splice(0, resolutions.length, original, original);
  const withheld = await fullView(deps, actor, 'FULL', { follows: [edge] }, { follow: true });
  expect(withheld.follows[0]).toEqual({ ...edge, target: null });
});
