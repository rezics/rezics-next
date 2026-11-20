import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { fixture } from './support/public-filter-source.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createDefaultPublicFilterRuntime } from '../../src/search/public-runtime.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { maintainPublicFilterCoverageHome } from '../../src/semantic/public-filter-coverage-maintenance.ts';
import { PUBLIC_PREPARATION_BUDGET_MS } from '../../src/search/public-preparation-store.ts';

test('original Subject receiver manifest survives lost commits and leaves a later withdrawal pending', async () => {
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `receiver-manifest-${crypto.randomUUID().slice(0, 8)}-`;
  const target = subjectIndexName(prefix, 1);
  const runtime = createDefaultPublicFilterRuntime({ ...f.config, prefix, search });
  const context = () => ({ deadline: Date.now() + PUBLIC_PREPARATION_BUDGET_MS });
  const lost = () => Object.assign(new Error('Interrupted native ACK reply'), { code: '08006' });
  let rolledBack = false,
    receiverCommits = 0,
    blockRead = false,
    sourceCommits = 0,
    sameTransactionRefused = false;
  let nativeError: unknown;
  const poolQuery = f.db.pool.query.bind(f.db.pool);
  f.db.pool.query = ((sql: unknown, ...args: unknown[]) => {
    if (blockRead && typeof sql === 'string' && sql.includes('FROM manifest m LEFT JOIN proof'))
      return Promise.reject(lost());
    const result = Reflect.apply(poolQuery, undefined, [sql, ...args]);
    if (typeof sql !== 'string' || !sql.includes('SET ack_after=4096')) return result;
    return Promise.resolve(result).then((committed) => {
      if (committed.rows[0]?.advanced) {
        sourceCommits++;
        throw lost();
      }
      return committed;
    });
  }) as typeof f.db.pool.query;
  const watched = new WeakSet<PoolClient>();
  f.db.pool.on('acquire', (client: PoolClient) => {
    if (watched.has(client)) return;
    watched.add(client);
    const query = client.query.bind(client);
    let inserted = false;
    client.query = ((statement: string | { text?: string }, ...args: unknown[]) => {
      const sql = typeof statement === 'string' ? statement : statement.text;
      if (sql?.startsWith('BEGIN') || sql === 'ROLLBACK') inserted = false;
      if (inserted && sql === 'COMMIT') {
        inserted = false;
        const rollback = !rolledBack;
        return query(rollback ? 'ROLLBACK' : 'COMMIT').then(() => {
          if (rollback) rolledBack = true;
          else receiverCommits++;
          throw lost();
        });
      }
      const dispatched = Reflect.apply(query, client, [statement, ...args]);
      if (!sql?.includes('INSERT INTO search.public_filter_ack_manifest(job)')) return dispatched;
      return Promise.resolve(dispatched).then(
        async (result) => {
          inserted = true;
          if (!sameTransactionRefused) {
            await query('SAVEPOINT before_source');
            try {
              await query(`UPDATE semantic.public_filter_repair_step t SET ack_after=4096
                FROM search.public_filter_ack_manifest m
                WHERE m.committed_by=pg_current_xact_id() AND
                (t.partition_no,t.bootstrap,t.execution,t.step)=(m.partition_no,m.bootstrap,m.execution,m.terminal)`);
            } catch (error) {
              if ((error as { constraint?: string }).constraint !== 'public_filter_repair_ack_manifest') throw error;
              sameTransactionRefused = true;
            } finally {
              await query('ROLLBACK TO SAVEPOINT before_source');
              await query('RELEASE SAVEPOINT before_source');
            }
          }
          return result;
        },
        (error) => {
          nativeError = error;
          throw error;
        },
      );
    }) as typeof client.query;
  });
  try {
    // This database belongs to this one native check. Production creates v0 preparations.
    await f.db.admin.query(
      'ALTER TABLE search.public_filter_coverage_preparation ALTER COLUMN ack_protocol SET DEFAULT 1',
    );
    const books = [await f.create('schema:Book'), await f.create('schema:Book')];
    const book = books[0]!;
    const home = partitionOf(routeOf(book)!);
    await createSubjectIndex(search, prefix, 1);
    const writer = createSearchWriterGuard({
      pool: f.db.pool,
      search,
      index: target,
      consumer: subjectConsumer(prefix, 1),
      source: createRatedSubjectSource(f.db.pool, f.config.routeKey).source,
      listing: subjectListingSource(f.db.pool),
    });
    for (const id of books) {
      const partition = partitionOf(routeOf(id)!);
      const row = (await f.db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partition]))
        .rows[0];
      await writer.write(partition, [id], BigInt(row.position));
    }
    const opened = await runtime.preparePublication(1, context());
    if (opened.status !== 'preparing') throw new Error(opened.reason);
    const { job } = opened;
    const terminal = async () =>
      (
        await f.db.admin.query(
          `SELECT step,ack_after FROM semantic.public_filter_repair_step WHERE partition_no=0 AND execution=$1
        AND complete AND verified_root IS NOT NULL AND verified_next IS NULL`,
          [job.job],
        )
      ).rows[0];
    const manifests = async () =>
      (
        await f.db.admin.query('SELECT * FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,$1)', [
          job.job,
        ])
      ).rows;
    let reconciled = false;
    const deadline = Date.now() + 360_000;
    let idle = 0;
    let last;
    while (!receiverCommits && Date.now() < deadline) {
      if (reconciled) {
        last = await runtime.publication.activate(job, context());
        if (last.status === 'preparing' && last.next === 'step') reconciled = false;
        if (last.status === 'preparing' && !last.advanced && !rolledBack) {
          if (++idle > 12) break;
        } else idle = 0;
      } else
        reconciled = (await runtime.publication.step(job, context(), { enrollSource: true })).status === 'reconciled';
      if (rolledBack && !receiverCommits) {
        expect(await manifests()).toHaveLength(0);
        expect((await terminal()).ack_after).toBe(0);
      }
    }
    if (!receiverCommits) {
      const progress = await f.db.admin.query(
        `SELECT j.phase,b.state,b.coverage_after,(SELECT max(verified_home) FROM semantic.public_filter_repair_step
          WHERE bootstrap=b.bootstrap) AS verified_home,(SELECT count(*) FROM search.public_filter_ack_range n WHERE n.job=j.job) AS ranges,
          EXISTS(SELECT FROM search.public_filter_ack_authority a WHERE a.job=j.job) AS bound
          FROM search.generation_publication j LEFT JOIN semantic.public_filter_bootstrap b ON b.publication_job=j.job
          WHERE j.job=$1`,
        [job.job],
      );
      throw new Error(
        `Original receiver failed to commit: ${JSON.stringify({ progress: progress.rows, last, error: String(nativeError) })}`,
      );
    }
    expect(rolledBack).toBe(true);
    expect(sameTransactionRefused).toBe(true);
    const original = await manifests();
    expect(original).toHaveLength(1);
    expect((await terminal()).ack_after).toBe(0);
    expect(
      (
        await f.db.admin.query(
          'SELECT 1 FROM search.public_filter_coverage_home WHERE acknowledged_baseline=$1 LIMIT 1',
          [original[0].bootstrap],
        )
      ).rows,
    ).toHaveLength(0);
    const cut = [original[0].registration, original[0].bootstrap];
    const effective = `SELECT source_home,behind,acknowledged_observation,acknowledged_execution,acknowledged_settlement,
      relevant_position>acknowledged_position AS later FROM semantic.public_filter_effective_homes($1,$2,$3) ORDER BY source_home`;
    const receipt = {
      acknowledged_observation: original[0].observation,
      acknowledged_execution: original[0].execution,
      acknowledged_settlement: original[0].settlement,
    };
    expect((await f.db.admin.query(effective, [...cut, null])).rows).toEqual([]);
    expect((await f.db.admin.query(effective, [...cut, home])).rows).toEqual([
      { source_home: home, behind: false, later: false, ...receipt },
    ]);
    // Loss of the original terminal Search page invalidates its historical
    // evidence even while the execution still holds the same closed settlement.
    const probe = await f.db.admin.connect();
    try {
      await probe.query('BEGIN');
      const m = original[0];
      const removed = await probe.query(
        `DELETE FROM search.public_filter_repair_page p WHERE (p.partition_no,p.observation,p.execution,p.ordinal)=(
          SELECT partition_no,observation,execution,ordinal FROM search.public_filter_repair_page
          WHERE (partition_no,observation,execution)=(0,$1,$2) ORDER BY ordinal DESC LIMIT 1)`,
        [m.observation, m.execution],
      );
      expect(removed.rowCount).toBe(1);
      expect(
        (
          await probe.query('SELECT semantic.public_filter_committed_ack($1,$2,$3,$4) AS valid', [
            m.bootstrap,
            m.execution,
            m.terminal,
            m.binding,
          ])
        ).rows,
      ).toEqual([{ valid: false }]);
      expect((await probe.query(effective, [...cut, home])).rows[0]).toMatchObject({
        behind: true,
        acknowledged_settlement: null,
      });
    } finally {
      await probe.query('ROLLBACK');
      probe.release();
    }
    blockRead = true;
    await runtime.publication.activate(job, context());
    expect((await terminal()).ack_after).toBe(0);
    blockRead = false;

    await f.post(`/v1/subjects/${book}:hide`, { reason: 'Catalogue withdrawal' });
    expect(
      (
        await f.db.admin.query(
          `SELECT 1 FROM semantic.public_filter_privacy_pending WHERE partition_no=$1 AND input_key='["scope","subject"]' AND live`,
          [home],
        )
      ).rowCount,
    ).toBe(1);
    for (let turn = 0; turn < 16; turn++) {
      const result = await maintainPublicFilterCoverageHome(f.db.pool, home, context(), 100);
      if (!result.more) break;
    }
    const dirty = () =>
      f.db.admin.query(
        `SELECT h.relevant_position>b.source_position AS later,h.baseline_delta,h.last_change_generation>$3::bigint AS changed FROM search.public_filter_coverage_home h
       JOIN search.public_filter_coverage_baseline b ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=
         (h.partition_no,h.registration,h.baseline_bootstrap,h.source_home)
       WHERE (h.partition_no,h.registration,h.source_home)=(0,$1,$2)`,
        [original[0].registration, home, original[0].generation],
      );
    expect((await dirty()).rows).toEqual([{ later: true, baseline_delta: true, changed: true }]);
    await runtime.publication.activate(job, context());
    expect(sourceCommits).toBe(1);
    expect((await terminal()).ack_after).toBe(4096);
    await runtime.publication.activate(job, context());
    expect(sourceCommits).toBe(1);
    expect(receiverCommits).toBe(1);
    expect(await manifests()).toEqual(original);
    expect((await dirty()).rows).toEqual([{ later: true, baseline_delta: true, changed: true }]);
    const reader = await f.db.admin.connect();
    try {
      await reader.query('BEGIN');
      const visits = async () =>
        Number(
          (
            await reader.query(`SELECT seq_tup_read+idx_tup_fetch AS visits FROM pg_stat_xact_user_tables
          WHERE relid='search.public_filter_coverage_home'::regclass`)
          ).rows[0].visits,
        );
      const before = await visits();
      expect((await reader.query(effective, [...cut, null])).rows).toEqual([
        { source_home: home, behind: true, later: true, ...receipt },
      ]);
      expect((await visits()) - before).toBeLessThanOrEqual(9);
      // The real settlement ID proves only its original position, even if copied onto a later raw ACK.
      await reader.query(
        `UPDATE search.public_filter_coverage_home SET acknowledged_position=relevant_position,
          acknowledged_native_enqueue=native_enqueue_revision,acknowledged_native_revision=native_revision,
          acknowledged_native_claim_revision=native_claim_revision,acknowledged_baseline=baseline_bootstrap,
          acknowledged_observation=$3,acknowledged_execution=$4,acknowledged_settlement=$5,behind=false
         WHERE (partition_no,registration,source_home)=(0,$1,$2)`,
        [
          cut[0],
          home,
          receipt.acknowledged_observation,
          receipt.acknowledged_execution,
          receipt.acknowledged_settlement,
        ],
      );
      expect((await reader.query(effective, [...cut, home])).rows).toEqual([
        { source_home: home, behind: true, later: true, ...receipt },
      ]);
      await reader.query(
        `UPDATE search.public_filter_coverage_home SET native_enqueue_revision=native_enqueue_revision+1
        WHERE (partition_no,registration)=(0,$1) AND source_home BETWEEN 0 AND 11`,
        [cut[0]],
      );
      expect((await reader.query(effective, [...cut, null])).rows.map((row) => row.source_home)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      // Retire the current home and its receipt outside the lookahead, under their foreign keys.
      await reader.query(
        `DELETE FROM search.public_filter_coverage_home
         WHERE (partition_no,registration,baseline_bootstrap,source_home)=(0,$1,$2,4095)`,
        cut,
      );
      await reader.query(
        `DELETE FROM search.public_filter_coverage_baseline
        WHERE (partition_no,registration,bootstrap,source_home)=(0,$1,$2,4095)`,
        cut,
      );
      expect((await reader.query(effective, [...cut, null])).rows).toEqual([
        {
          source_home: null,
          behind: true,
          later: null,
          acknowledged_observation: null,
          acknowledged_execution: null,
          acknowledged_settlement: null,
        },
      ]);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
  } finally {
    try {
      await f.db.admin.query(
        'ALTER TABLE search.public_filter_coverage_preparation ALTER COLUMN ack_protocol SET DEFAULT 0',
      );
      await runtime.close();
      await search.request('DELETE', `/${target}`);
    } finally {
      await f.close();
    }
  }
}, 450_000);
