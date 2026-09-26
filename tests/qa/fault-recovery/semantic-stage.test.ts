import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { ownerOutboxEventHandler } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';
import { SemanticStageStore } from '../../../services/main/src/modules/semantic/staging.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

test('MODEL21: lost Jena acknowledgement and interrupted Content settlement recover one admitted bulk receipt', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `semantic-stage-recovery-${randomUUID()}`));
  const nativeFuseki = f.env.fuseki;
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/stage/' });
  await objects.initialize();
  let loseJenaAck = true;
  f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
    if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
      const result = await target.commandWithReceipt(envelope);
      if (loseJenaAck && envelope.update.includes('SemanticBulkChangedEvent')) {
        loseJenaAck = false;
        throw new Error('lost bulk graph acknowledgement');
      }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as typeof nativeFuseki;
  let interruptSettlement = true;
  const faultPool = new Proxy(f.pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, member) {
        if (member === 'query') return async (...args: Parameters<typeof connection.query>) => {
          const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
          if (interruptSettlement && statement.includes('INSERT INTO semantic.change_stage_outcome')) {
            interruptSettlement = false;
            throw new Error('interrupted Content stage settlement');
          }
          return connection.query(...args);
        };
        const value = Reflect.get(connection, member, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, semanticStages: new SemanticStageStore(faultPool, objects) });
  const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${f.account.tokenA}`,
      'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    await f.grant('semantic:create:root', 'semantic.change.bulk');
    const key = `semantic-stage-recovery-${randomUUID()}`;
    const body = { profile: 'semantic-change-bulk-v1', actingSubject: f.actor, items: [
      { component: 'resource', types: ['https://schema.org/Person'], properties: [] },
      { component: 'resource', types: ['https://schema.org/Patient'], properties: [] },
    ] };
    const interrupted = await call('POST', '/v1/semantic/changes/bulk', body, key);
    expect(interrupted.status).toBe(503);
    expect(loseJenaAck).toBe(false);
    expect(interruptSettlement).toBe(false);
    const pending = await f.pool.query<{ id: string }>(`SELECT s.id FROM semantic.change_stage s
      JOIN semantic.change_stage_pending p ON p.stage_id = s.id WHERE s.idempotency_key = $1`, [key]);
    expect(pending.rowCount).toBe(1);
    const recoveredResponse = await call('POST', '/v1/semantic/changes/bulk', body, key);
    expect(recoveredResponse.status).toBe(200);
    const recovered = await recoveredResponse.json() as { stageId: string; receipt: string;
      sourcePosition: { sequence: string }; itemCount: number; items: object[]; replayed: boolean };
    expect(recovered).toMatchObject({ stageId: pending.rows[0]!.id, itemCount: 2, replayed: true });
    expect(recovered.receipt).toMatch(/^urn:rezics:receipt:[0-9a-f]{64}$/);
    const outcome = await f.pool.query<{ outcome: string; graph_receipt: string }>(
      'SELECT outcome, graph_receipt FROM semantic.change_stage_outcome WHERE stage_id = $1', [recovered.stageId]);
    expect(outcome.rows[0]).toEqual({ outcome: 'activated', graph_receipt: recovered.receipt });
    expect((await f.pool.query('SELECT 1 FROM semantic.change_stage_pending WHERE stage_id = $1',
      [recovered.stageId])).rowCount).toBe(0);

    const previous = (BigInt(recovered.sourcePosition.sequence) - 1n).toString();
    const batch = await readNextMainOutboxBatch(nativeFuseki, f.env.lineage.dataEpoch, previous);
    expect(batch?.eventIds).toHaveLength(1);
    const envelope = await readMainOutboxEnvelope(nativeFuseki, batch!, batch!.eventIds[0]!);
    expect(envelope).toMatchObject({ type: 'com.rezics.semantic.bulk-changed.v1',
      data: { receipt: { id: recovered.receipt, action: 'semantic.change.bulk',
        outcome: 'succeeded', items: [{ ordinal: 0 }, { ordinal: 1 }] } } });
    expect(await readNextMainOutboxBatch(nativeFuseki, f.env.lineage.dataEpoch, batch!.sequence)).toBeNull();
    const handler = ownerOutboxEventHandler('https://rezics.com/vocab/SemanticBulkChangedEvent');
    expect(handler?.action).toBe('semantic.change.bulk');
  } finally {
    f.env.fuseki = nativeFuseki;
    await f.close();
  }
}, 180_000);
