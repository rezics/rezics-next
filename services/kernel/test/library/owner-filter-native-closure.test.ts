import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { readCanonicalSourceGroup, readCanonicalSourceState } from '../../src/library/canonical-source-store.ts';
import { ownerFilterCanonicalAllowance } from '../../src/library/owner-filter-native-binding.ts';
import { scopeAllowance } from '../../src/work-ledger/scope-work.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import {
  createOwnerFilterFixture,
  ownerStatus,
  ownerString,
  type OwnerFilterFixture,
} from './support/owner-filter-fixture.ts';

function stateSource(f: OwnerFilterFixture) {
  return builtinCollectionId(f.native.personas.alice.accountId, {
    kind: 'state',
    profileId: f.profileId,
    stateSetId: f.stateSet.id,
    stateId: f.state.id,
  });
}

async function merge(f: OwnerFilterFixture, left: string, right: string) {
  const response = await f.native.request(
    'acceptor',
    'POST',
    '/v1/subjects:merge',
    {
      subjects: [left, right],
    },
    discoveryKey(),
  );
  ownerStatus(response, 200);
  const survivor = ownerString(response.body.survivor);
  expect([left, right]).toContain(survivor);
  expect(response.body.redirected).toBe(left === survivor ? right : left);
  return survivor;
}

test('An owner state Source closes complete independent original support and latest native state before matching without borrowing a positive alias or private fact fallback', async () => {
  const f = await createOwnerFilterFixture();
  try {
    await f.native.grant('acceptor', ['gate:subject_identity'], GLOBAL_CONTEXT);
    const rawEntries = () =>
      f.native.inspect(
        `SELECT subject_id,state,owner_write_seq::text,library_profile_pin FROM library.entry
       WHERE route=$1 AND account_id=$2 ORDER BY subject_id`,
        [routeOf(f.native.personas.alice.accountId), f.native.personas.alice.accountId],
      );
    const before = await rawEntries();
    let terminal = f.subjects.entry.id;
    for (const original of [f.subjects.labelOnly.id, f.subjects.sessionOnly.id, f.subjects.copyOnly.id])
      terminal = await merge(f, terminal, original);
    const source = stateSource(f);
    // These supporters have no entry of their own. The chosen state Source's raw entry slice cannot cover them.
    for (const query of [f.leaves.state, f.leaves.label, f.leaves.session, f.leaves.qualifiedHolding])
      expect(await f.members(query, 'alice', source)).toEqual([terminal]);
    expect(await f.members({ not: f.leaves.label }, 'alice', source)).toEqual([]);
    ownerStatus(await f.native.request('bob', 'GET', f.path(f.leaves.label, undefined, source)), 404);
    ownerStatus(await f.native.request('anonymous', 'GET', f.path(f.leaves.label, undefined, source)), 404);
    // No state write or repinning can be a side effect of closing another original's support.
    expect((await rawEntries()).rows).toEqual(before.rows);
  } finally {
    await f.close();
  }
}, 180_000);

for (const requestedIsLatest of [false, true])
  test(`state Source matching chooses native sequence before the requested state (requested latest: ${requestedIsLatest})`, async () => {
    const f = await createOwnerFilterFixture();
    try {
      await f.native.grant('acceptor', ['gate:subject_identity'], GLOBAL_CONTEXT);
      const otherState = f.stateSet.states.find((choice) => choice.id !== f.state.id);
      expect(otherState).toBeDefined();
      const requested = await f.native.createSubject(f.type, 'Requested state original');
      const other = await f.native.createSubject(f.type, 'Other state original');
      const writes = [
        { subject: requested.id, state: f.state.id },
        { subject: other.id, state: otherState!.id },
      ];
      if (requestedIsLatest) writes.reverse();
      for (const write of writes)
        ownerStatus(
          await f.native.request(
            'alice',
            'PUT',
            `/v1/libraryEntries/${write.subject}`,
            { state: write.state },
            discoveryKey(),
          ),
          201,
        );
      const before = await f.native.inspect(
        `SELECT subject_id,state,owner_write_seq::text,library_profile_pin FROM library.entry
         WHERE route=$1 AND account_id=$2 AND subject_id=ANY($3::uuid[]) ORDER BY subject_id`,
        [routeOf(f.native.personas.alice.accountId), f.native.personas.alice.accountId, [requested.id, other.id]],
      );
      const terminal = await merge(f, requested.id, other.id);
      const expected = [f.subjects.entry.id, ...(requestedIsLatest ? [terminal] : [])].sort();
      expect(await f.members(f.leaves.state, 'alice', stateSource(f))).toEqual(expected);
      const after = await f.native.inspect(
        `SELECT subject_id,state,owner_write_seq::text,library_profile_pin FROM library.entry
         WHERE route=$1 AND account_id=$2 AND subject_id=ANY($3::uuid[]) ORDER BY subject_id`,
        [routeOf(f.native.personas.alice.accountId), f.native.personas.alice.accountId, [requested.id, other.id]],
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await f.close();
    }
  }, 180_000);

test('a hidden independent support original cannot disclose through a matching state sibling', async () => {
  const f = await createOwnerFilterFixture();
  try {
    await f.native.grant('acceptor', ['gate:subject_identity', 'moderation:hide'], GLOBAL_CONTEXT);
    const subjects = await Promise.all([
      f.native.createSubject(f.type, 'Readable state sibling'),
      f.native.createSubject(f.type, 'Excluded support sibling'),
    ]);
    const [terminal, excluded] = subjects.map((subject) => subject.id).sort() as [string, string];
    ownerStatus(
      await f.native.request('alice', 'PUT', `/v1/libraryEntries/${terminal}`, { state: f.state.id }, discoveryKey()),
      201,
    );
    ownerStatus(
      await f.native.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${f.labelId}:assign`,
        { subjectId: excluded },
        discoveryKey(),
      ),
      200,
    );
    expect(await merge(f, terminal, excluded)).toBe(terminal);
    expect(await f.members(f.leaves.label, 'alice', stateSource(f))).toEqual([terminal]);
    ownerStatus(
      await f.native.request(
        'acceptor',
        'POST',
        `/v1/subjects/${excluded}:hide`,
        { reason: 'Independent excluded original disclosure' },
        discoveryKey(),
      ),
      200,
    );
    // The readable matching sibling cannot authorize facts on the hidden original, even under NOT.
    const response = await f.native.request(
      'alice',
      'GET',
      f.path({ not: f.leaves.session }, undefined, stateSource(f)),
    );
    ownerStatus(response, 503);
    expect(response.body).not.toHaveProperty('members');
  } finally {
    await f.close();
  }
}, 180_000);

test('state closure refuses missing generation coverage and a changed actual native owner basis', async () => {
  let pool: Pool | undefined;
  const f = await createOwnerFilterFixture({
    kernelPool(url) {
      pool = new Pool({ connectionString: url });
      return pool;
    },
  });
  try {
    const source = stateSource(f);
    expect(await f.members(f.leaves.state, 'alice', source)).toEqual([f.subjects.entry.id]);
    const call = () => ({
      route: routeOf(source)!,
      collectionId: source,
      deadline: Date.now() + 30_000,
      allowance: ownerFilterCanonicalAllowance(scopeAllowance(100, randomUUID())),
    });
    const state = await readCanonicalSourceState(pool!, call());
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('Actual current state Source generation required');
    expect(state.basis.originalCoverage).toBe('owner-facts-v1');
    const progress = {
      pendingSubjectId: f.subjects.entry.id,
      after: null,
      generation: state.generation,
      basis: state.basis,
    };
    const missing = await readCanonicalSourceGroup(pool!, {
      ...call(),
      basis: state.basis,
      progress: { ...progress, generation: randomUUID() },
    });
    expect(missing.state).toBe('not_ready');
    ownerStatus(
      await f.native.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${f.labelId}:assign`,
        { subjectId: f.subjects.entry.id },
        discoveryKey(),
      ),
      200,
    );
    const changed = await readCanonicalSourceGroup(pool!, { ...call(), basis: state.basis, progress });
    expect(changed.state).toBe('not_ready');
    expect(changed).not.toHaveProperty('rows');
  } finally {
    // The native fixture owns the supplied pool and database lifecycle.
    await f.close();
  }
}, 180_000);
