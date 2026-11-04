import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId, routeOf } from '../../src/route/route.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { readIdentityMappings } from '../../src/semantic/identity-epoch-read.ts';
import { capture, costOf, openGrowthDatabase, type Capture } from '../support/growth.ts';
import { explainPlanEntries, walkPlanTree } from '../support/growth-plan-walk.ts';
import { home, identityEpochDatabase, seedLegacyRoot } from './support/identity-epoch.ts';
import { isolatedDeployment, seedChain, settle } from './support/identity-terminal-closure.ts';

function assertSelectedDirectorySeek(raw: Capture, selected: number) {
  const scans = raw.plans
    .flatMap((document) => explainPlanEntries(document).flatMap(({ plan }) => [...walkPlanTree(plan)]))
    .map(({ node }) => node)
    .filter((node) => node['Relation Name'] === 'identity_epoch_original');
  // Both collections really reached the native directory on the one control home.
  expect(scans).toHaveLength(2);
  for (const scan of scans) {
    expect(['Index Scan', 'Index Only Scan']).toContain(String(scan['Node Type']));
    for (const key of ['partition_no', 'generation', 'original']) expect(String(scan['Index Cond'])).toContain(key);
  }
  const directory = costOf(raw).relations['semantic.identity_epoch_original'];
  expect(directory).toBeDefined();
  // Shared native accounting includes returned, filtered and rechecked rows and loops.
  expect(directory!.sequentialScans).toBe(0);
  expect(directory!.rows).toBeLessThanOrEqual(2 * selected);
  return directory!.rows;
}

test('fixed selected originals seek exact current entries through 256/1024/4096 retained directory rows', async () => {
  const db = await identityEpochDatabase();
  let measured: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  try {
    const ids = await seedChain(db, 2);
    const original = ids[0]!,
      terminal = ids.at(-1)!;
    expect((await installIdentityEpochBootstrap(db.pool)).mode).toBe('legacy');
    expect((await settle(db, ids, original, 512)).observed).toMatchObject({ state: 'mapped', original, terminal });
    const key = (
      await db.admin.query(
        'SELECT partition_no,generation FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [home(terminal), terminal],
      )
    ).rows[0]!;
    const oldGeneration = randomUUID();
    // Keep exact old evidence for the selected original: absence in the current
    // generation must not fall back to this otherwise matching installed entry.
    await db.admin.query(
      `INSERT INTO semantic.identity_epoch_original
       SELECT (jsonb_populate_record(NULL::semantic.identity_epoch_original,
         to_jsonb(o)||jsonb_build_object('generation',$4::uuid))).*
       FROM semantic.identity_epoch_original o
       WHERE (partition_no,generation,original)=($1,$2,$3)`,
      [key.partition_no, key.generation, original, oldGeneration],
    );
    measured = await openGrowthDatabase(db.url);
    const absent = newId(routeOf(original)!);
    let previous = 0;
    for (const population of [256, 1024, 4096]) {
      const unrelated = Array.from({ length: (population - previous) / 2 }, () => newId(routeOf(terminal)!));
      // Noise shares the relevant home and a large terminal group, with both
      // current-generation originals and retained old-generation history.
      await db.admin.query(
        `INSERT INTO semantic.identity_epoch_original
         (partition_no,generation,original,terminal,source_partition,source_generation,present)
         SELECT $1,generation,original,$2,$1,1,true
         FROM unnest($3::uuid[]) original CROSS JOIN unnest($4::uuid[]) generation`,
        [key.partition_no, terminal, unrelated, [key.generation, oldGeneration]],
      );
      await db.admin.query('ANALYZE semantic.identity_epoch_original');
      const found = await capture(measured, () => readIdentityMappings(measured!.pool, [...ids, absent]));
      expect(found.value).toEqual([
        ...ids.map((id) => expect.objectContaining({ state: 'mapped', original: id, terminal })),
        { state: 'absent' },
      ]);
      const foundRows = assertSelectedDirectorySeek(found.capture, ids.length);
      // Move only the selected current entry out of its key. Leave the old
      // generation, source mapping, terminal and unrelated population intact.
      const replacement = newId(routeOf(terminal)!);
      await db.admin.query(
        `UPDATE semantic.identity_epoch_original SET original=$4
         WHERE (partition_no,generation,original)=($1,$2,$3)`,
        [key.partition_no, key.generation, original, replacement],
      );
      const missing = await capture(measured, () => readIdentityMappings(measured!.pool, [original]));
      expect(missing.value).toEqual([{ state: 'unavailable', reason: 'bootstrap' }]);
      const missingRows = assertSelectedDirectorySeek(missing.capture, 0);
      await db.admin.query(
        `UPDATE semantic.identity_epoch_original SET original=$4
         WHERE (partition_no,generation,original)=($1,$2,$3)`,
        [key.partition_no, key.generation, replacement, original],
      );
      console.info('selected native terminal directory', { population, foundRows, missingRows });
      previous = population;
    }
  } finally {
    await measured?.close();
    await db.close();
  }
});

// Chain size and unrelated native population are independent dimensions. These
// are real installed API calls against migrated homes, with PostgreSQL RLS.
for (const edges of [101, 205, 409]) {
  for (const population of [0, 512]) {
    test(`native closure advances bounded retained work at ${edges} edges and ${population} unrelated subjects`, async () => {
      const db = await isolatedDeployment();
      try {
        const ids = await seedChain(db, edges);
        for (let index = 0; index < population; index++) await seedLegacyRoot(db, 0x7100 + (index % 3) * 16);
        await db.install();
        const homes = [...new Set([...ids].reverse().map(home))];
        const generations = new Map<number, bigint>();
        const receipts = new Set<string>();
        let maxRows = 0,
          maxPoints = 0,
          maxStatements = 0,
          maxBytes = 0,
          maxEngineRequests = 0;
        let observed = (await readIdentityMappings(db.pool, [ids[0]!]))[0]!;
        let steps = 0;
        // A test watchdog is not a production hop cap or a guessed terminal.
        // Success requires the positive actual terminal assertion below.
        for (let round = 0; round < 2048 && observed.state !== 'mapped'; round++) {
          for (const partition of homes) {
            const progress = await stepIdentityEpochBootstrap(db.pool, partition);
            expect(progress.work.rows).toBeLessThanOrEqual(100);
            expect(progress.generation).toBeGreaterThanOrEqual(generations.get(partition) ?? 0n);
            expect(progress.native.partition).toBe(partition);
            generations.set(partition, progress.generation);
            receipts.add(progress.native.transactionId);
            maxRows = Math.max(maxRows, progress.work.rows);
            maxPoints = Math.max(maxPoints, progress.work.points);
            maxStatements = Math.max(maxStatements, progress.work.statements);
            maxBytes = Math.max(maxBytes, progress.work.bytes);
            maxEngineRequests = Math.max(maxEngineRequests, progress.work.engineRequests);
            steps++;
          }
          observed = (await readIdentityMappings(db.pool, [ids[0]!]))[0]!;
          if (observed.state === 'mapped') expect(observed.terminal).toBe(ids.at(-1)!);
        }
        expect(observed).toMatchObject({ state: 'mapped', original: ids[0], terminal: ids.at(-1) });
        expect(steps).toBeGreaterThan(1);
        expect(receipts.size).toBeGreaterThan(1);
        expect([...generations.values()].some((generation) => generation > 1n)).toBe(true);
        console.info(
          'native terminal closure growth',
          JSON.stringify({
            edges,
            population,
            steps,
            receipts: receipts.size,
            maxRows,
            maxPoints,
            maxStatements,
            maxBytes,
            maxEngineRequests,
          }),
        );
      } finally {
        await db.close();
      }
    });
  }
}

for (const homes of [1, 3]) {
  test(`shared suffix and ${homes}-home page crossing retain linear membership`, async () => {
    const db = await isolatedDeployment();
    try {
      const ids = await seedChain(db, 205, 0x7410, homes);
      const branches: string[] = [];
      const { historicalEdge, settle } = await import('./support/identity-terminal-closure.ts');
      for (let index = 0; index < 32; index++) {
        const branch = await seedLegacyRoot(db, 0x7410 + (index % homes) * 16);
        branches.push(branch);
        await historicalEdge(db, branch, ids[40 + index]!);
      }
      await db.install();
      const all = [...ids, ...branches];
      expect((await settle(db, all, ids[0]!, 2048)).observed).toMatchObject({
        state: 'mapped',
        original: ids[0],
        terminal: ids.at(-1),
      });
      for (const original of branches)
        expect((await settle(db, all, original, 2048)).observed).toMatchObject({
          state: 'mapped',
          original,
          terminal: ids.at(-1),
        });
      const memberships = (
        await db.admin.query(
          `SELECT count(*)::integer n,
        count(DISTINCT original)::integer originals FROM semantic.identity_epoch_original
        WHERE terminal=$1`,
          [ids.at(-1)],
        )
      ).rows[0]!;
      expect(memberships).toEqual({ n: all.length, originals: all.length });
      expect(
        (
          await db.admin.query(
            `SELECT count(*)::integer n FROM semantic.identity_epoch_mapping
        WHERE original=ANY($1::uuid[])`,
            [all],
          )
        ).rows,
      ).toEqual([{ n: all.length }]);
      const ledger = (
        await db.admin.query(`SELECT partition_no,count(*)::integer slots,
        sum(closure_copies)::integer copies FROM semantic.identity_epoch_mapping_generation GROUP BY partition_no`)
      ).rows;
      for (const home of ledger) {
        expect(home.slots).toBeLessThanOrEqual(4);
        expect(home.copies).toBeLessThanOrEqual(16384);
      }
    } finally {
      await db.close();
    }
  });
}
