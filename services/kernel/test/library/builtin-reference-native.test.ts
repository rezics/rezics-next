import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import {
  bindBuiltinStateReference as bind,
  readBuiltinStateReference as read,
  unbindBuiltinStateReference as unbind,
} from '../../src/library/builtin-reference-store.ts';
import { capture, openGrowthDatabase } from '../support/growth.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c72;
const id = (n: number) => `00000000-0000-7000-8000-6c72${n.toString(16).padStart(8, '0')}`;
const digest = 'sha256:' + 'a'.repeat(64);
const input = {
  accountId: id(1),
  subjectId: id(2),
  sourceRevision: 1,
  sourceTransactionId: id(80),
  releaseDigest: digest,
  profileId: 'fixture.game',
  stateSetId: 'game.states',
  stateId: 'planned',
};
const key = {
  kind: 'state',
  profileId: input.profileId,
  stateSetId: input.stateSetId,
  stateId: input.stateId,
} as const;
const collectionId = builtinCollectionId(input.accountId, key);
const pin = { provenance: 'profile', releaseDigest: digest, acceptingType: 'ex:Game', profileId: input.profileId };

async function entry(c: PoolClient, subject = id(2)) {
  await c.query(
    `INSERT INTO library.entry
    (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,library_profile_pin)
    VALUES($1,$2,$3,'planned',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z',$4,$5)`,
    [route, input.accountId, subject, input.sourceTransactionId, pin],
  );
}

async function sqlstate(c: PoolClient, code: string, operation: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_reference');
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_reference');
  expect(caught).toMatchObject({ code });
}

test('native reference constraints and exact entry fences keep tuple history private and replacement witnesses safe', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await entry(c);
    for (const wrong of [
      { sourceRevision: 2 },
      { sourceTransactionId: id(81) },
      { releaseDigest: 'sha256:' + 'b'.repeat(64) },
      { profileId: 'other.profile' },
      { stateId: 'completed' },
      { subjectId: id(3) },
      { accountId: id(4) },
    ])
      expect(await bind(c, { ...input, ...wrong })).toBeNull();
    expect((await c.query('SELECT * FROM library.builtin_collection_reference WHERE route=$1', [route])).rows).toEqual(
      [],
    );
    expect(
      (await c.query('SELECT * FROM library.builtin_state_reference_source WHERE route=$1', [route])).rows,
    ).toEqual([]);
    const bound = await bind(c, input);
    await entry(c, id(3));
    expect(await bind(c, { ...input, subjectId: id(3) })).toEqual(bound);
    const nextDigest = 'sha256:' + 'b'.repeat(64);
    await c.query(
      `UPDATE library.entry SET library_profile_pin=jsonb_set(library_profile_pin,'{releaseDigest}',to_jsonb($1::text)),
      revision=2,transaction_id=$2 WHERE route=$3 AND account_id=$4 AND subject_id=$5`,
      [nextDigest, id(81), route, input.accountId, input.subjectId],
    );
    const updated = { ...input, releaseDigest: nextDigest, sourceRevision: 2, sourceTransactionId: id(81) };
    expect(await bind(c, updated)).toEqual(bound);
    await c.query(
      `UPDATE library.entry SET state='completed',revision=1,transaction_id=$1,
      library_profile_pin=jsonb_set(library_profile_pin,'{profileId}','"fixture.other"')
      WHERE route=$2 AND account_id=$3 AND subject_id=$4`,
      [id(82), route, input.accountId, input.subjectId],
    );
    const replacement = {
      ...updated,
      profileId: 'fixture.other',
      stateId: 'completed',
      sourceRevision: 1,
      sourceTransactionId: id(82),
    };
    const rebound = await bind(c, replacement);
    expect(rebound?.collectionId).not.toBe(collectionId);
    expect(await unbind(c, { ...input, route })).toBe(false);
    expect(await unbind(c, { ...updated, route })).toBe(false);
    expect(await unbind(c, { ...replacement, route })).toBe(true);
    expect(await unbind(c, { ...replacement, route })).toBe(false);
    expect(await read(c, { route, collectionId })).toEqual(bound);
    expect(await read(c, { route, collectionId: rebound!.collectionId })).toEqual(rebound);
    expect(
      (await c.query('SELECT subject_id FROM library.builtin_state_reference_source WHERE route=$1', [route])).rows,
    ).toEqual([{ subject_id: id(3) }]);
    expect(
      (
        await c.query(
          'SELECT state,revision,transaction_id FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, input.accountId, input.subjectId],
        )
      ).rows,
    ).toEqual([{ state: 'completed', revision: 1, transaction_id: id(82) }]);
    await sqlstate(c, '23503', () =>
      c.query('DELETE FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2', [
        route,
        collectionId,
      ]),
    );
    for (const value of ['', 'Bad', 'bad\n', 'x'.repeat(65), 'é']) {
      for (const column of ['profile_id', 'state_set_id', 'state_id'])
        await sqlstate(c, '23514', () =>
          c.query(`UPDATE library.builtin_collection_reference SET ${column}=$1 WHERE route=$2 AND collection_id=$3`, [
            value,
            route,
            collectionId,
          ]),
        );
    }
    for (const [column, value] of [
      ['account_id', '00000000-0000-7000-8000-6c7300000001'],
      ['collection_id', '00000000-0000-8000-8000-6c7300000001'],
    ] as const)
      await sqlstate(c, '23514', () =>
        c.query(`UPDATE library.builtin_collection_reference SET ${column}=$1 WHERE route=$2 AND collection_id=$3`, [
          value,
          route,
          collectionId,
        ]),
      );
    for (const value of [0, -1])
      await sqlstate(c, '23514', () =>
        c.query('UPDATE library.builtin_state_reference_source SET source_revision=$1 WHERE route=$2', [value, route]),
      );
    for (const value of ['', digest + '\n', 'sha256:' + 'A'.repeat(64)])
      await sqlstate(c, '23514', () =>
        c.query('UPDATE library.builtin_state_reference_source SET release_digest=$1 WHERE route=$2', [value, route]),
      );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

type Plan = {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
};
function nodes(document: unknown): Plan[] {
  const result: Plan[] = [];
  const walk = (plan: Plan) => {
    result.push(plan);
    for (const child of plan.Plans ?? []) walk(child);
  };
  const roots = (Array.isArray(document) ? document : [document]) as { Plan: Plan }[];
  for (const root of roots) walk(root.Plan);
  return result;
}
function bounded(plans: readonly unknown[], index: string) {
  const all = plans.flatMap(nodes);
  expect(all.some((node) => node['Index Name'] === index)).toBe(true);
  for (const node of all) {
    expect(node['Actual Rows']).toBeLessThanOrEqual(2);
    expect(node['Actual Loops']).toBeLessThanOrEqual(2);
    expect(node['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(1);
    expect(node['Rows Removed by Index Recheck'] ?? 0).toBe(0);
    expect(node['Node Type']).not.toBe('Seq Scan');
  }
}

test('native directory, entry CAS, support seek and exact removal plans keep fixed rows and loops as history grows', async () => {
  const db = await openGrowthDatabase();
  const c = await db.pool.connect();
  try {
    await entry(c);
    await bind(c, input); // Warm typed SQL catalogue validation outside the measured calls.
    await read(c, { route, collectionId });
    await unbind(c, { ...input, route });
    let previous = 0;
    for (const scale of [1024, 8192, 65536]) {
      await db.admin.query(
        `INSERT INTO library.entry
        (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id)
        SELECT $1,$2,('10000000-0000-7000-8000-6c72'||lpad(to_hex(n),8,'0'))::uuid,
          'planned',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z',$2
        FROM generate_series($3::int+1,$4::int) n`,
        [route, id(1), previous, scale],
      );
      await db.admin.query(
        `INSERT INTO library.builtin_collection_reference
        SELECT $1, ('10000000-0000-8000-8000-6c72'||lpad(to_hex(n),8,'0'))::uuid, $2,
          'fixture.game','game.states','state.'||n FROM generate_series($3::int+1,$4::int) n`,
        [route, id(1), previous, scale],
      );
      await db.admin.query(
        `INSERT INTO library.builtin_state_reference_source
        SELECT $1,$2,('10000000-0000-7000-8000-6c72'||lpad(to_hex(n),8,'0'))::uuid,
          ('10000000-0000-8000-8000-6c72'||lpad(to_hex(n),8,'0'))::uuid,1,$2,$3
        FROM generate_series($4::int+1,$5::int) n`,
        [route, id(1), digest, previous, scale],
      );
      await db.admin.query('ANALYZE library.builtin_collection_reference');
      await db.admin.query('ANALYZE library.builtin_state_reference_source');
      await db.admin.query('ANALYZE library.entry');
      const binding = await capture(db, () => bind(c, input));
      bounded(binding.capture.plans, 'entry_pkey');
      const lookup = await capture(db, () => read(c, { route, collectionId }));
      expect(lookup.capture.statements).toHaveLength(1);
      bounded(lookup.capture.plans, 'builtin_collection_reference_pkey');
      const missing = await capture(db, () => read(c, { route, collectionId: id(99) }));
      expect(missing.value).toBeNull();
      expect(missing.capture.statements).toHaveLength(1);
      bounded(missing.capture.plans, 'builtin_collection_reference_pkey');
      const support = await capture(db, () =>
        c.query(
          `SELECT subject_id FROM library.builtin_state_reference_source
        WHERE route=$1 AND collection_id=$2 AND subject_id>$3 ORDER BY subject_id LIMIT 2`,
          [route, collectionId, id(0)],
        ),
      );
      bounded(support.capture.plans, 'builtin_state_reference_source_support');
      const removal = await capture(db, () => unbind(c, { ...input, route }));
      expect(removal.value).toBe(true);
      bounded(removal.capture.plans, 'builtin_state_reference_source_pkey');
      previous = scale;
    }
  } finally {
    c.release();
    await db.admin.query('DELETE FROM library.builtin_state_reference_source WHERE route=$1', [route]);
    await db.admin.query('DELETE FROM library.builtin_collection_reference WHERE route=$1', [route]);
    await db.admin.query('DELETE FROM library.entry WHERE route=$1', [route]);
    await db.close();
  }
});
