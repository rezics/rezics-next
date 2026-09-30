import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { activateMetadataWork, metadataWorkRequestDigest, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import type { OwnerCloudEvent } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { compositionRoutes } from '../../../services/main/src/routes/compositions.ts';
import { ratingAccount } from '../support/rating-account.ts';

interface Composition {
  structure: string;
  revision: string;
  receipt: string;
  sourcePosition: { sequence: string };
}

test('G-825: Book and Work composition commands reach durable terminal receipts without stalling', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  const account = await ratingAccount(Bun.env as Record<string, string>, 'openid work:edit work:read');
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 2 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL!),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: resolve('.temp', `g-825-${randomUUID()}`) };
  const actor = `https://rezics.com/id/${randomUUID()}`, principalId = randomUUID();
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    await accessPool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [principalId, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
    await accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), principalId, actor]);
    const app = new Elysia().use(compositionRoutes(env.fuseki, { environment: env,
      account: account.verifier, access: new AccessAdmissionRegistry(accessPool), structureObjects: objects }));
    const call = async (path: string, body: object, status: number) => {
      const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${account.tokenA}`, 'idempotency-key': randomUUID(),
          'content-type': 'application/json' }, body: JSON.stringify({ ...body, actingSubject: actor }) }));
      const result = await response.json();
      if (response.status !== status) throw new Error(`composition response ${response.status}: ${JSON.stringify(result)}`);
      return result as Composition;
    };
    const consumer = `g-825:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    const commands: Composition[] = [];
    for (const profile of ['book-composition', 'work-composition']) {
      const title = `Relay ${profile}`, semanticTypes = ['https://schema.org/Book'];
      const work = await activateMetadataWork(env, { title, semanticTypes, language: 'en',
        admission: { id: randomUUID(), action: 'work.create', scope: 'work:create:root',
          idempotencyKey: randomUUID(), authorityEpoch: '0', actingSubject: actor,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requestDigest: metadataWorkRequestDigest(title, semanticTypes, 'en') } });
      const scope = `work:edit:${work.work}`;
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), actor, scope]);
      const created = await call('/v1/compositions', {
        profile, work: work.work, mainVersion: work.mainVersion }, 201);
      const changed = await call(`/v1/compositions/${created.structure.split('/').at(-1)}/changes`, {
        profile, expectedHead: created.revision,
        operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'group' }],
      }, 200);
      commands.push(created, changed);
    }
    const finalSequence = commands.at(-1)!.sourcePosition.sequence;
    let last = '0';
    for (let index = 0; index < 20 && BigInt(last) < BigInt(finalSequence); index++) {
      const batch = await relayMainOutboxOnce(env.fuseki, relay, consumer);
      expect(batch).not.toBeNull();
      last = batch!.sequence;
    }
    expect(last).toBe(finalSequence);
    expect(await relayMainOutboxOnce(env.fuseki, relay, consumer)).toBeNull();
    for (const [index, command] of commands.entries()) {
      const delivered = await relay.query<{ envelope: OwnerCloudEvent }>(
        'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
        [env.lineage.dataEpoch, command.sourcePosition.sequence]);
      expect(delivered.rows).toHaveLength(1);
      expect(delivered.rows[0]!.envelope).toMatchObject({ type: 'com.rezics.structure.command.v1',
        data: { sourcePosition: { sequence: command.sourcePosition.sequence }, receipt: {
          id: command.receipt, action: 'structure.command',
          commandAction: index % 2 === 0 ? 'composition.create' : 'composition.change',
          outcome: 'succeeded', structure: command.structure, revision: command.revision } } });
    }
    expect((await relay.query<{ sequence: string }>(
      'SELECT sequence FROM relay.checkpoint WHERE consumer = $1', [consumer])).rows[0]!.sequence)
      .toBe(finalSequence);
  } finally { await Promise.allSettled([relay.end(), accessPool.end(), account.close()]); }
}, 180_000);
