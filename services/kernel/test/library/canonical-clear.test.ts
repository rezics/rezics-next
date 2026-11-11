import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import {
  readNativeCollectionStateGroup,
  readNativeCollectionWorkingMetadata,
} from '../../src/library/collection-source-native.ts';
import { currentOwnerState, readOwnerOriginalTruth } from '../../src/library/owner-index.ts';
import { withConnection } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { sourceAllowance } from './support/canonical-source-runtime-fixture.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import {
  createOwnerFilterFixture,
  ownerRecord,
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
    { subjects: [left, right] },
    discoveryKey(),
  );
  ownerStatus(response, 200);
  return ownerString(response.body.survivor);
}

async function clearEntry(f: OwnerFilterFixture, subjectId: string, key = discoveryKey()) {
  const read = await f.native.request('alice', 'GET', `/v1/libraryEntries/${subjectId}`);
  ownerStatus(read, 200);
  ownerRecord(read.body.libraryEntry);
  const entry = read.body.libraryEntry;
  if (typeof entry.revision !== 'number') throw new Error('Entry read has no revision');
  const incarnationId = ownerString(entry.incarnationId);
  const query = new URLSearchParams({ revision: String(entry.revision), incarnationId });
  const path = `/v1/libraryEntries/${subjectId}?${query}`;
  const response = await f.native.request('alice', 'DELETE', path, undefined, key);
  ownerStatus(response, 204);
  const deletionRevision = ownerString(response.headers.get('Library-Entry-Deletion-Revision'));
  expect(deletionRevision).toBe(String(entry.revision + 1));
  return {
    key,
    path,
    response,
    deletionId: ownerString(response.headers.get('Library-Entry-Deletion-Id')),
    revision: Number(deletionRevision),
  };
}

test('canonical clear wins the merged state fibre, follows its original across splits, and never supplies presence', async () => {
  let pool: Pool | undefined;
  const f = await createOwnerFilterFixture({
    kernelPool(url) {
      pool = new Pool({ connectionString: url });
      return pool;
    },
  });
  try {
    await f.native.grant('acceptor', ['gate:subject_identity'], GLOBAL_CONTEXT);
    const ownerId = f.native.personas.alice.accountId;
    const older = f.subjects.entry.id;
    const newer = (await f.native.createSubject(f.type, 'Later state original')).id;
    const written = await f.native.request(
      'alice',
      'PUT',
      `/v1/libraryEntries/${newer}`,
      { state: f.state.id },
      discoveryKey(),
    );
    ownerStatus(written, 201);
    const terminal = await merge(f, older, newer);
    const source = stateSource(f);
    expect(await f.members(f.leaves.state, 'alice', source)).toEqual([terminal]);

    const group = async () => {
      const { metadata } = await readNativeCollectionWorkingMetadata(
        pool!,
        { route: routeOf(source)!, collectionId: source },
        { deadline: Date.now() + 30_000, allowance: sourceAllowance() },
      );
      if (!metadata) throw new Error('Current native state Source metadata is missing');
      return readNativeCollectionStateGroup(pool!, metadata, {
        originals: [older, newer],
        deadline: Date.now() + 30_000,
        allowance: sourceAllowance(),
      });
    };
    expect((await group()).result).toBe(true);

    const deletion = await clearEntry(f, newer);
    expect(deletion.response.headers.get('Library-Entry-Deletion-Revision')).toBe(String(deletion.revision));
    expect(await f.members(f.leaves.state, 'alice', source)).toEqual([]);
    expect((await group()).result).toBe(false);
    const clearedTruth = await withConnection(pool!, async (client) =>
      Promise.all([readOwnerOriginalTruth(client, ownerId, older), readOwnerOriginalTruth(client, ownerId, newer)]),
    );
    expect(currentOwnerState(clearedTruth)).toMatchObject({
      status: 'complete',
      state: null,
      clear: { original: newer },
    });
    expect(currentOwnerState([clearedTruth[0]!])).toMatchObject({
      status: 'complete',
      state: { original: older, id: f.state.id },
    });

    const register = await pool!.query<{ owner_write_seq: string; transaction_id: string }>(
      `SELECT owner_write_seq::text, transaction_id::text FROM library.entry_clear
       WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [routeOf(ownerId), ownerId, newer],
    );
    expect(register.rows).toHaveLength(1);
    const replay = await f.native.request('alice', 'DELETE', deletion.path, undefined, deletion.key);
    ownerStatus(replay, 204);
    expect(replay.headers.get('Library-Entry-Deletion-Id')).toBe(deletion.deletionId);
    const replayedRegister = await pool!.query(
      `SELECT owner_write_seq::text, transaction_id::text FROM library.entry_clear
       WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [routeOf(ownerId), ownerId, newer],
    );
    expect(replayedRegister.rows).toEqual(register.rows);

    const restored = await f.native.request(
      'alice',
      'POST',
      `/v1/libraryEntries/${newer}:restore`,
      { deletionId: deletion.deletionId, revision: deletion.revision },
      discoveryKey(),
    );
    ownerStatus(restored, 200);
    expect(await f.members(f.leaves.state, 'alice', source)).toEqual([terminal]);
    expect((await group()).result).toBe(true);
    const restoredTruth = await withConnection(pool!, async (client) =>
      Promise.all([readOwnerOriginalTruth(client, ownerId, older), readOwnerOriginalTruth(client, ownerId, newer)]),
    );
    const restoredWinner = currentOwnerState(restoredTruth);
    expect(restoredWinner).toMatchObject({ status: 'complete', state: { original: newer, id: f.state.id } });
    if (restoredWinner.status !== 'complete' || !restoredWinner.state)
      throw new Error('Undo must restore a current entry state');
    expect(restoredWinner.state.sequence).toBeGreaterThan(BigInt(register.rows[0]!.owner_write_seq));

    const clearOnly = (await f.native.createSubject(f.type, 'Clear-only presence check')).id;
    ownerStatus(
      await f.native.request('alice', 'PUT', `/v1/libraryEntries/${clearOnly}`, { state: f.state.id }, discoveryKey()),
      201,
    );
    ownerStatus(
      await f.native.request(
        'alice',
        'POST',
        `/v1/collections/${f.collectionId}/members`,
        { subjectId: clearOnly },
        discoveryKey(),
      ),
      201,
    );
    expect(await f.members(f.leaves.presence, 'alice', f.collectionId)).toContain(clearOnly);
    await clearEntry(f, clearOnly);
    expect(await f.members(f.leaves.presence, 'alice', f.collectionId)).not.toContain(clearOnly);
    const occurrence = await pool!.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM library.collection_member
       WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deleted_at IS NULL`,
      [routeOf(f.collectionId), f.collectionId, clearOnly],
    );
    expect(occurrence.rows[0]?.count).toBe(1);
  } finally {
    await f.close();
  }
}, 180_000);
