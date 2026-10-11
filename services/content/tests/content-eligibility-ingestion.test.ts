import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentConflict, ContentCore, sequenceContentEvents,
  type EligibilityDeliveryPage, type EligibilityDeliveryProgress,
  type EligibilityDeliverySourceEvent } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaque(prefix: string): string { return `${prefix}:${randomUUID()}`; }

async function startFixture() {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 8 });
  await migrateContent(pool);
  return { pool, core: new ContentCore(pool), async stop() {
    try { await pool.end(); }
    finally { cluster.remove(); }
  } };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;
let sharedFixture: Fixture | undefined;

beforeAll(async () => { sharedFixture = await startFixture(); });
afterAll(async () => {
  if (!sharedFixture) return;
  await sharedFixture.stop();
  sharedFixture = undefined;
});

async function fixture(): Promise<Fixture> {
  if (!sharedFixture) throw new Error('eligibility delivery test fixture is not ready');
  // The suite owns one disposable cluster; individual cases share its isolated database.
  return { ...sharedFixture, stop: async () => undefined };
}

async function settledPin(core: ContentCore, outcome: 'active' | 'rejected' = 'active') {
  const resourceId = opaque('urn:rezics:work');
  const variantId = opaque('urn:rezics:variant');
  const variant = { id: variantId, resourceId,
    language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
  const saved = await core.saveDraft({ operationId: opaque('eligibility-draft'), variant,
    expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
    provenance: { source: 'integration-test' }, serializedJson: '{"body":"settled text"}' });
  if (!saved.revisionId) throw new Error('Content draft did not produce a revision');
  const exact = (await core.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('Content draft bytes are unavailable');
  const preparationId = opaque('eligibility-preparation');
  const preparation = await core.preparePublication(preparationId, saved.revisionId, exact.reference.byteDigest);
  const graphDataEpoch = randomUUID();
  await core.settlePublication(opaque('eligibility-settlement'), preparationId, {
    outcome, revisionId: saved.revisionId, receipt: opaque('urn:main:publication-receipt'),
    dataEpoch: graphDataEpoch, sequence: '31',
  }, preparation.position.dataEpoch);
  return { resourceId, variantId, revisionId: saved.revisionId, preparationId,
    graphDataEpoch, contentDataEpoch: preparation.position.dataEpoch };
}

function sourceEvent(pin: Awaited<ReturnType<typeof settledPin>>, changes: Partial<EligibilityDeliverySourceEvent> = {}) {
  const event: EligibilityDeliverySourceEvent = {
    id: opaque('urn:main:event'), type: 'com.rezics.content.search-eligible.v1', ordinal: 0,
    sourcePosition: { dataEpoch: pin.graphDataEpoch, sequence: '47' },
    receipt: { id: opaque('urn:main:receipt'), action: 'content.search-eligibility',
      outcome: 'succeeded', requestDigest: digest(opaque('main-request')),
      resource: pin.resourceId, variant: pin.variantId,
      publicationDecision: opaque('urn:main:publication-decision'),
      eligibilityDecision: opaque('urn:main:eligibility-decision'), disclosure: 'public' },
    publication: { preparationId: pin.preparationId, revisionId: pin.revisionId },
    ...changes,
  };
  return event;
}

function progress(pin: Awaited<ReturnType<typeof settledPin>>, sequence = '0', streamScope = 'main-content-relay'):
  EligibilityDeliveryProgress {
  return { streamScope, graphDataEpoch: pin.graphDataEpoch,
    contentDataEpoch: pin.contentDataEpoch, sequence };
}

function batch(sequence: string, events: EligibilityDeliverySourceEvent[], name = `batch-${sequence}`) {
  return { sequence, id: name, digest: digest(`retained:${name}`), events };
}

function page(expected: EligibilityDeliveryProgress, ...batches: EligibilityDeliveryPage['batches']): EligibilityDeliveryPage {
  return { expected, batches };
}

test('Content appends bounded eligibility batches once and advances only contiguous source progress', async () => {
  const { pool, core, stop } = await fixture();
  try {
    const pin = await settledPin(core);
    const expected = progress(pin);
    const event = sourceEvent(pin);
    const delivery = page(expected, batch('1', [event]), batch('2', [], 'batch-2'));
    const result = await core.ingestEligibilityDeliveryPage(delivery);
    expect(result.progress).toEqual({ ...expected, sequence: '2' });
    expect(result.replayed).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ sourceEventId: event.id,
      sourceReceiptId: event.receipt.id, appended: true });
    expect(result.events[0]?.position).toMatchObject({ owner: 'content', dataEpoch: pin.contentDataEpoch });

    const stored = await pool.query(`SELECT receipt.action, receipt.outcome, receipt.request_digest,
        receipt.variant_id, receipt.revision_id::text AS revision_id,
        outbox.event_type, outbox.recipe, outbox.payload,
        source.source_event_id, source.source_receipt_id, source.source_sequence,
        source.source_digest, source.publication_decision, source.eligibility_decision
      FROM content.eligibility_delivery_source source
      JOIN content.receipt receipt ON receipt.operation_id = source.operation_id
      JOIN content.outbox outbox ON outbox.operation_id = receipt.operation_id
      WHERE source.source_event_id = $1`, [event.id]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({ action: 'publication.eligibility-deliver', outcome: 'succeeded',
      variant_id: pin.variantId, revision_id: pin.revisionId,
      event_type: 'content.publication.eligibility-delivered', recipe: 'content-body-v1',
      source_event_id: event.id, source_receipt_id: event.receipt.id,
      source_sequence: '47', source_digest: event.receipt.requestDigest,
      publication_decision: event.receipt.publicationDecision,
      eligibility_decision: event.receipt.eligibilityDecision });
    expect(stored.rows[0]!.payload).toMatchObject({ kind: 'main-content-search-eligibility-delivery-v1',
      graphDataEpoch: pin.graphDataEpoch, contentDataEpoch: pin.contentDataEpoch,
      sourceEventId: event.id, sourcePosition: event.sourcePosition,
      sourceReceipt: event.receipt, publication: event.publication });
    expect((await pool.query(`SELECT sequence::text FROM content.eligibility_delivery_progress
      WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3`,
    [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch])).rows[0]?.sequence).toBe('2');
    expect((await pool.query(`SELECT sequence::text FROM content.eligibility_delivery_batch
      WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3 ORDER BY sequence`,
    [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch])).rows.map(row => row.sequence))
      .toEqual(['1', '2']);

    const replay = await core.ingestEligibilityDeliveryPage(delivery);
    expect(replay.replayed).toBe(true);
    expect(replay.events[0]).toMatchObject({ operationId: result.events[0]!.operationId,
      appended: false, position: result.events[0]!.position });
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.eligibility_delivery_source
      WHERE content_data_epoch = $1`, [pin.contentDataEpoch])).rows[0]?.count).toBe(1);

    const wrongReceiptDigest = { ...event, receipt: { ...event.receipt, requestDigest: digest('changed receipt') } };
    await expect(core.ingestEligibilityDeliveryPage(page(expected,
      batch('1', [wrongReceiptDigest]), batch('2', [], 'batch-2')))).rejects.toBeInstanceOf(ContentConflict);
    const wrongEligibility = { ...event, receipt: { ...event.receipt,
      eligibilityDecision: opaque('urn:main:other-eligibility') } };
    await expect(core.ingestEligibilityDeliveryPage(page(expected,
      batch('1', [wrongEligibility]), batch('2', [], 'batch-2')))).rejects.toBeInstanceOf(ContentConflict);
    await expect(core.ingestEligibilityDeliveryPage(page(expected,
      batch('3', [sourceEvent(pin)], 'skipped-batch')))).rejects.toBeInstanceOf(ContentConflict);

    const concurrentPin = await settledPin(core);
    const concurrentExpected = progress(concurrentPin);
    const concurrentEvent = sourceEvent(concurrentPin);
    const concurrentPage = page(concurrentExpected, batch('1', [concurrentEvent]));
    const competing = await Promise.all([
      core.ingestEligibilityDeliveryPage(concurrentPage),
      core.ingestEligibilityDeliveryPage(concurrentPage),
    ]);
    expect(competing.map(value => value.replayed).sort()).toEqual([false, true]);
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.eligibility_delivery_source
      WHERE content_data_epoch = $1 AND source_event_id = $2`,
    [concurrentPin.contentDataEpoch, concurrentEvent.id])).rows[0]?.count).toBe(1);
  } finally { await stop(); }
}, 60_000);

test('Content rejects foreign epochs, mismatched pins and failed settlement, and rolls back a failed progress advance', async () => {
  const { pool, core, stop } = await fixture();
  try {
    const pin = await settledPin(core);
    const expected = progress(pin);
    const event = sourceEvent(pin);
    const foreignGraph = { ...event, sourcePosition: { dataEpoch: randomUUID(), sequence: '47' } };
    await expect(core.ingestEligibilityDeliveryPage(page(expected, batch('1', [foreignGraph]))))
      .rejects.toBeInstanceOf(ContentConflict);
    const foreignContent = { ...expected, contentDataEpoch: randomUUID() };
    await expect(core.ingestEligibilityDeliveryPage(page(foreignContent, batch('1', [event]))))
      .rejects.toBeInstanceOf(ContentConflict);
    const wrongPin = { ...event, publication: { ...event.publication, revisionId: randomUUID() } };
    await expect(core.ingestEligibilityDeliveryPage(page(expected, batch('1', [wrongPin]))))
      .rejects.toBeInstanceOf(ContentConflict);
    expect(await core.readEligibilityDeliveryProgress(expected.streamScope, expected.graphDataEpoch))
      .toEqual(expected);

    const rejectedPin = await settledPin(core, 'rejected');
    const rejectedExpected = progress(rejectedPin);
    await expect(core.ingestEligibilityDeliveryPage(page(rejectedExpected,
      batch('1', [sourceEvent(rejectedPin)])))).rejects.toBeInstanceOf(ContentConflict);
    expect(await core.readEligibilityDeliveryProgress(rejectedExpected.streamScope, rejectedExpected.graphDataEpoch))
      .toEqual(rejectedExpected);

    const rollbackPin = await settledPin(core);
    const rollbackExpected = progress(rollbackPin);
    const rollbackEvent = sourceEvent(rollbackPin);
    const priorDeliveryReceipts = (await pool.query(`SELECT count(*)::int AS count FROM content.receipt
      WHERE action = 'publication.eligibility-deliver'`)).rows[0]?.count;
    await pool.query(`CREATE FUNCTION content.fail_eligibility_delivery_progress() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced progress failure'; END $$;
      CREATE TRIGGER fail_eligibility_delivery_progress BEFORE UPDATE
      ON content.eligibility_delivery_progress FOR EACH ROW
      EXECUTE FUNCTION content.fail_eligibility_delivery_progress()`);
    await expect(core.ingestEligibilityDeliveryPage(page(rollbackExpected,
      batch('1', [rollbackEvent])))).rejects.toThrow('forced progress failure');
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.eligibility_delivery_source
      WHERE source_event_id = $1`, [rollbackEvent.id])).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.eligibility_delivery_batch
      WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3`,
    [rollbackExpected.streamScope, rollbackExpected.graphDataEpoch, rollbackExpected.contentDataEpoch])).rows[0]?.count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.receipt
      WHERE action = 'publication.eligibility-deliver'`)).rows[0]?.count).toBe(priorDeliveryReceipts);
    expect(await core.readEligibilityDeliveryProgress(rollbackExpected.streamScope, rollbackExpected.graphDataEpoch))
      .toEqual(rollbackExpected);
    await pool.query(`DROP TRIGGER fail_eligibility_delivery_progress ON content.eligibility_delivery_progress;
      DROP FUNCTION content.fail_eligibility_delivery_progress()`);
  } finally { await stop(); }
}, 60_000);

test('Content resolves an erased settled pin from metadata and restart numbering recovers committed delivery', async () => {
  const { pool, core, stop } = await fixture();
  const blocker = await pool.connect();
  try {
    const erasedPin = await settledPin(core);
    await pool.query('BEGIN');
    const erasureId = randomUUID();
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [erasedPin.revisionId]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 1)`, [erasedPin.revisionId, erasureId]);
    await pool.query('COMMIT');
    expect((await core.readExactBatch([erasedPin.revisionId], async ids => new Set(ids)))[0]?.status).toBe('erased');
    const erasedExpected = progress(erasedPin);
    const erasedEvent = sourceEvent(erasedPin);
    const erasedResult = await core.ingestEligibilityDeliveryPage(page(erasedExpected,
      batch('1', [erasedEvent])));
    expect(erasedResult.progress.sequence).toBe('1');
    expect(erasedResult.events[0]?.appended).toBe(true);
    expect(erasedResult.events[0]?.position).not.toBeNull();

    const pin = await settledPin(core);
    const expected = progress(pin, '0', 'main-content-relay-restart');
    const event = sourceEvent(pin);
    const delivery = page(expected, batch('1', [event]));
    await blocker.query('BEGIN');
    await blocker.query('SELECT singleton FROM content.owner_control WHERE singleton FOR SHARE');
    const committed = await core.ingestEligibilityDeliveryPage(delivery);
    expect(committed.progress.sequence).toBe('1');
    expect(committed.events[0]?.position).toBeNull();
    expect((await pool.query(`SELECT sequence FROM content.receipt WHERE operation_id = $1`,
      [committed.events[0]!.operationId])).rows[0]?.sequence).toBeNull();
    await blocker.query('COMMIT');

    expect(await sequenceContentEvents(pool)).toBeGreaterThan(0);
    const retry = await core.ingestEligibilityDeliveryPage(delivery);
    expect(retry.replayed).toBe(true);
    expect(retry.events[0]?.position).toMatchObject({ owner: 'content', dataEpoch: pin.contentDataEpoch });
    expect((await pool.query(`SELECT count(*)::int AS count FROM content.eligibility_delivery_source
      WHERE source_event_id = $1`, [event.id])).rows[0]?.count).toBe(1);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await stop();
  }
}, 60_000);
