import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { CommandOutcomeUnknown, CommandRejected, type CommandEnvelope, type CommandResult,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { hash, prepareWorkComponent } from '../src/modules/work/activate.ts';
import { ReceiptCustody, type CustodyRow, type ReceiptCustodySession, type ReceiptCustodyStore,
  type SlimEnvelope } from '../src/modules/outbox/receipt-custody.ts';
import type { ProofRetirement } from '../src/modules/graph/slim-command.ts';
import type { MetadataEditionState } from '../src/modules/work/metadata-schema.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

class MemoryCustody implements ReceiptCustodyStore {
  row: CustodyRow | null = null;
  failPrepare = false;
  failReconcile = false;
  indexedReceipt?: string;
  private tail: Promise<unknown> = Promise.resolve();
  receiptAt(dataEpoch: string, streamSequence: string): Promise<string | null> {
    return Promise.resolve(this.indexedReceipt ?? (this.row?.terminal?.dataEpoch === dataEpoch
      && this.row.terminal.streamSequence === streamSequence ? this.row.receipt : null));
  }
  withReceipt<T>(receipt: string, operation: (session: ReceiptCustodySession) => Promise<T>): Promise<T> {
    const next = this.tail.then(() => operation({
      read: () => Promise.resolve(this.row?.receipt === receipt ? this.row : null),
      prepare: row => {
        if (this.failPrepare) throw new Error('owner unavailable');
        this.row = row; return Promise.resolve();
      },
      reconcile: (terminal, outbox) => {
        if (this.failReconcile) throw new Error('reconciliation response lost');
        this.row = { ...this.row!, terminal, outbox, reconciled: true }; return Promise.resolve();
      },
      retire: () => { this.row = { ...this.row!, retired: true }; return Promise.resolve(); },
    }));
    this.tail = next.catch(() => {});
    return next;
  }
}
class MemoryObjects implements ImmutableObjects {
  bytes = new Map<string, Uint8Array>();
  failPut = false;
  put(bytes: Uint8Array): Promise<string> {
    if (this.failPut) throw new ObjectUnavailable('object storage unavailable');
    const digest = hash(bytes); this.bytes.set(digest, bytes); return Promise.resolve(digest);
  }
  get(digest: string): Promise<Uint8Array> {
    const bytes = this.bytes.get(digest);
    if (!bytes) throw new ObjectUnavailable('exact object missing');
    return Promise.resolve(bytes);
  }
}
async function fixture() {
  const component = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000005';
  const receipt = `urn:rezics:receipt:${hash('slim edition')}`, digest = hash('edition intent');
  const store = new MemoryCustody(), objects = new MemoryObjects();
  const state: MetadataEditionState = { kind: 'edition', id: component, status: 'active',
    title: { value: 'Measured edition', language: 'en' }, contentLanguage: 'en',
    editionStatement: 'First edition', publisher: 'Fixture Press', publicationYear: 2026,
    isbn13: '9780306406157' };
  const manifest = await prepareWorkComponent(objects, component, { revision, intent: { work,
    expectedHead: null, state } },
  'https://rezics.com/definition/work-metadata-details-v1');
  let proof: { digest: string; payloadSha256: string; dataEpoch: string; sequence: string; streamSequence: string } | null = null;
  let sends = 0, loseResponse = false, refusal: CommandResult | undefined;
  const queries: string[] = [];
  const retirements: ProofRetirement[] = [];
  const key = 'a'.repeat(64);
  const custody = new ReceiptCustody(store, objects, { query: (query): Promise<SparqlResult> => {
    queries.push(query);
    if (query.includes('SELECT ?receipt')) {
      const matches = proof && query.includes(JSON.stringify(proof.dataEpoch))
        && query.includes(`rv:streamSequence ${proof.streamSequence}`);
      return Promise.resolve({ results: { bindings: matches ? [{ receipt: { type: 'uri', value: receipt } }] : [] } });
    }
    return Promise.resolve({ results: { bindings: proof ? [{ digest: { type: 'literal', value: proof.digest },
      payload: { type: 'literal', value: proof.payloadSha256 }, epoch: { type: 'literal', value: proof.dataEpoch },
      sequence: { type: 'literal', value: proof.sequence },
      streamSequence: { type: 'literal', value: proof.streamSequence } }] : [] } });
  } }, key, retirement => { retirements.push(retirement); proof = null; return Promise.resolve(); });
  const envelope: CommandEnvelope = { receipt, digest, update: 'bounded edition update', validations: [], deadlineMs: 10_000 };
  const input = { envelope, component, revision, manifest, routingEpoch: 'routing-a', state,
    receipt: { outcome: 'succeeded' as const,
    receipt, admissionId: '00000000-0000-4000-8000-000000000006', requestDigest: digest,
    authorityEpoch: '1', scope: `work:edit:${work}`, dataEpoch: 'epoch-a', work, component, revision },
  dispatch: (candidate: CommandEnvelope): Promise<CommandResult> => {
    sends++;
    expect(store.row?.terminal).toBeNull();
    expect(store.row?.payloadSha256).toBe((candidate as SlimEnvelope).slim.payloadSha256);
    expect(objects.bytes.has(store.row!.payloadSha256)).toBe(true);
    if (refusal) return Promise.resolve(refusal);
    proof = { digest: candidate.digest, payloadSha256: (candidate as SlimEnvelope).slim.payloadSha256,
      dataEpoch: 'epoch-a', sequence: '17', streamSequence: '4' };
    if (loseResponse) throw new CommandOutcomeUnknown('response lost after graph commit');
    return Promise.resolve({ status: 'committed', position: {
      datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '17' } });
  } };
  return { custody, store, objects, input, retirements, key, queries, sends: () => sends,
    loseResponse: () => { loseResponse = true; }, refuse: (result: CommandResult) => { refusal = result; },
    setProof: (value: typeof proof) => { proof = value; } };
}

test('owner preparation and exact component custody precede graph dispatch; failed custody dispatches nothing', async () => {
  const f = await fixture();
  f.objects.failPut = true;
  await expect(f.custody.commit(f.input)).rejects.toBeInstanceOf(ObjectUnavailable);
  expect(f.sends()).toBe(0); expect(f.store.row?.terminal).toBeNull();
  f.objects.failPut = false;
  expect((await f.custody.commit(f.input)).status).toBe('committed');
  expect(f.store.row?.outbox?.eventCount).toBe(1);
  const unavailable = await fixture(); unavailable.store.failPrepare = true;
  await expect(unavailable.custody.commit(unavailable.input)).rejects.toThrow('owner unavailable');
  expect(unavailable.sends()).toBe(0);
});

test('lost-response replay resolves the same durable receipt, including after proof retirement', async () => {
  const f = await fixture(); f.loseResponse();
  const first = await f.custody.commit(f.input);
  expect(first.status).toBe('committed');
  const terminal = await f.custody.resolve(f.input.envelope.receipt);
  expect(terminal?.revision).toBe(f.input.revision);
  await f.custody.retire(f.input.envelope.receipt);
  expect(f.store.row?.retired).toBe(true);
  const replay = await f.custody.commit({ ...f.input, revision: f.input.revision.replace(/004$/, '099'),
    receipt: { ...f.input.receipt, revision: f.input.revision.replace(/004$/, '099') } });
  expect(replay).toEqual(first); expect(f.sends()).toBe(1);
  expect(await f.custody.resolve(f.input.envelope.receipt)).toEqual(terminal);
});

test('concurrent retries serialize one preparation and one graph effect', async () => {
  const f = await fixture();
  const results = await Promise.all([f.custody.commit(f.input), f.custody.commit(f.input)]);
  expect(results[1]).toEqual(results[0]); expect(f.sends()).toBe(1);
});

test('cancellation queued behind a committed command resolves success before retirement can remove its proof', async () => {
  const f = await fixture();
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const commit = f.custody.commit({ ...f.input, dispatch: async envelope => {
    entered(); await gate; return f.input.dispatch(envelope);
  } });
  await started;
  let cancellations = 0;
  const cancel = f.custody.guardCancellation(f.input.envelope.receipt, () => {
    cancellations++; return Promise.resolve();
  });
  const retire = f.custody.retire(f.input.envelope.receipt);
  unblock();
  await commit;
  expect((await cancel)?.revision).toBe(f.input.revision);
  await retire;
  expect(cancellations).toBe(0); expect(f.store.row?.retired).toBe(true);
});

test('lost retirement response leaves the durable receipt final and retries the same signed evidence', async () => {
  const f = await fixture(); await f.custody.commit(f.input);
  let calls = 0;
  const evidence: ProofRetirement[] = [];
  const custody = new ReceiptCustody(f.store, f.objects, { query: () => Promise.resolve({
    results: { bindings: [] },
  }) }, f.key, proof => {
    evidence.push(proof); calls++;
    if (calls === 1) throw new CommandOutcomeUnknown('retirement acknowledgement lost');
    return Promise.resolve();
  });
  await expect(custody.retire(f.input.envelope.receipt)).rejects.toBeInstanceOf(CommandOutcomeUnknown);
  expect(f.store.row?.retired).toBe(false);
  expect((await custody.resolve(f.input.envelope.receipt))?.revision).toBe(f.input.revision);
  await custody.retire(f.input.envelope.receipt);
  expect(evidence[1]).toEqual(evidence[0]); expect(f.store.row?.retired).toBe(true);
});

test('CAS conflict and SHACL or policy rejection create no successful owner receipt or outbox', async () => {
  for (const result of [{ status: 'guard-unmatched' }, { status: 'invalid', report: 'policy denied' },
    { status: 'invalid', report: 'SHACL rejected' }] as CommandResult[]) {
    const f = await fixture(); f.refuse(result);
    expect(await f.custody.commit(f.input)).toEqual(result);
    expect(await f.custody.resolve(f.input.envelope.receipt)).toBeNull();
    expect(f.store.row?.outbox).toBeNull();
    await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toThrow('not been reconciled');
    expect(f.retirements).toEqual([]);
  }
});

test('same key with a different intent conflicts without dispatch', async () => {
  const f = await fixture(); await f.custody.commit(f.input);
  const requestDigest = hash('different intent');
  await expect(f.custody.commit({ ...f.input, envelope: { ...f.input.envelope, digest: requestDigest },
    receipt: { ...f.input.receipt, requestDigest } })).rejects.toBeInstanceOf(CommandRejected);
  expect(f.sends()).toBe(1);
});

test('a graph commit with failed owner reconciliation retains the proof and recovers without redispatch', async () => {
  const f = await fixture(); f.store.failReconcile = true;
  await expect(f.custody.commit(f.input)).rejects.toThrow('reconciliation response lost');
  await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toThrow('not been reconciled');
  f.store.failReconcile = false;
  const recovered = await f.custody.resolve(f.input.envelope.receipt);
  expect(recovered?.sequence).toBe('17'); expect(f.sends()).toBe(1);
  await f.custody.retire(f.input.envelope.receipt);
  const row = f.store.row!;
  expect(f.retirements[0]?.signature).toBe(createHmac('sha256', f.key).update(JSON.stringify([
    'rezics-commit-proof-retirement-v1', row.receipt, row.requestDigest, row.payloadSha256,
    recovered!.dataEpoch, recovered!.sequence, recovered!.streamSequence,
  ])).digest('hex'));
});

test('owner source reads the legacy-compatible event at its Main stream position after proof retirement', async () => {
  const f = await fixture();
  await f.custody.commit(f.input);
  await f.custody.retire(f.input.envelope.receipt);
  f.queries.length = 0;
  const batchId = `urn:rezics:outbox:${hash(f.input.envelope.receipt)}`;
  const eventId = `urn:rezics:event:${hash(f.input.envelope.receipt)}`;
  expect(await f.custody.read('epoch-a', '4')).toMatchObject({
    batch: { batchId, streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch-a', sequence: '4',
      graphSequence: '17', routingEpoch: 'routing-a', eventIds: [eventId],
      custodiedReceipt: f.input.envelope.receipt },
    events: [{ specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.metadata-changed.v1', datacontenttype: 'application/json',
      data: { batchId, routingEpoch: 'routing-a', ordinal: 0,
        sourcePosition: { datasetId: 'product', dataEpoch: 'epoch-a', sequence: '17' },
        relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch-a', sequence: '4' },
        receipt: { id: f.input.envelope.receipt, action: 'work.edit', outcome: 'succeeded',
          admissionId: f.input.receipt.admissionId, requestDigest: f.input.envelope.digest,
          authorityEpoch: '1', scope: f.input.receipt.scope,
          metadata: { work: f.input.receipt.work, component: f.input.component,
            revision: f.input.revision, manifest: `urn:rezics:sha256:${f.input.manifest}` } } } }],
  });
  expect(f.queries).toEqual([]);
  expect(f.sends()).toBe(1);
});

test('owner source reconciles a pending lost-response command before returning its event', async () => {
  const f = await fixture();
  f.loseResponse();
  f.store.failReconcile = true;
  await expect(f.custody.commit(f.input)).rejects.toThrow('reconciliation response lost');
  expect(f.store.row?.terminal).toBeNull();
  expect(await f.store.receiptAt('epoch-a', '4')).toBeNull();
  f.store.failReconcile = false;
  f.queries.length = 0;
  const retained = await f.custody.read('epoch-a', '4');
  expect(f.queries.some(query => query.includes('SELECT ?receipt'))).toBe(true);
  expect(f.store.row?.reconciled).toBe(true);
  expect(f.store.row?.terminal).toMatchObject({ receipt: f.input.envelope.receipt,
    sequence: '17', streamSequence: '4' });
  expect(await f.store.receiptAt('epoch-a', '4')).toBe(f.input.envelope.receipt);
  expect(retained).toMatchObject({ batch: { sequence: '4', graphSequence: '17' },
    events: [{ data: { receipt: { id: f.input.envelope.receipt, metadata: { work: f.input.receipt.work } } } }] });
  expect(f.sends()).toBe(1);
  expect(await f.custody.read('epoch-a', '4')).toEqual(retained);
});

test('owner source refuses mismatched or corrupt indexed custody', async () => {
  for (const [dataEpoch, sequence] of [['wrong-epoch', '4'], ['epoch-a', '5']] as const) {
    const f = await fixture();
    await f.custody.commit(f.input);
    await f.custody.retire(f.input.envelope.receipt);
    f.store.indexedReceipt = f.input.envelope.receipt;
    await expect(f.custody.read(dataEpoch, sequence)).rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(f.sends()).toBe(1);
  }
  const corrupt = await fixture();
  await corrupt.custody.commit(corrupt.input);
  corrupt.store.indexedReceipt = corrupt.input.envelope.receipt;
  corrupt.store.row = { ...corrupt.store.row!, terminal: {
    ...corrupt.store.row!.terminal!, streamSequence: 'corrupt-index' } };
  await expect(corrupt.custody.read('epoch-a', '4')).rejects.toBeInstanceOf(ObjectIntegrityError);
});

test('owner source refuses missing exact objects after proof retirement', async () => {
  for (const missing of ['command', 'manifest', 'payload'] as const) {
    const f = await fixture();
    await f.custody.commit(f.input);
    await f.custody.retire(f.input.envelope.receipt);
    const manifest = JSON.parse(Buffer.from(await f.objects.get(f.input.manifest)).toString('utf8')) as { payload: string };
    const digest = missing === 'command' ? f.store.row!.payloadSha256
      : missing === 'manifest' ? f.input.manifest : manifest.payload.slice(7);
    f.objects.bytes.delete(digest);
    await expect(f.custody.read('epoch-a', '4')).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(f.sends()).toBe(1);
  }
});

test('retirement refuses missing command, manifest or component payload bytes even after reconciliation', async () => {
  for (const missing of ['command', 'manifest', 'payload']) {
    const f = await fixture(); await f.custody.commit(f.input);
    const manifest = JSON.parse(Buffer.from(await f.objects.get(f.input.manifest)).toString('utf8')) as { payload: string };
    const digest = missing === 'command' ? f.store.row!.payloadSha256
      : missing === 'manifest' ? f.input.manifest : manifest.payload.slice(7);
    f.objects.bytes.delete(digest);
    await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(f.retirements).toEqual([]); expect(f.store.row?.retired).toBe(false);
  }
});

test('mismatched proof cannot reconcile, sign retirement or overwrite a durable result', async () => {
  const f = await fixture(); await f.custody.commit(f.input);
  f.setProof({ digest: f.input.envelope.digest, payloadSha256: hash('wrong object'), dataEpoch: 'epoch-a', sequence: '17', streamSequence: '4' });
  await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toThrow('differs from owner custody');
  expect(f.retirements).toEqual([]);
  f.setProof({ digest: f.input.envelope.digest, payloadSha256: f.store.row!.payloadSha256,
    dataEpoch: 'epoch-a', sequence: '17', streamSequence: '5' });
  await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toThrow('Receipt position differs');
  expect(f.retirements).toEqual([]);
  const unresolved = await fixture(); unresolved.store.failReconcile = true;
  await expect(unresolved.custody.commit(unresolved.input)).rejects.toThrow();
  unresolved.store.failReconcile = false;
  unresolved.setProof({ digest: unresolved.input.envelope.digest, payloadSha256: unresolved.store.row!.payloadSha256,
    dataEpoch: 'wrong-epoch', sequence: '17', streamSequence: '4' });
  await expect(unresolved.custody.resolve(unresolved.input.envelope.receipt)).rejects.toThrow('differs from owner custody');
  expect(unresolved.store.row?.terminal).toBeNull();
});

test('custody rejects an exact object bound to another revision before dispatch', async () => {
  const f = await fixture();
  const manifest = await prepareWorkComponent(f.objects, f.input.component, {
    revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000099',
    intent: { work: f.input.receipt.work, expectedHead: null,
      state: f.input.state },
  }, 'https://rezics.com/definition/work-metadata-details-v1');
  await expect(f.custody.commit({ ...f.input, manifest })).rejects.toThrow('Component payload binding differs');
  expect(f.sends()).toBe(0); expect(f.store.row?.reconciled).toBe(false);
});

test('retirement refuses a missing or altered durable receipt and outbox', async () => {
  for (const corrupt of ['receipt', 'outbox', 'absent'] as const) {
    const f = await fixture(); await f.custody.commit(f.input);
    const row = f.store.row!;
    f.store.row = corrupt === 'receipt' ? { ...row, terminal: { ...row.terminal!, revision: 'wrong-revision' } }
      : { ...row, outbox: corrupt === 'absent' ? null : { ...row.outbox, eventCount: 2 } };
    await expect(f.custody.retire(f.input.envelope.receipt)).rejects.toThrow();
    expect(f.retirements).toEqual([]); expect(f.store.row.retired).toBe(false);
  }
});
