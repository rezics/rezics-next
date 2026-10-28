import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as s from '../../src/library/builtin-reference-store.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name migrated native database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c71,
  id = (n: number) => '00000000-0000-7000-8000-6c71' + n.toString(16).padStart(8, '0');
test('native builtin tuple lookup preserves stable IDs and fences stale source-reference maintenance without creating Collection headers or grants', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const digest = 'sha256:' + 'a'.repeat(64),
      pin = { provenance: 'profile', releaseDigest: digest, acceptingType: 'ex:Game', profileId: 'fixture.game' };
    await c.query(
      "INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,library_profile_pin) VALUES($1,$2,$3,'planned',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z',$4,$5)",
      [route, id(1), id(2), id(80), pin],
    );
    const key = { kind: 'state' as const, profileId: 'fixture.game', stateSetId: 'game.states', stateId: 'planned' };
    const collectionId = builtinCollectionId(id(1), key);
    const input = {
      accountId: id(1),
      subjectId: id(2),
      sourceRevision: 1,
      sourceTransactionId: id(80),
      releaseDigest: digest,
      profileId: key.profileId,
      stateSetId: key.stateSetId,
      stateId: key.stateId,
    };
    expect(await s.readBuiltinStateReference(c, { route, collectionId })).toBeNull();
    expect(await s.bindBuiltinStateReference(c, { ...input, sourceTransactionId: id(99) })).toBeNull();
    expect(await s.readBuiltinStateReference(c, { route, collectionId })).toBeNull();
    const bound = await s.bindBuiltinStateReference(c, input);
    expect(bound).toEqual({ route, collectionId, accountId: id(1), key });
    expect(await s.readBuiltinStateReference(c, { route, collectionId })).toEqual(bound);
    expect(
      (
        await c.query('SELECT collection_id FROM library.collection WHERE route=$1 AND collection_id=$2', [
          route,
          collectionId,
        ])
      ).rows,
    ).toEqual([]);
    await c.query(
      'UPDATE library.entry SET revision=2,transaction_id=$1 WHERE route=$2 AND account_id=$3 AND subject_id=$4',
      [id(81), route, id(1), id(2)],
    );
    expect(await s.bindBuiltinStateReference(c, { ...input, sourceRevision: 2, sourceTransactionId: id(81) })).toEqual(
      bound,
    );
    expect(
      await s.unbindBuiltinStateReference(c, {
        route,
        accountId: id(1),
        subjectId: id(2),
        sourceRevision: 1,
        sourceTransactionId: id(80),
      }),
    ).toBe(false);
    expect(
      (
        await c.query(
          'SELECT source_revision FROM library.builtin_state_reference_source WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, id(1), id(2)],
        )
      ).rows[0]!.source_revision,
    ).toBe(2);
    expect(
      await s.unbindBuiltinStateReference(c, {
        route,
        accountId: id(1),
        subjectId: id(2),
        sourceRevision: 2,
        sourceTransactionId: id(81),
      }),
    ).toBe(true);
    expect(
      (
        await c.query(
          'SELECT subject_id FROM library.builtin_state_reference_source WHERE route=$1 AND collection_id=$2',
          [route, collectionId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await c.query(
          'SELECT state,revision,transaction_id FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, id(1), id(2)],
        )
      ).rows[0],
    ).toEqual({ state: 'planned', revision: 2, transaction_id: id(81) });
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
