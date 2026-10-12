import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { lockPreservationTarget } from '../src/modules/public-report/preservation.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { ZonePublicationUnavailable } from '../src/modules/zone/configuration.ts';
import { createZoneHomePublicationFixture } from './support/zone-home-publication-fixture.ts';

let cluster: PostgresCluster | undefined;
let admin: Pool | undefined;
let preservationPool: Pool | undefined;
let erasurePool: Pool | undefined;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
  const database = `home_publication_fence_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const connection = { ...cluster.connection, database, max: 3 };
  preservationPool = new Pool(connection);
  erasurePool = new Pool(connection);
  await admin.query('SELECT 1');
  await preservationPool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
      reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
}, 120_000);

afterAll(async () => {
  await erasurePool?.end();
  await preservationPool?.end();
  await admin?.end();
  cluster?.remove();
});

test('real site publication waits for the erasure target lock and holds it through native commit', async () => {
  let releaseCommit!: () => void, signalCommit!: () => void;
  const commitGate = new Promise<void>(resolveGate => { releaseCommit = resolveGate; });
  const commitEntered = new Promise<void>(resolveEntered => { signalCommit = resolveEntered; });
  const fixture = createZoneHomePublicationFixture({ preservationPool: preservationPool!,
    onBeforeCommit: async () => { signalCommit(); await commitGate; } });
  const erasure = await erasurePool!.connect();
  await erasure.query('BEGIN');
  await lockPreservationTarget(erasure, fixture.homeDocument);
  let publication: ReturnType<typeof fixture.publish> | undefined;
  try {
    publication = fixture.publish();
    await Promise.race([fixture.firstFenceAttempt, publication.then(() => {
      throw new Error('Site publication finished before acquiring its shared fence');
    })]);
    expect(fixture.state.commits).toEqual([]);
    await erasure.query('COMMIT');
    await Promise.race([commitEntered, publication.then(() => {
      throw new Error('Site publication finished before its native switch');
    })]);
    expect(fixture.state.fenceHeld).toBe(true);
    const probe = await erasurePool!.connect();
    try {
      await probe.query('BEGIN');
      expect((await probe.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 931)) AS locked', [fixture.homeDocument])).rows[0]?.locked).toBe(false);
      await probe.query('ROLLBACK');
    } finally { probe.release(); }
    releaseCommit();
    const result = await publication;
    expect(result.homeDocument).toBe(fixture.homeDocument);
    expect(fixture.state.commits).toEqual([result.homeRevision!]);
    expect(fixture.state.authorityScopes).toContain(`zone:edit:${fixture.zone}`);
    expect(fixture.state.fenceHeld).toBe(false);
    expect(fixture.state.settlements).toBe(1);
  } finally {
    releaseCommit();
    await erasure.query('ROLLBACK');
    erasure.release();
    await publication?.catch(() => undefined);
    fixture.cleanup();
  }
}, 15_000);

test('terminal site replay retains one home cut and settles after the shared fence is released', async () => {
  const fixture = createZoneHomePublicationFixture({ preservationPool: preservationPool! });
  try {
    const first = await fixture.publish(), replay = await fixture.publish();
    expect(replay.replayed).toBe(true);
    expect(replay.homeRevision).toBe(first.homeRevision);
    expect(fixture.state.commits).toEqual([first.homeRevision!]);
    expect(fixture.state.fenceAttempts).toBe(1);
    expect(fixture.state.pins).toBe(1);
    expect(fixture.state.settlements).toBe(2);
  } finally { fixture.cleanup(); }
});

for (const fence of ['held', 'unavailable'] as const) {
  test(`a ${fence} shared fence cannot activate a home cut`, async () => {
    const fixture = createZoneHomePublicationFixture({ preservationPool: preservationPool!, fence });
    try {
      await expect(fixture.publish()).rejects.toBeInstanceOf(ZonePublicationUnavailable);
      expect(fixture.state.commits).toEqual([]);
      if (fence === 'unavailable') expect(fixture.state.pins).toBe(0);
    } finally { fixture.cleanup(); }
  });
}

test('the shared document lock does not replace the owning Zone authority at the switch', async () => {
  const fixture = createZoneHomePublicationFixture({ preservationPool: preservationPool!, authority: 'deny' });
  try {
    await expect(fixture.publish()).rejects.toBeInstanceOf(AdmissionDenied);
    expect(fixture.state.authorityScopes).toContain(`zone:edit:${fixture.zone}`);
    expect(fixture.state.commits).toEqual([]);
    expect(fixture.state.fenceAttempts).toBe(1);
    expect(fixture.state.fenceHeld).toBe(false);
  } finally { fixture.cleanup(); }
});
