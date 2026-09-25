import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateMetadataWork, GRAPHS, ID, RV, iri, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint, readNextMainOutboxBatch, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK04: admitted exact Work derivations retain kind, source and target revisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `work-derivation-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const actor = ID + randomUUID();
  const principal = { issuer: 'https://qa-derivation.test', subject: randomUUID() };
  const principalId = randomUUID();
  const admission = (requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: `work04-create-${id}`, requestDigest,
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  try {
    const sharedTitle = `Shared title ${randomUUID()}`;
    const works = await Promise.all(['source', 'adaptation', 'recording', 'fork'].map((label, index) => {
      const title = index < 2 ? sharedTitle : `${label} ${randomUUID()}`;
      return activateMetadataWork(env, { title, admission: admission(metadataWorkRequestDigest(title)) });
    }));
    const [source, ...targets] = works;
    if (!source || targets.length !== 3) throw new Error('Work activation incomplete');
    expect(new Set(works.map(item => item.work)).size).toBe(4);
    expect(new Set(works.map(item => item.mainVersion)).size).toBe(4);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const access = new AccessAdmissionRegistry(accessPool);
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access });
    const send = (body: object, key = randomUUID()) => app.handle(new Request(
      'http://main.local/v1/work-derivations', { method: 'POST', headers: {
        authorization: 'Bearer qa', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ profile: 'work-derivation-v1', ...body }) }));
    const read = (main: string, revision: string) => app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/work-derivations`));
    expect(await read(targets[0]!.mainVersion, targets[0]!.mainRevision).then(response => response.json()))
      .toMatchObject({ complete: true, derivations: [] });
    const bodies = targets.map((target, index) => ({ targetWork: target.work,
      targetMainVersion: target.mainVersion, expectedTargetHead: target.mainRevision,
      sourceWork: source.work, sourceMainVersion: source.mainVersion,
      sourceMainRevision: source.mainRevision,
      kind: (['adaptation', 'new-recording', 'software-fork'] as const)[index]!,
      evidence: `https://creator.example/continuity/${index + 1}`, actingSubject: actor }));
    for (const target of targets) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
        [`derivation:link:${target.work}`]);
    }
    const denied = await send(bodies[0]!);
    expect(denied.status).toBe(403);
    for (const target of targets) {
      const scope = `derivation:link:${target.work}`;
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'work.derive', now() + interval '1 hour')`,
      [randomUUID(), principalId, actor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'work.derive', now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
    }
    const badSource = await send({ ...bodies[0], sourceMainRevision: ID + randomUUID() });
    expect(badSource.status).toBe(404);
    const stale = await send({ ...bodies[0], expectedTargetHead: ID + randomUUID() });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_target_head');
    const receipts: Array<{ derivation: string; receipt: string;
      sourcePosition: { sequence: string }; kind: string }> = [];
    for (const body of bodies) {
      const key = `derive-${randomUUID()}`;
      const response = await send(body, key);
      expect(response.status).toBe(201);
      const result = await response.json() as {
        derivation: string; receipt: string; replayed: boolean;
        sourcePosition: { sequence: string }; kind: string;
      };
      receipts.push(result);
      expect(result).toMatchObject({ kind: body.kind, replayed: false });
      const replay = await send(body, key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ derivation: result.derivation,
        receipt: result.receipt, replayed: true });
      const inventory = await read(body.targetMainVersion, body.expectedTargetHead);
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({ complete: true, derivations: [{
        derivation: result.derivation, targetWork: body.targetWork,
        targetMainRevision: body.expectedTargetHead, sourceWork: source.work,
        sourceMainRevision: source.mainRevision, kind: body.kind, evidence: body.evidence }] });
      const bound = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(result.derivation)} a rv:WorkDerivation ;
            rv:sourceMainRevision ${iri(source.mainRevision)} ;
            rv:targetMainRevision ${iri(body.expectedTargetHead)} .
        }
      }`);
      expect(bound.boolean).toBe(true);
      expect((await send({ ...body, evidence: 'https://creator.example/different' }, key)).status).toBe(409);
      expect((await send(body)).status).toBe(409);
    }
    expect((await read(targets[0]!.mainVersion, ID + randomUUID())).status).toBe(404);
    expect((await read(source.mainVersion, source.mainRevision)).status).toBe(200);
    const last = receipts[2]!;
    const batch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
      (BigInt(last.sourcePosition.sequence) - 1n).toString());
    expect(batch?.eventIds).toHaveLength(1);
    const consumer = `work04:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    for (let sequence = 1n; sequence <= BigInt(last.sourcePosition.sequence); sequence++) {
      expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
        .toBe(sequence.toString());
    }
    const delivered = await relayPool.query<{ envelope: { type: string; data: {
      receipt: Record<string, unknown> } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE event_id = $1', [batch!.eventIds[0]]);
    expect(delivered.rows).toHaveLength(1);
    expect(delivered.rows[0]!.envelope).toMatchObject({ type: 'com.rezics.work.derived.v1',
      data: { receipt: { workDerivation: last.derivation, derivationKind: 'software-fork',
        sourceMainRevision: source.mainRevision, targetMainRevision: targets[2]!.mainRevision } } });
  } finally {
    await Promise.all([accessPool.end(), relayPool.end()]);
    rmSync(directory, { recursive: true, force: true });
  }
});
