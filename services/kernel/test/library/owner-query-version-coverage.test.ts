import { afterAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readOwnerFactVersion } from '../../src/library/owner-fact-version.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
type Client = Pick<PoolClient, 'query'>;
const route = 0x6c70;
const at = '2026-10-28T00:00:00Z';
const later = '2026-10-28T01:00:00Z';
const due = '2026-11-27T00:00:00Z';
const large = 9007199254740993n;

// Keyed raw storage probes ONLY: these are not authenticated business/API fixtures,
// accepting-profile evidence, a source backend or a production sequence allocator.
async function fixture(c: Client) {
  const owner = newId(route),
    subject = newId(route),
    copy = newId(route),
    session = newId(route),
    label = newId(route);
  const tx = newId(route);
  await c.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,owner_write_seq)
     VALUES($1,$2,$3,'planned',1,$4,$4,$5,$6)`,
    [route, owner, subject, at, tx, large.toString()],
  );
  await c.query(
    `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,kind,revision,created_at,updated_at,transaction_id)
     VALUES($1,$2,$3,$4,'owned','physical',1,$5,$5,$6)`,
    [route, copy, owner, subject, at, tx],
  );
  await c.query(
    `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
     VALUES($1,$2,$3,$4,'scalar_amount','minute',0,'active',1,$5,$6)`,
    [route, session, owner, subject, at, tx],
  );
  await c.query(
    `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id)
     VALUES($1,$2,$3,'Label',1,$4,$4,$5)`,
    [route, owner, label, at, tx],
  );
  await c.query(
    `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id,slot_no)
     VALUES($1,$2,$3,$4,1,$5,$5,$6,0)`,
    [route, owner, subject, label, at, tx],
  );
  await c.query('INSERT INTO library.owner_write_counter(route,account_id,seq) VALUES($1,$2,$3)', [
    route,
    owner,
    large.toString(),
  ]);
  return { owner, subject, copy, session, label };
}

test('native owner fact version covers session lifecycle activity holding kind status and same-value state winner sequence changes without copying facts or granting query readiness', async () => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const f = await fixture(c),
      unrelated = await fixture(c);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(4n);
    const unrelatedVersion = await readOwnerFactVersion(c, unrelated.owner);
    let expected = 4n;
    async function changed(sql: string, params: unknown[]) {
      const result = await c.query(sql, params);
      expect(result.rowCount).toBe(1);
      expect(await readOwnerFactVersion(c, f.owner)).toBe(++expected);
      expect(await readOwnerFactVersion(c, unrelated.owner)).toBe(unrelatedVersion);
    }
    const sessionKey = [route, f.session];
    // Each lifecycle change is isolated from activity/revision/pin changes.
    await changed("UPDATE library.progress_session SET state='abandoned' WHERE route=$1 AND session_id=$2", sessionKey);
    await changed("UPDATE library.progress_session SET state='active' WHERE route=$1 AND session_id=$2", sessionKey);
    await changed(
      "UPDATE library.progress_session SET state='completed',completed_at=$3 WHERE route=$1 AND session_id=$2",
      [...sessionKey, later],
    );
    await changed('UPDATE library.progress_session SET last_changed_at=$3 WHERE route=$1 AND session_id=$2', [
      ...sessionKey,
      later,
    ]);
    await changed('UPDATE library.progress_session SET amount=3 WHERE route=$1 AND session_id=$2', sessionKey);
    await changed("UPDATE library.copy SET kind='digital' WHERE route=$1 AND copy_id=$2", [route, f.copy]);
    await changed("UPDATE library.copy SET status='lent' WHERE route=$1 AND copy_id=$2", [route, f.copy]);
    const entryKey = [route, f.owner, f.subject];
    const statePin = async () =>
      (
        await c.query(
          'SELECT state,library_profile_pin,owner_write_seq FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          entryKey,
        )
      ).rows[0];
    const before = await statePin();
    await changed('UPDATE library.entry SET owner_write_seq=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      ...entryKey,
      (large + 1n).toString(),
    ]);
    expect(await statePin()).toEqual({ ...before, owner_write_seq: (large + 1n).toString() });
    await changed('UPDATE library.entry SET activity_at=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      ...entryKey,
      later,
    ]);
    await changed('UPDATE library.entry SET updated_at=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      ...entryKey,
      later,
    ]);
    await changed("UPDATE library.copy SET note='private note' WHERE route=$1 AND copy_id=$2", [route, f.copy]);
    const labelKey = [route, f.owner, f.label];
    await changed(
      "UPDATE library.personal_label SET normalized_name='Renamed' WHERE route=$1 AND account_id=$2 AND label_id=$3",
      labelKey,
    );
    await changed(
      'UPDATE library.personal_label SET deleted_at=$4,purge_after=$5 WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [...labelKey, at, due],
    );
    // Parent liveness alone invalidates even while the assignment/reservation stays untouched.
    expect(
      (
        await c.query(
          'SELECT slot_no FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
          [...entryKey, f.label],
        )
      ).rows,
    ).toEqual([{ slot_no: 0 }]);
    await changed(
      'UPDATE library.personal_label SET deleted_at=NULL,purge_after=NULL WHERE route=$1 AND account_id=$2 AND label_id=$3',
      labelKey,
    );
    await changed(
      'UPDATE library.label_assignment SET slot_no=NULL WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [...entryKey, f.label],
    );
    await changed(
      'UPDATE library.label_assignment SET assignment_id=$5 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [...entryKey, f.label, newId(route)],
    );
    await changed(
      'UPDATE library.label_assignment SET deleted_at=$5,purge_after=$6 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [...entryKey, f.label, at, due],
    );
    await changed(
      'UPDATE library.label_assignment SET deleted_at=NULL,purge_after=NULL,slot_no=1 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [...entryKey, f.label],
    );
    expect(
      (await c.query('SELECT seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2', [route, f.owner]))
        .rows,
    ).toEqual([{ seq: large.toString() }]);
    // All five genuine SQL no-change rows leave the head unchanged.
    for (const [sql, params] of [
      ['UPDATE library.entry SET state=state WHERE route=$1 AND account_id=$2 AND subject_id=$3', entryKey],
      ['UPDATE library.copy SET kind=kind WHERE route=$1 AND copy_id=$2', [route, f.copy]],
      ['UPDATE library.progress_session SET state=state WHERE route=$1 AND session_id=$2', sessionKey],
      [
        'UPDATE library.personal_label SET revision=revision WHERE route=$1 AND account_id=$2 AND label_id=$3',
        labelKey,
      ],
      [
        'UPDATE library.label_assignment SET slot_no=slot_no WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
        [...entryKey, f.label],
      ],
    ] as const)
      await c.query(sql, [...params]);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(expected);
    // Existing fact insert/delete and parent-delete hooks remain in force. No manual head increment.
    await c.query(
      'DELETE FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [...entryKey, f.label],
    );
    await c.query('DELETE FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3', labelKey);
    await c.query('DELETE FROM library.copy WHERE route=$1 AND copy_id=$2', [route, f.copy]);
    await c.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', sessionKey);
    await c.query('DELETE FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', entryKey);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(expected + 5n);
    expect(
      (await c.query('SELECT count(*)::int AS n FROM library.collection WHERE curator_account_id=$1', [f.owner])).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('metadata read is one exact private PK SELECT in the caller read-only snapshot; missing never becomes zero', async () => {
  const f = await fixture(db.admin),
    missing = newId(route);
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(await readOwnerFactVersion(c, f.owner)).toBe(4n);
    const measured = await capture(db, () => readOwnerFactVersion(c, f.owner));
    expect(measured.value).toBe(4n);
    expect(measured.capture.statements).toHaveLength(1);
    expect(measured.capture.statements[0]).toMatch(
      /SELECT generation\s+FROM library.fact_source_head\s+WHERE route = \$1 AND account_id = \$2/i,
    );
    expect(await readOwnerFactVersion(c, missing)).toBeNull();
    await db.admin.query('UPDATE library.entry SET activity_at=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      f.owner,
      f.subject,
      later,
    ]);
    // A concurrent committed write cannot be mixed into the caller's earlier native snapshot.
    expect(await readOwnerFactVersion(c, f.owner)).toBe(4n);
    expect(
      (
        await c.query('SELECT activity_at FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
          route,
          f.owner,
          f.subject,
        ])
      ).rows,
    ).toEqual([{ activity_at: null }]);
    await c.query('COMMIT');
    expect(await readOwnerFactVersion(c, f.owner)).toBe(5n);
    for (const invalid of ['', 'not-an-account', '00000000-0000-4000-8000-6c7000000000', `${f.owner}\n`])
      await expect(readOwnerFactVersion(c, invalid)).rejects.toThrow('Invalid owner account route');
    expect(
      (
        await c.query('SELECT generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
          route,
          missing,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await c.query('SELECT seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2', [route, missing]))
        .rows,
    ).toEqual([]);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(5n);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('rollback no-change bigint overflow and actual same-home owner moves preserve native atomic metadata semantics', async () => {
  const f = await fixture(db.admin),
    next = newId(route),
    unrelated = await fixture(db.admin);
  // Only this raw boundary probe installs high metadata; real operations rely solely on triggers.
  await db.admin.query('UPDATE library.fact_source_head SET generation=$3 WHERE route=$1 AND account_id=$2', [
    route,
    f.owner,
    large.toString(),
  ]);
  const c = await db.pool.connect();
  try {
    expect(await readOwnerFactVersion(c, f.owner)).toBe(large);
    await c.query(
      'UPDATE library.entry SET owner_write_seq=owner_write_seq WHERE route=$1 AND account_id=$2 AND subject_id=$3',
      [route, f.owner, f.subject],
    );
    expect(await readOwnerFactVersion(c, f.owner)).toBe(large);
    await c.query('BEGIN');
    await c.query('UPDATE library.entry SET owner_write_seq=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      f.owner,
      f.subject,
      (large + 1n).toString(),
    ]);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(large + 1n);
    await c.query('ROLLBACK');
    expect(await readOwnerFactVersion(c, f.owner)).toBe(large);
    expect(
      (
        await c.query('SELECT owner_write_seq FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
          route,
          f.owner,
          f.subject,
        ])
      ).rows,
    ).toEqual([{ owner_write_seq: large.toString() }]);
    // Same route/home storage probe, not an implicit cross-home business transaction.
    await c.query('UPDATE library.entry SET account_id=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      f.owner,
      f.subject,
      next,
    ]);
    expect(await readOwnerFactVersion(c, f.owner)).toBe(large + 1n);
    expect(await readOwnerFactVersion(c, next)).toBe(1n);
    expect(await readOwnerFactVersion(c, unrelated.owner)).toBe(4n);
    await c.query('UPDATE library.fact_source_head SET generation=$3 WHERE route=$1 AND account_id=$2', [
      route,
      f.owner,
      '9223372036854775807',
    ]);
    await c.query('BEGIN');
    await expect(
      c.query("UPDATE library.copy SET kind='digital' WHERE route=$1 AND copy_id=$2", [route, f.copy]),
    ).rejects.toMatchObject({ code: '22003' });
    await c.query('ROLLBACK');
    expect(await readOwnerFactVersion(c, f.owner)).toBe(9223372036854775807n);
    expect(
      (await c.query('SELECT kind FROM library.copy WHERE route=$1 AND copy_id=$2', [route, f.copy])).rows,
    ).toEqual([{ kind: 'physical' }]);
    expect(
      (await c.query('SELECT seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2', [route, f.owner]))
        .rows,
    ).toEqual([{ seq: large.toString() }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

for (const axis of ['unrelated heads', 'native history'] as const) {
  test(`owner version read and triggered update stay bounded as ${axis} grow at 64/512/4096`, async () => {
    const f = await fixture(db.admin),
      history = await fixture(db.admin);
    const report = await checkGrowth(db, {
      name: `owner fact version ${axis}`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        if (axis === 'unrelated heads') {
          await db.admin.query(
            `INSERT INTO library.fact_source_head(route,account_id,generation)
            SELECT 27761,('10000000-0000-7000-8000-6c71'||lpad(to_hex(n),8,'0'))::uuid,1
            FROM generate_series($1::int,$2::int) n`,
            [previous + 1, scale],
          );
        } else {
          await db.admin.query(
            `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
            SELECT $1,('10000000-0000-7000-8000-6c70'||lpad(to_hex(n),8,'0'))::uuid,$2,$3,'scalar_amount','minute',0,'active',1,$4,$5
            FROM generate_series($6::int,$7::int) n`,
            [route, history.owner, history.subject, at, newId(route), previous + 1, scale],
          );
          await db.admin.query(
            `INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id)
            SELECT $1,$2,n,'{}'::jsonb,$3,$4 FROM generate_series($5::int,$6::int) n`,
            [route, history.session, at, newId(route), previous + 1, scale],
          );
        }
      },
      async operation() {
        const c = await db.pool.connect();
        try {
          const before = await readOwnerFactVersion(c, f.owner);
          expect(before).not.toBeNull();
          await c.query(
            'UPDATE library.entry SET revision=revision+1 WHERE route=$1 AND account_id=$2 AND subject_id=$3',
            [routeOf(f.owner), f.owner, f.subject],
          );
          expect(await readOwnerFactVersion(c, f.owner)).toBe(before! + 1n);
        } finally {
          c.release();
        }
      },
    });
    // checkGrowth enforces the shared configured rule. Its shadow model is diagnostic:
    // PostgreSQL may switch from a small-table scan to a PK probe as noise grows.
    expect(report.samples.every(({ cost }) => cost.statements === report.samples[0]!.cost.statements)).toBe(true);
    for (const sample of report.samples) {
      expect(sample.cost.relations['library.fact_source_head']).toBeDefined();
      expect(sample.cost.relations['library.entry']).toBeDefined();
      expect(sample.cost.relations['library.progress_change']).toBeUndefined();
      expect(sample.cost.relations['library.progress_session']).toBeUndefined();
      expect(sample.cost.catalogStatements).toBe(0);
    }
    console.log(
      JSON.stringify({
        name: report.name,
        shadow: report.shadow,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          statements: cost.statements,
          rows: cost.rows,
          blocks: cost.blocks,
        })),
      }),
    );
  });
}
