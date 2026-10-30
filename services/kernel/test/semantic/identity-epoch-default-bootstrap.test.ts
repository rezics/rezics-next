import { afterAll, expect, test } from 'bun:test';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
  queryCommunityDatabase,
  restartWorker,
  worker,
} from '../community/community-driver.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import {
  readIdentityEpochCutover,
  stepIdentityEpochBootstrap,
  stepIdentityEpochBootstrapWork,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import { epochFixture, home, identityEpochDatabase, seedLegacyRoot } from './support/identity-epoch.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';

afterAll(closeCommunityDrivers);
const deployments: Awaited<ReturnType<typeof identityEpochDatabase>>[] = [];
afterAll(async () => {
  for (const deployment of deployments) await deployment.close();
});

test('default Community worker closes every native legacy home and then repairs real caller work within its default settle', async () => {
  const deployment = await identityEpochDatabase();
  deployments.push(deployment);
  const legacy = await seedLegacyRoot(deployment, 0x6e10);
  expect((await deployment.admin.query('SELECT * FROM semantic.identity_epoch_installation')).rows).toEqual([]);
  expect(
    (await deployment.admin.query('SELECT * FROM semantic.identity_epoch_mapping WHERE original=$1', [legacy])).rows,
  ).toEqual([]);
  // The supported databaseUrl template is copied before the actual default worker is constructed.
  // Close all staging connections first; the production installer sees the historical source itself.
  await deployment.disconnect();
  const driver = await createCommunityDriver({ databaseUrl: deployment.url });
  const fixture = await driver.provision();
  await driver.settle();
  const closure = await queryCommunityDatabase<{ homes: number; custody: number; remaining: number }>(`
    SELECT
      (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home h
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
            (h.partition_no,h.sealed_transaction_id,h.sealed_epoch,h.sealed_position)
       JOIN core.partition p ON p.partition_no=h.partition_no AND p.epoch=h.sealed_epoch
       WHERE c.purpose='bootstrap' AND p.write_state='active' AND p.position>=h.sealed_position
         AND NOT h.needs_work) homes,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody) custody,
      (SELECT remaining FROM semantic.identity_epoch_bootstrap_topology WHERE partition_no=0) remaining
  `);
  expect(closure).toEqual([{ homes: 4096, custody: 4096, remaining: 0 }]);
  const { system } = communityFixtureRuntime();
  expect((await installIdentityEpochBootstrap(system.database.pool)).mode).toBe('legacy');
  expect(await identityEpochStore.readMapping(system.database.pool, legacy)).toMatchObject({
    state: 'mapped',
    original: legacy,
    terminal: legacy,
  });
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
  const changed = await driver.subjectCommand(
    'edit',
    fixture.subjectOwner,
    fixture.subject.id,
    '"native-bootstrap-edit"',
  );
  expect(changed.status).toBeLessThan(300);
  await driver.settle();
  const dirty = await queryCommunityDatabase<{ revision: string; captured_revision: string }>(
    'SELECT revision,captured_revision FROM semantic.identity_epoch_dirty WHERE original=$1',
    [fixture.subject.id],
  );
  expect(dirty).toHaveLength(1);
  expect(dirty[0]!.captured_revision).toBe(dirty[0]!.revision);
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
}, 180_000);

test('fresh native default startup does not sweep empty homes when no legacy identity source exists', async () => {
  // A new actual Community system clones the untouched migrated template. Neither this test nor
  // the driver installs legacy subjects, ready bits, mappings, receiving receipts or source ACKs.
  await closeCommunityDrivers();
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  await driver.settle();
  const closure = await queryCommunityDatabase<{ empty_home_exports: number; empty_home_custody: number }>(`
    SELECT
      (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home h
       WHERE NOT EXISTS (SELECT 1 FROM semantic.subject s WHERE s.route / 16 = h.partition_no)
         AND NOT EXISTS (SELECT 1 FROM semantic.merge_member m WHERE m.route / 16 = h.partition_no)
      ) empty_home_exports,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody c
       WHERE NOT EXISTS (SELECT 1 FROM semantic.subject s WHERE s.route / 16 = c.source_partition)
         AND NOT EXISTS (SELECT 1 FROM semantic.merge_member m WHERE m.route / 16 = c.source_partition)
      ) empty_home_custody
  `);
  expect(closure).toEqual([{ empty_home_exports: 0, empty_home_custody: 0 }]);
  const { system } = communityFixtureRuntime();
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
}, 180_000);

test('committed native absence and birth custody survive default worker restart without a topology sweep', async () => {
  const driver = await createCommunityDriver();
  const { system } = communityFixtureRuntime();
  const installed = await installIdentityEpochBootstrap(system.database.pool);
  expect(installed.mode).toBe('absence');
  expect(installed.native.position).toBeGreaterThan(0n);
  const retained = await queryCommunityDatabase(`
    SELECT i.*,c.epoch,c.position,k.installation_xid FROM semantic.identity_epoch_installation i
    JOIN semantic.identity_epoch_installation_cut k USING(partition_no)
    JOIN semantic.identity_epoch_native_commit c USING(partition_no,transaction_id)
    JOIN core.partition p USING(partition_no)
    WHERE c.purpose='bootstrap' AND c.epoch=p.epoch AND c.position<=p.position AND p.write_state='active'
  `);
  expect(retained).toHaveLength(1);
  expect(retained[0]!.transaction_id).toBe(installed.native.transactionId);
  const storage = await queryCommunityDatabase(`
    SELECT c.relname,pg_relation_size(c.oid)::text heap_bytes,pg_indexes_size(c.oid)::text index_bytes,
      (SELECT count(*)::integer FROM pg_index i WHERE i.indrelid=c.oid) indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='semantic' AND c.relname IN ('identity_epoch_installation_cut','identity_epoch_installation')
    ORDER BY c.relname
  `);
  expect(storage).toHaveLength(2);
  expect(storage.map((row) => row.indexes)).toEqual([1, 1]);
  console.info(
    'native identity installation custody',
    JSON.stringify({
      proof: { ...installed, native: { ...installed.native, position: installed.native.position.toString() } },
      retained,
      storage,
    }),
  );
  const before = await queryCommunityDatabase(`
    SELECT (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home) homes,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody) custody
  `);
  await worker.stop();
  await restartWorker();
  await driver.settle();
  expect(await installIdentityEpochBootstrap(system.database.pool)).toEqual(installed);
  expect(
    await queryCommunityDatabase(`
    SELECT (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home) homes,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody) custody
  `),
  ).toEqual(before);
  expect(
    (
      await queryCommunityDatabase<{ name: string }>(
        'SELECT name FROM dbos.queues WHERE name=ANY($1::text[]) ORDER BY name',
        [Object.keys(WORK_QUEUES)],
      )
    ).map((row) => row.name),
  ).toEqual(Object.keys(WORK_QUEUES).sort());
  // Real caller-created revision 1 after restart must pass the installed deferred birth guard.
  const fixture = await driver.provision();
  await driver.settle();
  const born = await queryCommunityDatabase(
    `
    SELECT m.epoch,m.recorded_transaction_id FROM semantic.revision r
    JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(r.route,r.subject_id)
    JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(r.route,r.subject_id,r.subject_id)
    WHERE r.subject_id=$1 AND r.revision=1 AND r.kind='create' AND m.origin='creation'
      AND m.terminal=r.subject_id AND g.terminal=r.subject_id AND m.epoch=g.epoch
      AND r.recorded_transaction_id=m.recorded_transaction_id AND r.recorded_transaction_id=g.recorded_transaction_id
      AND r.xmin=m.xmin AND r.xmin=g.xmin
  `,
    [fixture.subject.id],
  );
  expect(born).toHaveLength(1);
  expect(BigInt(born[0]!.epoch)).toBeGreaterThan(0n);
}, 180_000);

test('missing and rolled-back installation never assert native absence readiness', async () => {
  const db = await identityEpochDatabase();
  try {
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
    const tx = await db.admin.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect((await tx.query('SELECT semantic.prepare_identity_epoch_installation() mode')).rows).toEqual([
        { mode: 'absence' },
      ]);
      expect((await tx.query('SELECT * FROM semantic.identity_epoch_installation_cut')).rowCount).toBe(1);
      // Neither an uncommitted cut nor the trigger DDL is a native closure receipt.
      expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
      await tx.query('ROLLBACK');
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    expect((await db.admin.query('SELECT * FROM semantic.identity_epoch_installation_cut')).rows).toEqual([]);
    expect((await db.admin.query('SELECT semantic.identity_epoch_installation_guards() valid')).rows).toEqual([
      { valid: false },
    ]);
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
    expect((await installIdentityEpochBootstrap(db.pool)).mode).toBe('absence');
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'ready' });
  } finally {
    await db.close();
  }
}, 30_000);

test('interrupted installation retains the guarded cut and recovers only through actual native closure', async () => {
  const db = await identityEpochDatabase();
  try {
    // This is the production migration operation. Stop after its commit, before the native command.
    await db.admin.query('SELECT semantic.prepare_identity_epoch_installation()');
    const cut = (await db.admin.query('SELECT * FROM semantic.identity_epoch_installation_cut')).rows;
    expect(cut).toHaveLength(1);
    expect((await db.admin.query('SELECT * FROM semantic.identity_epoch_installation')).rows).toEqual([]);
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
    await expect(seedLegacyRoot(db, 0x6e20)).rejects.toThrow('identity_epoch_birth_custody_required');
    const proof = await installIdentityEpochBootstrap(db.pool);
    expect(proof.mode).toBe('absence');
    expect(proof.installationXid).toBe(cut[0]!.installation_xid);
    expect((await db.admin.query('SELECT * FROM semantic.identity_epoch_installation_cut')).rows).toEqual(cut);
    expect(await installIdentityEpochBootstrap(db.pool)).toEqual(proof);
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'ready' });
  } finally {
    await db.close();
  }
}, 30_000);

test('disabled source capture invalidates the native absence proof rather than falling back to readiness', async () => {
  const db = await identityEpochDatabase();
  try {
    const proof = await installIdentityEpochBootstrap(db.pool);
    await db.admin.query('ALTER TABLE semantic.redirect DISABLE TRIGGER identity_epoch_capture_redirect');
    expect((await db.admin.query('SELECT valid FROM semantic.read_identity_epoch_installation()')).rows).toEqual([
      { valid: false },
    ]);
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
    await expect(installIdentityEpochBootstrap(db.pool)).rejects.toThrow('identity_epoch_installation_unavailable');
    await db.admin.query('ALTER TABLE semantic.redirect ENABLE TRIGGER identity_epoch_capture_redirect');
    expect(await installIdentityEpochBootstrap(db.pool)).toEqual(proof);
  } finally {
    await db.close();
  }
}, 30_000);

test('installation drains an in-flight historical source writer and selects full legacy closure', async () => {
  const db = await identityEpochDatabase();
  const writer = await db.admin.connect();
  let installing: ReturnType<typeof installIdentityEpochBootstrap> | undefined;
  try {
    await writer.query('BEGIN');
    const legacy = await seedLegacyRoot({ admin: writer }, 0x6e30);
    installing = installIdentityEpochBootstrap(db.pool);
    // Observe the real relation-lock wait; release only this test's writer once the cut is waiting.
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiting = await db.admin.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%prepare_identity_epoch_installation%' AND pid<>pg_backend_pid()`);
      if (waiting.rowCount) break;
      if (Date.now() >= deadline) throw new Error('Native installation did not wait for the source writer');
      await Bun.sleep(10);
    }
    await writer.query('COMMIT');
    const proof = await installing;
    expect(proof.mode).toBe('legacy');
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'blocked' });
    expect(
      (await db.admin.query('SELECT original FROM semantic.identity_epoch_mapping WHERE original=$1', [legacy])).rows,
    ).toEqual([]);
    expect((await db.admin.query('SELECT remaining FROM semantic.identity_epoch_bootstrap_topology')).rows).toEqual([
      { remaining: 4096 },
    ]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await installing?.catch(() => {});
    await db.close();
  }
}, 30_000);

test('a transaction predating the absence cut cannot commit a late historical birth', async () => {
  const db = await identityEpochDatabase();
  const writer = await db.admin.connect();
  try {
    await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await writer.query('SELECT pg_current_snapshot()');
    const proof = await installIdentityEpochBootstrap(db.pool);
    await seedLegacyRoot({ admin: writer }, 0x6e40);
    await expect(writer.query('COMMIT')).rejects.toThrow('identity_epoch_birth_custody_required');
    expect((await db.admin.query('SELECT * FROM semantic.subject')).rows).toEqual([]);
    expect((await db.admin.query('SELECT * FROM semantic.identity_epoch_dirty')).rows).toEqual([]);
    expect(await installIdentityEpochBootstrap(db.pool)).toEqual(proof);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await db.close();
  }
}, 30_000);

test('concurrent native installers retain one cut and one closure receipt', async () => {
  const db = await identityEpochDatabase();
  try {
    const proofs = await Promise.all(Array.from({ length: 3 }, () => installIdentityEpochBootstrap(db.pool)));
    expect(proofs).toEqual([proofs[0]!, proofs[0]!, proofs[0]!]);
    expect(
      (await db.admin.query('SELECT count(*)::integer count FROM semantic.identity_epoch_installation_cut')).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (await db.admin.query('SELECT count(*)::integer count FROM semantic.identity_epoch_installation')).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (await db.admin.query('SELECT count(*)::integer count FROM semantic.identity_epoch_native_commit')).rows,
    ).toEqual([{ count: 1 }]);
    expect(await readIdentityEpochCutover(db.pool)).toEqual({ state: 'ready' });
  } finally {
    await db.close();
  }
}, 30_000);

test('absence repair visits a new dirty home before wrapping to an unfinished earlier home', async () => {
  const db = await identityEpochDatabase();
  const f = await epochFixture(db.url);
  try {
    expect((await installIdentityEpochBootstrap(f.pool)).mode).toBe('absence');
    const low = (await f.create('Earlier original', 0x6ea0)).subject.id;
    const lowTarget = (await f.create('Earlier survivor', 0x6ea0)).subject.id;
    const high = (await f.create('Later original', 0x6eb0)).subject.id;
    const highTarget = (await f.create('Later survivor', 0x6eb0)).subject.id;
    let progress;
    do {
      progress = await stepIdentityEpochBootstrap(f.pool, home(low));
    } while (progress.state !== 'caught-up');
    await f.merge(low, lowTarget);
    expect((await stepIdentityEpochBootstrapWork(f.pool, false))?.partition).toBe(home(low));
    await f.merge(high, highTarget);
    // The earlier home still has a real dirty/member-dirty continuation. The new home
    // has never had a bootstrap_home row, and must participate in the same ordered cursor.
    expect(
      (
        await f.admin.query('SELECT needs_work FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=$1', [
          home(low),
        ])
      ).rows,
    ).toEqual([{ needs_work: true }]);
    expect((await stepIdentityEpochBootstrapWork(f.pool, false))?.partition).toBe(home(high));
    for (const original of [low, high]) {
      do {
        progress = await stepIdentityEpochBootstrap(f.pool, home(original));
      } while (progress.state !== 'caught-up');
    }
    expect(await identityEpochStore.readMapping(f.pool, high)).toMatchObject({ state: 'mapped', terminal: highTarget });
    expect(await identityEpochStore.readMapping(f.pool, low)).toMatchObject({ state: 'mapped', terminal: lowTarget });
    expect(
      (await f.admin.query('SELECT count(*)::integer homes FROM semantic.identity_epoch_bootstrap_home')).rows,
    ).toEqual([{ homes: 2 }]);
    expect((await f.admin.query('SELECT remaining FROM semantic.identity_epoch_bootstrap_topology')).rows).toEqual([
      { remaining: 4096 },
    ]);
  } finally {
    await f.close();
    await db.close();
  }
}, 30_000);
