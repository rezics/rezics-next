import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, ID, initializeFreshGraph, iri, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork }
  from '../../../services/main/src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork, setAdmittedWorkScalar }
  from '../../../services/main/src/modules/work/edit-admitted.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import { reconcileRetainedWorkCreate, reconcileRetainedWorkEdit, RetainedEffectConflict }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { sameScalar, scalarFromBinding, SCALAR_PREDICATE, type WorkScalarValue }
  from '../../../services/main/src/modules/work/scalar-value.ts';
import { cutoverRestoredGraphLineage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../../..');

function stack(action: 'stack:up' | 'stack:reset', runId: string): void {
  const command = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (command.status !== 0 || command.error) throw new Error(`${action} failed: ${(
    command.stderr || command.stdout || command.error?.message || '').slice(-2000)}`);
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('MODEL02/OPS03: held graph restore replays exact scalar and title Work revisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const prefix = randomUUID().slice(0, 12);
  const liveId = `scalar-${prefix}-l`;
  const restoredId = `scalar-${prefix}-r`;
  const directory = join(root, '.temp', `scalar-restore-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started: string[] = [];
  let accessPool: Pool | undefined;
  let relayPool: Pool | undefined;
  try {
    for (const runId of [liveId, restoredId]) { started.push(runId); stack('stack:up', runId); }
    const liveApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!,
      restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL, max: 4 });
    relayPool = new Pool({ connectionString: liveApps.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const live: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `model02-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    const principal = { issuer: 'https://qa-scalar-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = ID + randomUUID();
    const account = { verify: async () => principal };
    const request = new Request('https://main.rezics.test/v1/works', {
      headers: { authorization: 'Bearer recovery' } });
    const access = new AccessAdmissionRegistry(accessPool);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1,$2)',
      [actor, 'agent']);
    const grant = async (scope: string, action: string) => {
      await accessPool!.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool!.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await accessPool!.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const created = await createAdmittedMetadataWork(live, account, access, request,
      { title: 'Retained scalar Work', actingSubject: actor, idempotencyKey: `create-${randomUUID()}` });
    await grant(`work:edit:${created.work}`, 'work.edit');
    const values: readonly (WorkScalarValue | undefined)[] = [
      { lexical: '0', kind: 'integer' }, { kind: 'boolean', lexical: 'false' },
      { kind: 'string', lexical: '' }, undefined, { kind: 'unknown' }, { kind: 'no-value' },
    ];
    const edits: Array<{ revision: string; receipt: string; sequence: string;
      value: WorkScalarValue | undefined }> = [];
    let previous = created.workRevision;
    for (const value of values) {
      const edited = await setAdmittedWorkScalar(live, account, access, request,
        { work: created.work, expectedHead: previous,
          ...(value === undefined ? {} : { scalarValue: value }), actingSubject: actor,
          idempotencyKey: `scalar-${randomUUID()}` });
      edits.push({ ...edited, value });
      previous = edited.revision;
    }
    const title = await editAdmittedMetadataWork(live, account, access, request,
      { work: created.work, expectedHead: previous, title: 'Retained new title',
        actingSubject: actor, idempotencyKey: `title-${randomUUID()}` });
    expect([created.sequence, ...edits.map(edit => edit.sequence), title.sequence])
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    for (let n = 1; n <= 8; n++) {
      expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence).toBe(String(n));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch,
      sequence: '8', batchCount: '8', eventCount: '8' });
    await engageAccessRecoveryFence(accessPool);
    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki,
      { prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const restored: WorkActivationEnvironment = { ...live, fuseki: restoredFuseki,
      lineage: nextLineage };
    expect((await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '1')).work).toBe(created.work);
    expect((await readExactWorkRevision(restored, created.workRevision,
      async () => true)).scalarValue).toBeUndefined();
    const first = edits[0]!;
    const accessDigest = (await accessPool.query<{ request_digest: string }>(
      'SELECT request_digest FROM access.admission WHERE graph_receipt = $1',
      [first.receipt])).rows[0]?.request_digest;
    if (!accessDigest) throw new Error('retained scalar Access digest absent');
    await accessPool.query('UPDATE access.admission SET request_digest = $1 WHERE graph_receipt = $2',
      ['0'.repeat(64), first.receipt]);
    await expect(reconcileRetainedWorkEdit(restored, accessPool, relayPool,
      coverage, '2')).rejects.toBeInstanceOf(RetainedEffectConflict);
    expect((await restoredFuseki.query(`SELECT ?value WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.work)} <${SCALAR_PREDICATE}> ?value } }`)).results?.bindings).toHaveLength(0);
    await accessPool.query('UPDATE access.admission SET request_digest = $1 WHERE graph_receipt = $2',
      [accessDigest, first.receipt]);
    for (const edit of edits) {
      expect((await reconcileRetainedWorkEdit(restored, accessPool, relayPool,
        coverage, edit.sequence)).revision).toBe(edit.revision);
      const exact = await readExactWorkRevision(restored, edit.revision, async () => true);
      expect(sameScalar(exact.scalarValue, edit.value)).toBe(true);
      const graph = await restoredFuseki.query(`SELECT ?value WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.work)} <${SCALAR_PREDICATE}> ?value } }`);
      const bindings = graph.results?.bindings ?? [];
      expect(bindings).toHaveLength(edit.value === undefined ? 0 : 1);
      expect(sameScalar(scalarFromBinding(bindings[0]?.value), edit.value)).toBe(true);
    }
    expect((await reconcileRetainedWorkEdit(restored, accessPool, relayPool,
      coverage, '2')).replayed).toBe(true);
    expect((await reconcileRetainedWorkEdit(restored, accessPool, relayPool,
      coverage, '8')).revision).toBe(title.revision);
    const latest = await readExactWorkRevision(restored, title.revision, async () => true);
    expect(latest.title).toBe('Retained new title');
    expect(latest.scalarValue).toEqual({ kind: 'no-value' });
    expect((await restoredFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.work)} <${SCALAR_PREDICATE}> <https://rezics.com/vocab/ExplicitNoValue> . } }`))
      .boolean).toBe(true);
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end()]);
    for (const runId of started.reverse()) stack('stack:reset', runId);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
