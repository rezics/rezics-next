import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { GRAPHS, RV } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { graphErasureReceipt } from '../src/modules/erasure/graph.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage, assertZoneHomeContentReferences,
  ContentRecoveryConflict,
  type ContentRecoveryCoverage, type ContentRecoveryProofContext, type GraphContentReference } from '../src/modules/work/content-recovery-coverage.ts';

const revisionId = '2d31cde1-6f5d-4f0f-8f6b-6901446c42d3';
const otherRevision = '3d31cde1-6f5d-4f0f-8f6b-6901446c42d3';
const epoch = '4d31cde1-6f5d-4f0f-8f6b-6901446c42d3';
const erasureId = '5d31cde1-6f5d-4f0f-8f6b-6901446c42d3';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Owner and graph adapters exercise the full proof readers without a stack.
 * Unknown reads fail: suppressed receipt/projection digest rows cannot repair a pin. */
function retainedCut() {
  const bytes = Buffer.from('{"body":"retained before erasure"}');
  const state = { erased: false, byteDigest: hash(bytes), journal: true,
    journalRevision: revisionId, tombstone: true, allocator: true, suppressed: true,
    sourceRows: 1, proofRows: 1, transaction: 'read committed', supersession: true, originalReceipt: true };
  const reference: GraphContentReference = { graph: GRAPHS.revisions,
    subject: 'urn:rezics:revision:historical', predicate: `${RV}contentRevision`,
    object: `urn:rezics:content:revision:${revisionId}`, byteDigest: state.byteDigest,
    preparationId: 'publication-retained', ownerEpoch: epoch, ownerSequence: '1' };
  const revisionRow = () => ({ id: revisionId, byte_digest: state.byteDigest,
    availability: state.erased ? 'erased' : 'available', serialized_bytes: state.erased ? null : bytes,
    byte_length: bytes.length, body: state.erased ? null : JSON.parse(bytes.toString()) });
  const contentClient = { query: async (sql: string, params: unknown[] = []) => {
    let rows: unknown[];
    if (sql === 'SHOW transaction_isolation') rows = [{ transaction_isolation: 'repeatable read' }];
    else if (sql.includes('txid_current()')) rows = [{ id: '11' }];
    else if (sql.includes("set_config('TimeZone'")) rows = [];
    else if (sql.includes('FROM content.owner_control')) rows = [{ data_epoch: epoch, sequence: '1' }];
    else if (sql.includes('sequence IS NULL')) rows = [];
    else if (sql.includes('FROM pg_class')) rows = [{ schema: 'content', table: 'revision',
      persistence: 'p', comment: null, key: ['id'], key_types: ['uuid'], columns: ['id uuid', 'byte_digest text'] }];
    else if (sql.includes('FROM content.revision WHERE id = $1')) rows = params[0] === revisionId
      ? Array.from({ length: state.sourceRows }, revisionRow) : [];
    else if (sql.includes('FROM content.revision_erasure WHERE revision_id')) rows = state.tombstone
      ? [{ erasure_id: erasureId, erasure_epoch: '1' }] : [];
    else if (sql.includes('AS wanted(id)') && sql.includes('r.availability,')) rows = [{ id: revisionId,
      availability: state.erased ? 'erased' : 'available', payload_absent: state.erased,
      erasure_id: erasureId, erasure_epoch: '1' }];
    else if (sql.includes('AS mismatch')) rows = [{ mismatch: !state.erased }];
    else if (sql.includes('SELECT s.operation_id')) rows = state.supersession
      && (params[3] === null || params[3] === 'publication-retained') ? [{ operation_id: 'publication-retained' }] : [];
    else if (sql.includes('JOIN content.receipt')) rows = params[0] === 'publication-retained' && params[1] === revisionId
      ? [{ revision_id: revisionId, data_epoch: epoch, sequence: '1', outbox_id: 'retained-outbox' }] : [];
    else if (sql.includes('to_jsonb(t)::text')) {
      const row = revisionRow();
      rows = [{ k0: revisionId, body: JSON.stringify({ ...row,
        serialized_bytes: row.serialized_bytes ? `\\x${row.serialized_bytes.toString('hex')}` : null }) }];
    } else throw new Error(`unexpected Content query: ${sql}`);
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;

  const receipt = graphErasureReceipt(erasureId);
  const source = 'https://rezics.com/services/main';
  const eventId = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const batchId = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const requestDigest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch: '1',
    targets: [`urn:rezics:content:revision:${revisionId}`] }));
  const relayClient = { query: async (sql: string) => {
    let rows: unknown[];
    if (sql === 'SHOW transaction_isolation') rows = [{ transaction_isolation: state.transaction }];
    else if (sql.includes('txid_current()')) rows = [{ id: '12' }];
    else if (sql.includes('FROM pg_locks')) rows = [{ held: state.allocator }];
    else if (sql.includes('FROM relay.erasure WHERE id')) rows = state.journal ? [{ id: erasureId,
      erasure_epoch: '1', kind: 'revision', suppression_status: 'suppressed', requested_at: new Date(0),
      suppressed_at: null, verified_at: null }] : [];
    else if (sql.includes('FROM relay.erasure_target')) rows = [{ ordinal: 0, owner: 'content',
      target_kind: 'content_revision', target_ref: state.journalRevision, completed_at: null }];
    else if (sql.includes('FROM relay.erasure_disposition')) rows = [];
    else if (sql.includes('FROM relay.delivered_event AS event')) rows = Array.from({ length: state.proofRows }, () => ({
      stream_scope: MAIN_RELAY_STREAM_SCOPE, source, event_id: eventId, data_epoch: epoch, sequence: '2',
      batch_id: batchId, routing_epoch: epoch, event_count: 1, batch_scope: MAIN_RELAY_STREAM_SCOPE,
      batch_epoch: epoch, batch_sequence: '2', actual_count: '1',
      envelope: { specversion: '1.0', id: eventId, source, type: 'com.rezics.erasure.graph-suppressed.v1',
        datacontenttype: 'application/json', data: { batchId, routingEpoch: epoch, ordinal: 0,
          sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence: '2' },
          relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: epoch, sequence: '2' },
          receipt: { id: receipt, action: 'erasure.graph', outcome: 'succeeded', requestDigest,
            systemProof: { kind: 'relay-erasure', erasureId, erasureEpoch: '1' } } } },
    }));
    else throw new Error(`unexpected relay query: ${sql}`);
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;

  const graphQueries: string[] = [];
  const homeSelections: Record<string, { type: string; value: string }>[] = [];
  const fuseki = { query: async (sql: string) => {
    graphQueries.push(sql);
    const binding = (value: string) => ({ type: 'uri', value });
    if (sql.includes('SELECT ?graph WHERE')) return { results: { bindings: [{ graph: binding(reference.graph) }] } };
    if (sql.includes('SELECT ?home ?resource')) return { results: { bindings: homeSelections } };
    if (sql.includes('SELECT ?graph ?subject')) return { results: { bindings: [{
      graph: binding(reference.graph), subject: binding(reference.subject), predicate: binding(reference.predicate),
      object: binding(reference.object), ...(reference.byteDigest ? { digest: binding(reference.byteDigest) } : {}),
      ...(reference.preparationId ? { preparation: binding(reference.preparationId) } : {}),
      ...(reference.ownerEpoch ? { epoch: binding(reference.ownerEpoch) } : {}),
      ...(reference.ownerSequence ? { sequence: binding(reference.ownerSequence) } : {}),
    }] } };
    if (sql.includes('SELECT DISTINCT ?target')) return { results: { bindings: state.suppressed
      ? [{ target: binding(`urn:rezics:content:revision:${revisionId}`) }] : [] } };
    if (sql.includes('ASK')) return { boolean: state.originalReceipt };
    throw new Error(`suppressed graph digest is unavailable: ${sql}`);
  } } as unknown as FusekiClient;
  const pool = { connect: async () => { throw new Error('borrow the snapshot'); } } as unknown as Pool;
  const proof: ContentRecoveryProofContext = { fuseki, relayClient, contentClient };
  const capture = async () => {
    const coverage = await captureContentRecoveryCoverage(pool, [reference], proof);
    const key = 'c'.repeat(64);
    return openRecoveryPayload<ContentRecoveryCoverage>(
      JSON.stringify(sealRecoveryPayload(coverage, key, 'graph-recovery-coverage')), key, 'graph-recovery-coverage');
  };
  const erase = () => { state.erased = true; };
  return { state, reference, pool, fuseki, proof, capture, erase, graphQueries, homeSelections };
}

test('Content erased publication pins refuse missing retained digests during capture and restore', async () => {
  for (const graph of [GRAPHS.receipts, GRAPHS.revisions]) {
    const cut = retainedCut();
    cut.state.erased = true;
    cut.reference.graph = graph;
    const valid = await cut.capture();
    cut.reference.byteDigest = null;
    // Even graph coverage signed around the corrupt tuple cannot reconstruct
    // the publication digest from the native owner row during restore.
    const corrupt = { ...valid, graphReferencesDigest: hash(JSON.stringify([cut.reference])) };
    const outcomes = await Promise.allSettled([cut.capture(),
      assertContentRecoveryCoverage(cut.pool, cut.fuseki, corrupt, cut.proof)]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(ContentRecoveryConflict);
    }
  }
});

test('Content capture after erasure preserves publication digests and accepts native outbox nulls', async () => {
  const cut = retainedCut();
  const c0 = await cut.capture();
  cut.erase();
  const c1 = await cut.capture();
  expect(c1.tables['content.revision']).not.toEqual(c0.tables['content.revision']);
  expect(c1.graphReferencesDigest).toBe(c0.graphReferencesDigest);
  expect(cut.reference.byteDigest).toBe(cut.state.byteDigest);
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).resolves.toBeUndefined();
  expect(cut.graphQueries.every(sql => !sql.includes('SELECT DISTINCT ?digest'))).toBe(true);
  cut.reference.graph = GRAPHS.outbox;
  cut.reference.byteDigest = null;
  // A legitimate native outbox null remains accepted even with a retained
  // preparation and owner position attached to qualify same-revision history.
  const native = await cut.capture();
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, native, cut.proof)).resolves.toBeUndefined();
  cut.reference.preparationId = null;
  cut.reference.ownerEpoch = null;
  cut.reference.ownerSequence = null;
  const sparse = await cut.capture();
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, sparse, cut.proof)).resolves.toBeUndefined();
  // Projection and selection writers also retain unprepared references without
  // a digest outside the native outbox graph.
  cut.reference.graph = GRAPHS.revisions;
  const selection = await cut.capture();
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, selection, cut.proof)).resolves.toBeUndefined();
});

test('Content restore refuses forged graph pins and retained owner digests against signed cuts', async () => {
  const cut = retainedCut();
  const c0 = await cut.capture();
  cut.reference.byteDigest = 'a'.repeat(64);
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c0, cut.proof)).rejects.toThrow('graph Content references differ');
  cut.erase();
  cut.reference.graph = GRAPHS.outbox;
  cut.reference.byteDigest = null;
  const c1 = await cut.capture();
  cut.state.byteDigest = 'b'.repeat(64);
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).rejects.toThrow('Content owner differs');
  cut.reference.byteDigest = 'a'.repeat(64);
  await expect(cut.capture()).rejects.toThrow('exact Content revision is unavailable');
  cut.reference.object = `urn:rezics:content:revision:${otherRevision}`;
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).rejects.toThrow('graph Content references differ');
  await expect(cut.capture()).rejects.toThrow('exact Content revision is unavailable');
});

test('Content restore still requires journal, tombstone, allocator and actual suppression', async () => {
  for (const fault of ['journal', 'tombstone', 'allocator', 'suppressed', 'supersession', 'originalReceipt'] as const) {
    const cut = retainedCut();
    cut.erase();
    const c1 = await cut.capture();
    cut.state[fault] = false;
    await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).rejects.toThrow();
  }
  const cut = retainedCut();
  cut.erase();
  const c1 = await cut.capture();
  cut.state.journalRevision = otherRevision;
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).rejects.toThrow('retained Content erasure journal differs');
  cut.state.journalRevision = revisionId;
  cut.reference.preparationId = 'foreign-publication';
  await expect(cut.capture()).rejects.toThrow('publication erasure supersession differs');
  cut.reference.preparationId = 'publication-retained';
  cut.state.transaction = 'repeatable read';
  await expect(cut.capture()).rejects.toThrow('active read committed transaction');
  await expect(captureContentRecoveryCoverage(cut.pool, [cut.reference], { fuseki: cut.fuseki,
    contentClient: cut.proof.contentClient } as ContentRecoveryProofContext)).rejects.toThrow('retained erasure proof context');
});

test('Content erased-pin source fails closed when missing, ambiguous, malformed or not erased', async () => {
  for (const count of [0, 2]) {
    const cut = retainedCut();
    cut.erase();
    cut.state.sourceRows = count;
    await expect(cut.capture()).rejects.toThrow('exact Content revision is unavailable');
  }
  for (const count of [0, 2]) {
    const cut = retainedCut();
    cut.erase();
    cut.state.proofRows = count;
    await expect(cut.capture()).rejects.toThrow('retained Content erasure proof is unavailable');
  }
  const cut = retainedCut();
  cut.erase();
  const c1 = await cut.capture();
  cut.state.byteDigest = '';
  await expect(cut.capture()).rejects.toThrow('exact Content revision is unavailable');
  cut.state.byteDigest = hash(Buffer.from('{"body":"retained before erasure"}'));
  cut.state.erased = false;
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, c1, cut.proof)).rejects.toThrow('Content owner differs');
});

test('home anchors recover through exact retained binding pins; removing or tampering a selection is refused', async () => {
  const cell = (value: string) => ({ value });
  const native = (last: string) => `https://rezics.com/id/00000000-0000-4000-8000-0000000000${last}`;
  const values = { home: native('01'), resource: native('02'), count: '2',
    binding: 'urn:rezics:zone-published-page:first', page: native('02'),
    variant: 'urn:rezics:variant:00000000-0000-4000-8000-000000000003',
    contentRevision: `urn:rezics:content:revision:${revisionId}`, digest: 'a'.repeat(64),
    publication: native('04'), publicationResource: native('02') };
  const row = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cell(value)]));
  const selection = [row(values), row({ ...values, binding: 'urn:rezics:zone-published-page:second',
    variant: 'urn:rezics:variant:00000000-0000-4000-8000-000000000005',
    contentRevision: `urn:rezics:content:revision:${otherRevision}`, digest: 'b'.repeat(64) })];
  const scan = (rows: typeof selection) => assertZoneHomeContentReferences({
    query: async () => ({ results: { bindings: rows } }),
  } as unknown as FusekiClient);
  await scan(selection);
  await expect(scan(selection.slice(0, 1))).rejects.toThrow('selection is incomplete');
  await expect(scan([selection[0]!, selection[0]!])).rejects.toThrow('selection is ambiguous');
  for (const field of ['resource', 'publication', 'digest', 'variant', 'contentRevision', 'publicationResource']) {
    const tampered = structuredClone(selection);
    delete tampered[0]![field];
    await expect(scan(tampered)).rejects.toThrow('reference shape differs');
  }
  await expect(scan([row({ ...values, count: '1', page: native('06') })]))
    .rejects.toThrow('reference shape differs');
  // Exact Content pin coverage independently rejects a well-formed but wrong
  // retained digest; anchor linking cannot substitute for the owner's bytes.
  const cut = retainedCut();
  cut.reference.byteDigest = 'f'.repeat(64);
  await expect(cut.capture()).rejects.toThrow();
});

test('production recovery inventory refuses a missing home binding even when its Content pin is retained', async () => {
  const cut = retainedCut();
  const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const fields = { home: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', resource,
    count: '1', binding: cut.reference.subject, page: resource,
    variant: 'urn:rezics:variant:00000000-0000-4000-8000-000000000003',
    contentRevision: cut.reference.object, digest: cut.state.byteDigest,
    publication: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004', publicationResource: resource };
  cut.homeSelections.push(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { type: 'uri', value }])));
  const coverage = await cut.capture();
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, coverage, cut.proof)).resolves.toBeUndefined();
  delete cut.homeSelections[0]!.binding;
  await expect(assertContentRecoveryCoverage(cut.pool, cut.fuseki, coverage, cut.proof))
    .rejects.toThrow('reference shape differs');
  expect(cut.reference.byteDigest).toBe(cut.state.byteDigest);
});
