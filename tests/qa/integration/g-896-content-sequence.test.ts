import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { advanceContentSequence, settledContentPosition } from '../../../services/main/src/modules/content-sequence.ts';
import { planExport } from '../../../services/main/src/modules/export/planner.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { StaleSession } from '../../../services/main/src/modules/session/contract.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('G-896: export, cancellation and reading session positions remain contiguous through the real Content relay', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL) throw new Error('Use the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(runId, ['content']);
  const pool = new Pool({ connectionString: databases.urls.content, max: 4 });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const cursor = new ContentProjectionCursor(pool);
    const consumer = 'g-896-sequence';
    const initial = await cursor.initialize(consumer);
    const admission: RegisteredAdmission = { id: randomUUID(), principalId: randomUUID(),
      actingSubject: id(), scope: 'export:test', action: 'export.create', idempotencyKey: randomUUID(),
      requestDigest: sha('export'), authorityEpoch: '0', expiresAt: '2099-01-01T00:00:00Z',
      state: 'claimed', dispatchEligible: true, replayed: false };
    const plan = await planExport({ targetProfile: 'rezics-composition-v1', useScope: 'evaluation',
      members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'occurrence',
        exactRef: 'urn:occurrence:1', contentRevisionId: null, refDigest: sha('member'),
        ownerDataEpoch: 'graph-epoch', ownerSequence: '1', sourcePosition: 'chapter/1',
        targetGrain: 'Occurrence', mapping: 'exact', value: { kind: 'integer', lexical: '1' } }],
      residuals: [] }, async () => [{ basisKind: 'unprotected_fact', basisRef: null,
      licenseExpression: null, notice: null, obligations: [], useScope: 'evaluation',
      result: 'undetermined', memberOrdinals: [1] }]);
    const exports = new ExportStore(pool);
    const [sealed, concurrent] = await Promise.all([exports.seal(admission, plan), exports.seal(admission, plan)]);
    expect(concurrent.position).toEqual(sealed.position);
    expect([sealed.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    const refused = { ...admission, id: randomUUID(), idempotencyKey: randomUUID(), requestDigest: sha('refused') };
    const cancellations = await Promise.all([exports.cancel(refused), exports.cancel(refused)]);
    expect(cancellations[0]!.sequence).toBe(cancellations[1]!.sequence);

    const work = id();
    const target = { resource: work, work, base: 'work' as const, revision: id(),
      types: [], disclosure: 'public' as const };
    const sessions = new ConsumptionSessionStore(pool, new ReaderLibraryStatusStore(pool));
    const command = { principal: { issuer: 'https://g-896.test', subject: randomUUID() }, agent: id(),
      target: work, changes: { state: 'active' as const }, expectedVersion: 0, idempotencyKey: randomUUID() };
    const resolve = async () => [{ target, language: 'en', format: null, progress: 'locator' as const }];
    const session = await sessions.write(command, resolve);
    expect((await sessions.write(command, resolve)).replayed).toBe(true);
    await sessions.write({ ...command, id: session.id, target: undefined,
      changes: { state: 'paused' }, expectedVersion: session.version, idempotencyKey: randomUUID() },
    async () => []);
    const beforeStale = await content.ownerPosition();
    await expect(sessions.write({ ...command, id: session.id, target: undefined,
      changes: { state: 'finished' }, expectedVersion: session.version, idempotencyKey: randomUUID() },
    async () => [])).rejects.toBeInstanceOf(StaleSession);
    expect(await content.ownerPosition()).toEqual(beforeStale);

    const environment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
      lineage: { dataEpoch: 'unused-for-owner-events', routingEpoch: '1' }, objectDirectory: '.temp' };
    expect(await relayContentProjectionOnce(environment, content, cursor, consumer)).toEqual({
      sourceEpoch: sealed.position.dataEpoch, sourceSequence: sealed.position.sequence, disposition: 'ignored',
    });
    const events = await content.readOutbox(initial.dataEpoch, initial.sequence, 100);
    expect(events.map(event => event.position.sequence)).toEqual(['1', '2', '3', '4']);
    expect(events.map(event => event.eventType)).toEqual([
      'export.manifest.sealed', 'export.create.cancelled', 'session.created', 'session.updated',
    ]);
    for (const event of events.slice(1)) {
      expect(await relayContentProjectionOnce(environment, content, cursor, consumer)).toEqual({
        sourceEpoch: event.position.dataEpoch, sourceSequence: event.position.sequence, disposition: 'ignored',
      });
    }
    expect(await cursor.read(consumer)).toEqual(await content.ownerPosition());
    expect(await relayContentProjectionOnce(environment, content, cursor, consumer)).toBeNull();
  } finally {
    await pool.end();
    await databases.close();
  }
});

test('G-896: helper receipt and event commit together without a position, roll back together and are numbered after commit', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Use the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(runId, ['content']);
  const pool = new Pool({ connectionString: databases.urls.content, max: 4 });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const initial = await content.ownerPosition();
    const event = { operationId: 'g-896-helper', requestDigest: sha('helper'), action: 'export.create',
      outcome: 'succeeded' as const, eventType: 'export.manifest.sealed', recipe: 'export-v1', payload: {} };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await advanceContentSequence(client, event)).toEqual({ owner: 'content', operationId: event.operationId });
      // Writers take no position: the owner row stays unlocked for unrelated writers.
      expect((await client.query(`SELECT r.data_epoch, r.sequence, o.event_type FROM content.receipt r
        JOIN content.outbox o USING (operation_id) WHERE r.operation_id = $1`,
      [event.operationId])).rows).toEqual([{ data_epoch: null, sequence: null, event_type: event.eventType }]);
      // A second connection sees neither uncommitted row nor a new position.
      expect(await content.ownerPosition()).toEqual(initial);
      expect(await content.readOutbox(initial.dataEpoch, initial.sequence, 100)).toEqual([]);
      await client.query('ROLLBACK');
      expect(await content.ownerPosition()).toEqual(initial);
      expect((await pool.query('SELECT operation_id FROM content.receipt WHERE operation_id = $1',
        [event.operationId])).rows).toEqual([]);
      expect(await content.readOutbox(initial.dataEpoch, initial.sequence, 100)).toEqual([]);

      // The outbox object constraint fails after receipt insertion in the CTE.
      // Even an implicit transaction must roll back the receipt and sequence.
      await expect(advanceContentSequence(client, { ...event,
        payload: [] as unknown as Record<string, unknown> })).rejects.toMatchObject({ code: '23514' });
      expect(await content.ownerPosition()).toEqual(initial);
      expect((await pool.query('SELECT operation_id FROM content.receipt WHERE operation_id = $1',
        [event.operationId])).rows).toEqual([]);
      const committed = await settledContentPosition(pool, await advanceContentSequence(client, event));
      expect(committed).toEqual({ ...initial, sequence: (BigInt(initial.sequence) + 1n).toString() });
      expect((await content.readOutbox(initial.dataEpoch, initial.sequence, 100)).map(row => row.position))
        .toEqual([committed]);
      await expect(advanceContentSequence(client, event)).rejects.toMatchObject({ code: '23505' });
      expect(await content.ownerPosition()).toEqual(committed);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await pool.end();
    await databases.close();
  }
});
