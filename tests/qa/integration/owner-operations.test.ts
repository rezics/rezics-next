import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { activateMetadataWork, GRAPHS, initializeFreshGraph, iri,
  metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';

test('MODEL26: owner reconciliation records exact missing, corrupt and recovered revision outcomes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = resolve('.temp', `owner-operations-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(directory, 'objects') };
  const ownerOperations = new OwnerOperations(relay, env);
  let active = true;
  const dependencies = { ownerOperations, account: { verify: async (request: Request,
    scopes: readonly string[]) => {
    if (request.headers.get('authorization') !== 'Bearer operator'
      || scopes.length !== 1 || scopes[0] !== 'owner:operate') {
      throw new AccountAssertionDenied('operator assertion denied');
    }
    return { issuer: 'https://qa-owner.test', subject: 'operator' };
  } }, access: { activePrincipalId: async () => active ? randomUUID() : null } };
  const app = createMainApp(fuseki, dependencies as unknown as MainWorkDependencies);
  const send = (path: string, body: object, key?: string, bearer = 'operator') => app.handle(new Request(
    `http://main.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
      'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body) }));
  const get = (path: string) => app.handle(new Request(`http://main.local${path}`,
    { headers: { authorization: 'Bearer operator' } }));
  const reconcile = (revision: string) => ({ profile: 'owner-reconciliation-v1',
    kind: 'revision_recovery', revision });
  try {
    await initializeFreshGraph(fuseki, env.lineage);
    const absent = `https://rezics.com/id/${randomUUID()}`;
    expect((await send('/v1/owners/reconciliations', reconcile(absent), 'denied', 'missing')).status).toBe(401);
    active = false;
    expect((await send('/v1/owners/reconciliations', reconcile(absent), 'inactive')).status).toBe(403);
    active = true;
    expect((await send('/v1/owners/reconciliations', reconcile(absent))).status).toBe(400);
    const key = `missing-${randomUUID()}`;
    const missingResponse = await send('/v1/owners/reconciliations', reconcile(absent), key);
    expect(missingResponse.status).toBe(201);
    const missing = await missingResponse.json() as { id: string; state: string; disposition: string };
    expect(missing).toMatchObject({ state: 'held', disposition: 'unavailable' });
    expect((await get(`/v1/owners/reconciliations/${missing.id}`)).status).toBe(200);
    expect((await send('/v1/owners/reconciliations', reconcile(absent), key)).status).toBe(200);
    expect((await send('/v1/owners/reconciliations', reconcile(`https://rezics.com/id/${randomUUID()}`), key)).status).toBe(409);

    const title = `Retained owner Work ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `owner-${randomUUID()}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const manifest = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(created.workRevision)} rv:manifest ?manifest }
    }`)).results?.bindings[0]?.manifest?.value;
    if (!manifest) throw new Error('Work anchor manifest absent');
    const path = join(env.objectDirectory, manifest.slice(-64));
    const bytes = readFileSync(path);
    renameSync(path, `${path}.held`);
    const unavailable = await send('/v1/owners/reconciliations', reconcile(created.workRevision),
      `unavailable-${randomUUID()}`);
    expect((await unavailable.json() as { disposition: string }).disposition).toBe('unavailable');
    renameSync(`${path}.held`, path);
    writeFileSync(path, 'corrupt');
    const corrupt = await send('/v1/owners/reconciliations', reconcile(created.workRevision),
      `corrupt-${randomUUID()}`);
    expect((await corrupt.json() as { disposition: string }).disposition).toBe('corrupt');
    writeFileSync(path, bytes);
    const matched = await send('/v1/owners/reconciliations', reconcile(created.workRevision),
      `recovered-${randomUUID()}`);
    expect(matched.status).toBe(201);
    expect(await matched.json()).toMatchObject({ state: 'reconciled', disposition: 'matched' });
    const resumeKey = `resume-${randomUUID()}`;
    const resumeId = randomUUID();
    const resumeDigest = createHash('sha256').update(JSON.stringify({
      family: 'owner-revision-recovery-v1', revision: created.workRevision })).digest('hex');
    await relay.query(`INSERT INTO relay.owner_reconciliation
      (id, operation_id, request_digest, kind, scope)
      VALUES ($1,$2,$3,'revision_recovery',$4)`, [resumeId, `owner:reconcile:${resumeKey}`,
      resumeDigest, created.workRevision]);
    const resumed = await send('/v1/owners/reconciliations', reconcile(created.workRevision), resumeKey);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ id: resumeId,
      state: 'reconciled', disposition: 'matched', replayed: true });
    let releaseGraph!: () => void;
    let graphEntered!: () => void;
    const holdGraph = new Promise<void>(done => { releaseGraph = done; });
    const enteredGraph = new Promise<void>(done => { graphEntered = done; });
    const slowFuseki = new Proxy(fuseki, { get(target, property) {
      if (property === 'query') return async (query: string) => {
        graphEntered();
        await holdGraph;
        return target.query(query);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as FusekiClient;
    const slowOwner = new OwnerOperations(relay, { ...env, fuseki: slowFuseki });
    const concurrentKey = `concurrent-${randomUUID()}`;
    const pending = slowOwner.reconcileRevision({ revision: created.workRevision }, concurrentKey);
    await enteredGraph;
    try {
      await expect(ownerOperations.reconcileRevision({ revision: created.workRevision }, concurrentKey))
        .rejects.toThrow('owner operation is running');
      await expect(ownerOperations.reconcileRevision({ revision: created.workRevision },
        `another-${randomUUID()}`)).rejects.toThrow('revision reconciliation is running');
    } finally { releaseGraph(); }
    expect((await pending).state).toBe('reconciled');
    const row = (await relay.query<{ state: string; hold_reason: string | null; outcome_digest: string | null }>(
      'SELECT state, hold_reason, outcome_digest FROM relay.owner_reconciliation WHERE id = $1',
      [missing.id])).rows[0];
    expect(row).toMatchObject({ state: 'held', hold_reason: 'exact_revision_unavailable',
      outcome_digest: null });
    const planner = await relay.connect();
    try {
      await planner.query('BEGIN');
      await planner.query('SET LOCAL enable_seqscan = off');
      const plan = (await planner.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS)
        SELECT id FROM relay.owner_reconciliation WHERE operation_id = $1`,
      [`owner:reconcile:${key}`])).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('owner_reconciliation_operation_id_key');
      expect(plan).toMatch(/rows=1(?:\.00)? loops=1/);
      await planner.query('ROLLBACK');
    } finally { planner.release(); }
    const relocation = { profile: 'owner-relocation-v1', action: 'stage', owner: 'graph',
      datasetId: `api-${randomUUID()}`, sourceLocation: 'host-a/state',
      targetLocation: 'host-b/state', sourceRoutingEpoch: '1' };
    expect((await send('/v1/owners/relocations', relocation)).status).toBe(400);
    const moveKey = `move-${randomUUID()}`;
    const moved = await send('/v1/owners/relocations', relocation, moveKey);
    expect(moved.status).toBe(201);
    const stage = await moved.json() as { id: string; state: string; replayed: boolean };
    expect(stage).toMatchObject({ state: 'staged', replayed: false });
    expect((await get(`/v1/owners/relocations/${stage.id}`)).status).toBe(200);
    expect((await send('/v1/owners/relocations', relocation, moveKey)).status).toBe(200);
    expect((await send('/v1/owners/relocations', { ...relocation, action: 'activate' },
      `forged-${randomUUID()}`)).status).toBe(400);
    expect((await send('/v1/owners/relocations', { ...relocation,
      targetLocation: 'host-c/state' }, moveKey)).status).toBe(409);
  } finally {
    await relay.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test('MODEL07: relocation staging is idempotent, exclusive and cannot activate from caller evidence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const ownerOperations = new OwnerOperations(relay, { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: resolve('.temp', `owner-unused-${randomUUID()}`) });
  try {
    const input = { owner: 'graph' as const, datasetId: `test-${randomUUID()}`,
      sourceLocation: 'host-a/state', targetLocation: 'host-b/state', sourceRoutingEpoch: '1' };
    const key = `stage-${randomUUID()}`;
    const first = await ownerOperations.stageRelocation(input, key);
    expect(first).toMatchObject({ owner: 'graph', state: 'staged', replayed: false });
    expect(await ownerOperations.stageRelocation(input, key)).toMatchObject({ id: first.id,
      state: 'staged', replayed: true });
    await expect(ownerOperations.stageRelocation({ ...input, targetLocation: 'host-c/state' }, key))
      .rejects.toThrow('idempotency key binds another move');
    await expect(ownerOperations.stageRelocation(input, `competing-${randomUUID()}`))
      .rejects.toThrow('already has an active relocation');
    await expect(ownerOperations.stageRelocation({ ...input, targetLocation: input.sourceLocation },
      `invalid-${randomUUID()}`)).rejects.toThrow('source and target locations must differ');
    expect(await ownerOperations.readRelocation(first.id)).toMatchObject({ id: first.id, state: 'staged' });
    const row = (await relay.query<{ activated_at: Date | null; target_routing_epoch: string | null }>(
      'SELECT activated_at, target_routing_epoch FROM relay.owner_relocation WHERE id = $1',
      [first.id])).rows[0];
    expect(row).toEqual({ activated_at: null, target_routing_epoch: null });
  } finally { await relay.end(); }
}, 120_000);
