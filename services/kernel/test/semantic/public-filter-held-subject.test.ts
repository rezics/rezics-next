import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { publicFilterCreationConsumer } from '../../src/semantic/public-filter-creation-consumer.ts';
import {
  openHeldSubjectPreparation,
  advanceHeldSubjectPage,
  reconcileHeldSubjectPage,
} from '../../src/semantic/public-filter-held-subject.ts';
import {
  readHeldRepairHomes,
  readHeldSubjectOriginals,
} from '../../src/semantic/public-filter-held-subject-originals.ts';
import {
  readHeldQuietCommands,
  readPublicFilterCreationWindow,
} from '../../src/semantic/public-filter-creation-window.ts';
import { identityEpochDatabase } from './support/identity-epoch.ts';
import { retentionFixture } from '../history/subject-retention-fixture.ts';

const context = () => ({ deadline: Date.now() + 5000 });

test('Source resumes the original Access page and replays both command groups after the inventory worker is lost', async () => {
  const db = await identityEpochDatabase();
  try {
    db.pool.options.max = 1;
    const { f, resident, book, bootstrap, job, keys } = await retentionFixture(db);
    const account = newId(16);
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id)
       VALUES(16,$1,'actor','active','Held Account',$1)`,
      [account],
    );
    await db.admin.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,state,account_id,transaction_id)
       VALUES(24,'cut-claim-14959','active',$1,$1)`,
      [account],
    );
    const access = async () =>
      (
        await db.admin.query(
          `SELECT a.partition_no AS home,a.revision::text AS account,a.claim_revision::text AS claim,
         coalesce(p.enqueue_revision,0)::text AS enqueue
       FROM access.account_discovery_population a LEFT JOIN semantic.public_filter_privacy_pending p
         ON (p.partition_no,p.input_key)=(a.partition_no,'["domain","accounts"]')
       WHERE a.partition_no IN (0,1) ORDER BY a.partition_no`,
        )
      ).rows;
    const before = await access();
    expect(BigInt(before[1]!.enqueue)).toBeGreaterThan(0n);
    // Flush each worker's accumulated counters before reading the isolated database's statistics.
    const statistics = async () => {
      await db.pool.query('SELECT pg_stat_force_next_flush()');
      await db.admin.query('SELECT pg_stat_force_next_flush()');
      return (
        await db.admin.query<{ visits: number; writes: number }>(
          `SELECT sum(seq_tup_read+coalesce(idx_tup_fetch,0))::int AS visits,
           sum(n_tup_ins+n_tup_upd+n_tup_del)::int AS writes FROM pg_stat_user_tables`,
        )
      ).rows[0]!;
    };
    const phases: { phase: string; statements: number; visits: number; writes: number }[] = [];
    async function measure<T>(phase: string, run: () => Promise<T>) {
      const old = await statistics();
      let statements = 0;
      const result = await withQueryAccounting(
        {
          query(_sql, _args, dispatch) {
            statements++;
            return dispatch();
          },
          connection(dispatch) {
            return dispatch();
          },
        },
        run,
      );
      const current = await statistics();
      const counts = { phase, statements, visits: current.visits - old.visits, writes: current.writes - old.writes };
      phases.push(counts);
      expect(statements).toBeGreaterThan(0);
      expect(statements).toBeLessThanOrEqual(16);
      expect(counts.visits).toBeLessThan(192);
      const expectedWrites =
        phase === 'open' ? keys.length + 4 : phase === 'capture' ? 2 : phase.startsWith('recover-') ? 0 : 1;
      expect(counts.writes).toBe(expectedWrites);
      return result;
    }
    const binding = { job, bootstrap };
    const open = () => openHeldSubjectPreparation(db.pool, binding, context());
    const birth = await measure('open', open);
    const page = { ...binding, birth, firstHome: 0, endHome: 2 };
    const capture = () =>
      db.pool
        .query('SELECT semantic.capture_subject_access_page_v1($1,0,2) AS cuts', [birth])
        .then((result) => result.rows[0]!.cuts);
    const readCut = (partition: number) =>
      db.pool.query('SELECT * FROM semantic.subject_access_cut_v1($1,$2)', [bootstrap, partition]);
    expect((await readCut(0)).rows).toEqual([]);
    // The cut cannot get ahead of a pending native Account mutation.
    const writer = await db.admin.connect();
    const reader = await db.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE access.account SET display_name=$2 WHERE (route,account_id)=(16,$1)', [
        account,
        'Uncommitted',
      ]);
      await reader.query('BEGIN');
      await reader.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        reader.query('SELECT semantic.capture_subject_access_page_v1($1,0,2)', [birth]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await reader.query('ROLLBACK');
      await writer.query('ROLLBACK');
      reader.release();
      writer.release();
    }
    expect((await readCut(0)).rows).toEqual([]);
    const cut = await measure('capture', capture);
    expect(cut).toHaveLength(2);
    for (const [i, row] of before.entries()) expect(cut[i]).toMatchObject(row);
    expect(cut[0].command).toBe(String(resident.component.position));
    expect(cut[1].command).toBe('0');
    const step = (ordinal: number) => advanceHeldSubjectPage(db.pool, { ...page, ordinal }, context());
    const scanner = (await db.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await expect(
      db.admin.query('UPDATE semantic.subject_source_preparation_v1 SET next_home=2 WHERE birth=$1', [birth]),
    ).rejects.toMatchObject({ code: '23514' });
    const inventory = await measure('inventory', () => step(0));
    expect(inventory.obligations.flatMap((row) => row.ids)).toEqual([resident.subject.id]);
    expect(
      inventory.evidence.inventory?.map((row) => [row.partition, row.receipt, row.complete, row.originals]),
    ).toEqual([
      [0, cut[0].receipt, true, [{ route: 0, id: resident.subject.id }]],
      [1, cut[1].receipt, true, []],
    ]);
    expect(inventory.next).toEqual({ phase: 'window' });

    const cursor = async () =>
      (
        await db.admin.query(
          'SELECT next_home,next_ordinal FROM semantic.subject_source_preparation_v1 WHERE birth=$1',
          [birth],
        )
      ).rows[0];
    await expect(
      reconcileHeldSubjectPage(db.pool, { ...page, ordinal: 0 }, context(), async () => {
        throw new Error('Writer interrupted');
      }),
    ).rejects.toThrow('Writer interrupted');
    expect(await cursor()).toEqual({ next_home: 0, next_ordinal: 0 });

    // A second connection terminates the scanner after it committed the empty home's scan.
    const worker = await db.pool.connect();
    const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    expect(pid).toBe(scanner);
    const stopped = await db.admin.query('SELECT pg_terminate_backend($1,5000) AS stopped', [pid]);
    expect(stopped.rows[0]!.stopped).toBe(true);
    worker.release(true);
    const created = await book(1);
    await f.hide(created.subject.id);
    await db.admin.query('UPDATE access.account SET display_name=$2 WHERE (route,account_id)=(16,$1)', [
      account,
      'Changed',
    ]);
    await db.admin.query("DELETE FROM access.handle_claim WHERE (route,normalized_handle)=(24,'cut-claim-14959')");
    const after = await access();
    for (const key of ['account', 'claim', 'enqueue'])
      expect(BigInt(after[1]![key])).toBeGreaterThan(BigInt(before[1]![key]));

    expect((await db.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid).not.toBe(scanner);
    expect(await measure('recover-open', open)).toBe(birth);
    expect(await measure('recover-page', capture)).toEqual(cut);
    expect(await measure('recover-inventory', () => step(0))).toEqual(inventory);
    const groups = (
      await db.admin.query(
        `SELECT o.position::text,o.event_seq,o.event_count,o.epoch,o.id,o.type,o.subject,
         encode(sha256(convert_to(o.data::text,'UTF8')),'hex') AS data_digest,b.transaction_id
       FROM core.outbox o JOIN editorial.write_basis b USING(partition_no,epoch,position)
       WHERE o.partition_no=1 ORDER BY o.position,o.event_seq`,
      )
    ).rows;
    expect(groups.map((row) => [row.event_seq, row.event_count])).toEqual([
      [0, 2],
      [1, 2],
      [0, 2],
      [1, 2],
    ]);
    expect(groups[0]).toMatchObject({ subject: created.subject.id, type: 'com.rezics.subject.created.v1' });
    expect(groups[2]).toMatchObject({ subject: created.subject.id, type: 'com.rezics.subject.visibility_changed.v1' });
    const rawWindow = () =>
      readPublicFilterCreationWindow(db.pool, { bootstrap, partition: 1, heldBirth: birth }, context());
    // This fixture verifies the Source-to-writer obligations against native originals.
    // Generation publication owns the physical comparison and its independent test.
    const settle = async (ordinal: number, expected: typeof inventory) => {
      const seen: typeof expected.obligations = [];
      const result = await measure('settle-' + expected.phase, () =>
        reconcileHeldSubjectPage(db.pool, { ...page, ordinal }, context(), async (obligation) => {
          const verified = await db.admin.query(
            `SELECT p.epoch,s.subject_id FROM core.partition p JOIN semantic.subject s
             ON s.route>=p.partition_no*16 AND s.route<(p.partition_no+1)*16
           WHERE p.partition_no=$1 AND p.epoch=$2 AND p.position>=$3 AND p.write_state='active'
             AND s.subject_id=ANY($4::uuid[]) ORDER BY s.subject_id`,
            [obligation.partition, obligation.epoch, obligation.position, obligation.ids],
          );
          expect(verified.rows.map((row) => row.subject_id)).toEqual([...obligation.ids].sort());
          seen.push(obligation);
        }),
      );
      expect(result).toEqual(expected);
      expect(seen).toEqual(expected.obligations);
      expect(await cursor()).toEqual({
        next_home: expected.complete ? 2 : 0,
        next_ordinal: expected.complete ? 0 : ordinal + 1,
      });
    };
    await settle(0, inventory);
    const bridge = [];
    for (let ordinal = 1; ordinal < 12; ordinal++) {
      const saved = await measure(ordinal === 1 ? 'window' : 'events', () => step(ordinal));
      bridge.push(saved);
      if (saved.phase === 'window') {
        await runCommand(db.pool, { partition: 1 }, async () => ({
          value: null,
          events: [{ type: 'com.rezics.fixture.created.v1', data: null }],
        }));
        expect(await measure('recover-window', () => step(ordinal))).toEqual(saved);
      }
      await settle(ordinal, saved);
      if (saved.complete) break;
    }
    expect(bridge.at(-1)?.complete).toBe(true);
    expect(bridge.flatMap((saved) => saved.evidence.envelopes ?? [])).toEqual(groups);
    expect(bridge[0]?.evidence.windows?.map((w) => [w.partition, w.receipt, w.base, w.through])).toEqual([
      [0, cut[0].receipt, cut[0].command, cut[0].command],
      [1, cut[1].receipt, cut[1].command, groups.at(-1)!.position],
    ]);
    expect(bridge.at(-1)?.obligations).toEqual([
      { partition: 1, epoch: cut[1].epoch, position: groups.at(-1)!.position, ids: [created.subject.id] },
    ]);
    const originals = await readHeldSubjectOriginals(
      db.pool,
      { bootstrap, birth, partition: 1, after: null, inputLimit: 8 },
      context(),
    );
    expect(originals.originals).toEqual([{ route: 16, id: created.subject.id }]);
    const footprint = (
      await db.admin.query(
        `SELECT (SELECT count(*) FROM core.subject_subscription_key_v1 WHERE birth=$1)::int AS keys,
       (SELECT count(*) FROM semantic.public_filter_key_enrollment WHERE bootstrap=$2)::int AS edges,
       (SELECT count(*) FROM semantic.public_filter_home_enrollment WHERE bootstrap=$2)::int AS homes,
       (SELECT count(*) FROM search.public_filter_coverage_preparation WHERE bootstrap=$2)::int AS receiver,
       (SELECT count(*) FROM core.consumer_checkpoint WHERE consumer=$3)::int AS pins`,
        [birth, bootstrap, publicFilterCreationConsumer(bootstrap)],
      )
    ).rows[0];
    expect(footprint).toEqual({ keys: keys.length, edges: 0, homes: 0, receiver: 0, pins: 0 });
    await expect(
      readPublicFilterCreationWindow(db.pool, { bootstrap, partition: 2, heldBirth: birth }, context()),
    ).rejects.toThrow();
    await expect(openHeldSubjectPreparation(db.pool, { job, bootstrap: randomUUID() }, context())).rejects.toThrow();
    await db.pool.query('SELECT core.capture_subject_retention_page_v1($1,2,3)', [birth]);
    await expect(db.pool.query('SELECT semantic.capture_subject_access_page_v1($1,2,3)', [birth])).rejects.toThrow(
      'Core cut predates',
    );
    expect((await readCut(2)).rows).toEqual([]);
    const stale = await db.admin.connect();
    try {
      await stale.query('BEGIN');
      await stale.query('DELETE FROM access.account_discovery_population WHERE partition_no=1');
      expect((await stale.query('SELECT * FROM semantic.subject_access_cut_v1($1,1)', [bootstrap])).rows).toEqual([]);
      await stale.query('ROLLBACK');
      await stale.query('BEGIN');
      await stale.query(
        `INSERT INTO core.subject_subscription_key_v1(input_key,birth) VALUES('["field","extra"]',$1)`,
        [birth],
      );
      expect((await stale.query('SELECT * FROM semantic.subject_access_cut_v1($1,1)', [bootstrap])).rows).toEqual([]);
      await expect(stale.query('SELECT semantic.capture_subject_access_page_v1($1,0,2)', [birth])).rejects.toThrow(
        'Original Subject definition or membership keys changed',
      );
    } finally {
      await stale.query('ROLLBACK');
      stale.release();
    }
    // Simulate a torn restored stream in the disposable database. Even a previously
    // accepted step must reopen the original visibility group before returning it.
    const broken = await db.admin.connect();
    try {
      await broken.query('BEGIN');
      await broken.query('ALTER TABLE core.outbox DISABLE TRIGGER subject_retention_outbox');
      expect(
        (
          await broken.query('DELETE FROM core.outbox WHERE (partition_no,position,event_seq)=(1,$1,1)', [
            groups.at(-1)!.position,
          ])
        ).rowCount,
      ).toBe(1);
      await broken.query('ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER subject_retention_outbox');
      await broken.query('COMMIT');
    } finally {
      broken.release(true);
    }
    await expect(step(bridge.at(-1)!.ordinal)).rejects.toThrow();
    await db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=1");
    await expect(rawWindow()).rejects.toThrow();
    await expect(step(0)).rejects.toThrow();
    console.info('Source held Subject PostgreSQL phases', JSON.stringify(phases));
  } finally {
    await db.close();
  }
}, 60_000);

test('held repair reopens the exact ordered prefix through a real original and rejects a moved interior home', async () => {
  const db = await identityEpochDatabase();
  try {
    const { resident, book, bootstrap, job } = await retentionFixture(db);
    const last = await book(6);
    const birth = await openHeldSubjectPreparation(db.pool, { bootstrap, job }, context());
    await db.pool.query('SELECT semantic.capture_subject_access_page_v1($1,0,8)', [birth]);
    const input = {
      bootstrap,
      birth,
      partition: 0,
      limit: 8,
      after: { route: 0, id: resident.subject.id },
      inventory: true,
    };
    const original = await readHeldRepairHomes(db.pool, input, context());
    expect(original.map((row) => row.partition)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(original.at(-1)?.id).toBe(last.subject.id);
    const retained = { heads: original.map((row) => row.head), key: { route: 96, id: last.subject.id } };
    const later = await book(3);
    expect((await readHeldRepairHomes(db.pool, input, context())).at(-1)?.id).toBe(later.subject.id);
    expect(await readHeldRepairHomes(db.pool, input, context(), retained)).toEqual(original);
    const successor = { ...input, partition: 6, after: retained.key };
    const empty = await readHeldRepairHomes(db.pool, successor, context());
    expect(empty.map((row) => row.id)).toEqual([null, null]);
    await book(7);
    expect(
      await readHeldRepairHomes(db.pool, successor, context(), { heads: empty.map((row) => row.head), key: null }),
    ).toEqual(empty);
    const command = (partition: number, count: number) =>
      runCommand(db.pool, { partition }, async () => ({
        value: null,
        events: Array.from({ length: count }, () => ({ type: 'com.rezics.fixture.created.v1', data: null })),
      }));
    await command(1, 1);
    await command(2, 2);
    const windowInput = { ...input, after: null, inventory: false };
    const windows = await readHeldRepairHomes(db.pool, windowInput, context());
    const commands = await readHeldQuietCommands(db.pool, windows, 32);
    expect(commands.get(1)).toHaveLength(1);
    expect(commands.has(2)).toBe(false); // The complete multi-slot envelope belongs to the ordinary bridge.
    expect(commands.has(3)).toBe(false); // A Book creation still requires Subject repair.
    await command(1, 1);
    const reopened = await readHeldRepairHomes(db.pool, windowInput, context(), {
      heads: windows.map((row) => row.head),
      key: null,
    });
    expect(await readHeldQuietCommands(db.pool, reopened, 32)).toEqual(commands);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      // An interior carry changes after the page is committed. The unchanged
      // range shortcut must give way to the original per-home comparison.
      await client.query('SAVEPOINT before_change');
      await client.query(
        'UPDATE access.account_discovery_population SET claim_revision=claim_revision+1 WHERE partition_no=4',
      );
      const stamp = await client.query(
        `SELECT access_revisions=semantic.subject_access_range_revisions_v1(first_home,end_home) AS current
         FROM semantic.subject_access_page_v1 WHERE birth=$1 AND first_home=0`,
        [birth],
      );
      expect(stamp.rows[0]?.current).toBe(false);
      await expect(readHeldRepairHomes(client, input, context(), retained)).rejects.toThrow();
      await client.query('ROLLBACK TO before_change');
      expect(await readHeldRepairHomes(client, input, context(), retained)).toEqual(original);
      await client.query('UPDATE core.publication_authority_epoch SET generation=gen_random_uuid() WHERE home_no=4');
      await expect(readHeldRepairHomes(client, input, context(), retained)).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await readHeldRepairHomes(db.pool, input, context(), retained)).toEqual(original);
  } finally {
    await db.close();
  }
}, 60000);
