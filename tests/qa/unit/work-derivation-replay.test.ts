import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { RV, hash, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { workDerivationDigest, workDerivationReceiptIri,
  type WorkDerivationInput } from '../../../services/main/src/modules/work/derivations.ts';
import { relayCoverage, type MainCloudEvent, type RelayCoverage }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { parseRetainedWorkDerivation, reconcileRetainedWorkDerivation }
  from '../../../services/main/src/modules/work/reconcile-derivation.ts';
import { RetainedEffectConflict }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';

const ids = Array.from({ length: 8 }, (_, n) =>
  `https://rezics.com/id/00000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`);
const epoch = '00000000-0000-0000-0000-000000000001';
const admissionId = '00000000-0000-0000-0000-000000000009';
const requestKey = 'work04-retained-request';
const field = (value: string) => ({ value });
const prior = 'https://rezics.com/id/00000000-0000-0000-0000-000000000011';

function fixture(kind: WorkDerivationInput['kind'] = 'software-fork', corrects?: string) {
  const input: WorkDerivationInput = { targetWork: ids[0]!, targetMainVersion: ids[1]!,
    expectedTargetHead: ids[2]!, sourceWork: ids[3]!, sourceMainVersion: ids[4]!,
    sourceMainRevision: ids[5]!, kind,
    evidence: 'https://creator.example/retained-fork', actingSubject: ids[6]! };
  const receiptId = workDerivationReceiptIri(admissionId);
  const eventId = `urn:rezics:event:${hash(`${receiptId}\0work-derived`)}`;
  const batchId = `urn:rezics:outbox:${hash(receiptId)}`;
  const envelope: MainCloudEvent = { specversion: '1.0', id: eventId,
    source: 'https://rezics.com/services/main', type: 'com.rezics.work.derived.v1',
    datacontenttype: 'application/json',
    data: { batchId, sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence: '1' },
      routingEpoch: '1', ordinal: 0,
      receipt: { id: receiptId, action: 'work.derive', outcome: 'succeeded', admissionId,
        requestDigest: workDerivationDigest({ ...input,
          ...(corrects === undefined ? {} : { corrects }), idempotencyKey: requestKey }),
        authorityEpoch: '1',
        scope: `derivation:link:${input.targetWork}`, workDerivation: ids[7]!,
        targetWork: input.targetWork, targetMainVersion: input.targetMainVersion,
        targetMainRevision: input.expectedTargetHead, sourceWork: input.sourceWork,
        sourceMainVersion: input.sourceMainVersion, sourceMainRevision: input.sourceMainRevision,
        derivationKind: input.kind, evidence: input.evidence, linkedBy: input.actingSubject } } };
  const coverage: RelayCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'work04-replay', dataEpoch: epoch,
    sequence: '1', batchCount: '1', batchDigest: '', eventCount: '1', eventDigest: '' };
  return { input, receiptId, eventId, batchId, envelope, coverage };
}

test('WORK04 retained parser preserves exact derivation and rejects changed provenance', () => {
  for (const kind of ['adaptation', 'new-recording', 'software-fork'] as const) {
    const source = fixture(kind);
    expect(parseRetainedWorkDerivation(source.eventId, source.envelope,
      source.coverage, '1')).toMatchObject({ input: source.input, derivation: ids[7] });
  }
  const source = fixture();
  const mutations: ((event: MainCloudEvent) => void)[] = [
    event => { event.data.receipt.scope = 'derivation:link:wrong'; },
    event => { event.data.receipt.evidence = 'http://creator.example/forged'; },
    event => { event.data.receipt.requestDigest = 'invalid'; },
    event => { event.data.batchId = 'urn:rezics:outbox:wrong'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(source.envelope);
    mutate(changed);
    expect(() => parseRetainedWorkDerivation(source.eventId, changed,
      source.coverage, '1')).toThrow(RetainedEffectConflict);
  }
});

test('WORK04 replay rejects a self-consistent retained event with a changed derivation', async () => {
  const fixture = recovery();
  fixture.envelope.data.receipt.derivationKind = 'adaptation';
  const coverage = await relayCoverage(fixture.relay, 'work04-replay');
  await expect(reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).rejects.toThrow(RetainedEffectConflict);
  expect(fixture.commands()).toBe(0);
});

test('WORK04 first-declaration digests stay stable and bind a correction target', () => {
  const { input } = fixture();
  const first = workDerivationDigest({ ...input, idempotencyKey: requestKey });
  // Pinned from the pre-correction profile; retained admissions must still verify.
  expect(first).toBe('2006269a29064d1e3303714df39d99a4924e559a085590c8887413fa71615140');
  expect(workDerivationDigest({ ...input, corrects: prior, idempotencyKey: requestKey }))
    .not.toBe(first);
});

/** `corrects` is the digest-bound request; `heldPrior` is the restored graph's effective prior. */
function recovery(options: { corrects?: string; heldPrior?: string } = {}) {
  const source = fixture('software-fork', options.corrects);
  const receipt = source.envelope.data.receipt;
  const admission = { action: 'work.derive', state: 'sealed', scope_id: receipt.scope,
    request_digest: receipt.requestDigest, authority_epoch: '1',
    acting_subject: source.input.actingSubject, idempotency_key: requestKey,
    graph_receipt: receipt.id, graph_outcome: 'succeeded', graph_data_epoch: epoch,
    graph_sequence: '1' };
  const fence = { open: false };
  let committed = false;
  let commands = 0;
  let eventPresent = true;
  let changeEventAfterScan = false;
  let changeBatchAfterScan = false;
  let laterBatchId = source.batchId;
  const relayQuery = async (sql: string) => {
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: epoch, sequence: '1' }] };
    if (sql.includes('UNION ALL')) return { rows: [], rowCount: 0 };
    if (sql.includes('actual_count')) {
      const row = { sequence: '1', batch_id: source.batchId,
        routing_epoch: '1', event_count: 1, actual_count: eventPresent ? '1' : '0' };
      if (changeBatchAfterScan) {
        laterBatchId = 'urn:rezics:outbox:changed-after-scan';
        changeBatchAfterScan = false;
      }
      return { rows: [row] };
    }
    if (sql.includes('envelope::text')) {
      const body = JSON.stringify(source.envelope);
      if (changeEventAfterScan) {
        source.envelope.data.receipt.workDerivation =
          'https://rezics.com/id/00000000-0000-0000-0000-000000000010';
        changeEventAfterScan = false;
      }
      return { rows: eventPresent ? [{ source: 'main', event_id: source.eventId,
        sequence: '1', body }] : [] };
    }
    if (sql.includes('SELECT event_id, envelope')) return { rows: eventPresent
      ? [{ event_id: source.eventId, envelope: source.envelope }] : [] };
    if (sql.includes('SELECT batch_id, routing_epoch')) return { rows: [{ batch_id: laterBatchId,
      routing_epoch: '1', event_count: 1 }] };
    return { rows: [] };
  };
  const relay = { connect: async () => ({ query: relayQuery, release: () => {} }),
    query: relayQuery } as unknown as Pool;
  const accessPool = { connect: async () => ({ query: async (sql: string) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [fence] };
    if (sql.includes('FROM access.admission')) return { rows: [admission] };
    return { rows: [] };
  }, release: () => {} }) } as unknown as Pool;
  const fuseki = {
    commandHealth: async () => ({ profiles: {
      'work-derivation-v1': profileRegistry['work-derivation-v1'].sha256 } }),
    commandWithReceipt: async (command: { update: string;
      validations: { binding?: Record<string, string> }[] }) => {
      commands++;
      expect(command.validations).toHaveLength(1);
      expect(command.validations[0]?.binding?.derivation).toBe(ids[7]);
      expect(command.update).toContain('rv:derivationKind rv:SoftwareFork');
      expect(command.update).toContain(`rv:sourceMainRevision <${source.input.sourceMainRevision}>`);
      if (options.heldPrior) expect(command.update).toContain(`rv:corrects <${options.heldPrior}>`);
      committed = true;
      return { status: 'committed' };
    },
    query: async (sparql: string) => {
      if (sparql.includes('SELECT\n    ?outcome ?derivation')) return { results: { bindings: committed
        ? [{ outcome: field(`${RV}Succeeded`), derivation: field(ids[7]!),
          digest: field(receipt.requestDigest), admission: field(admissionId),
          scope: field(receipt.scope), authorityEpoch: field('1'),
          epoch: field(epoch), sequence: field('1') }] : [] } };
      if (sparql.includes('SELECT ?prior')) return { results: { bindings: options.heldPrior
        ? [{ prior: field(options.heldPrior) }] : [] } };
      if (sparql.includes('SELECT ?cursor')) return { results: { bindings: committed
        ? [{ cursor: field('1') }] : [] } };
      if (sparql.includes('SELECT ?saved ?savedMain WHERE')) return { results: { bindings: [{ saved: field('0') }] } };
      if (sparql.includes('SELECT\n    ?derivation ?targetWork')) {
        const row = (derivation: string, sequence: string) => ({ derivation: field(derivation),
          targetWork: field(source.input.targetWork), sourceWork: field(source.input.sourceWork),
          sourceMain: field(source.input.sourceMainVersion),
          sourceRevision: field(source.input.sourceMainRevision),
          kind: field(`${RV}SoftwareFork`), evidence: field(source.input.evidence),
          linkedBy: field(source.input.actingSubject), sequence: field(sequence) });
        const held = options.heldPrior ? [{ ...row(options.heldPrior, '0'),
          supersededBy: field(ids[7]!) }] : [];
        return { results: { bindings: committed ? [...held, { ...row(ids[7]!, '1'),
          ...(options.heldPrior ? { corrects: field(options.heldPrior) } : {}) }] : held } };
      }
      return { boolean: committed || sparql.includes('rv:RevisionAnchor ; rv:component') };
    },
  };
  const env = { fuseki, lineage: { dataEpoch: '00000000-0000-0000-0000-000000000002',
    routingEpoch: '2' } } as unknown as WorkActivationEnvironment;
  return { ...source, relay, accessPool, admission, fence, env,
    commands: () => commands, loseEvent: () => { eventPresent = false; },
    driftAfterScan: () => { changeEventAfterScan = true; changeBatchAfterScan = true; },
    laterBatch: () => laterBatchId };
}

test('WORK04 held replay restores one exact relation and reuses its receipt', async () => {
  const fixture = recovery();
  const coverage = await relayCoverage(fixture.relay, 'work04-replay');
  const first = await reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1');
  expect(first).toEqual({ receipt: fixture.receiptId, derivation: ids[7], replayed: false });
  expect(await reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).toEqual({ ...first, replayed: true });
  expect(fixture.commands()).toBe(1);
});

test('WORK04 replay uses the event and batch from the verified relay snapshot', async () => {
  const fixture = recovery();
  const coverage = await relayCoverage(fixture.relay, 'work04-replay');
  fixture.driftAfterScan();
  expect(await reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).toEqual({ receipt: fixture.receiptId,
    derivation: ids[7], replayed: false });
  expect(fixture.envelope.data.receipt.workDerivation).not.toBe(ids[7]);
  expect(fixture.laterBatch()).not.toBe(fixture.batchId);
  expect(fixture.commands()).toBe(1);
});

test('WORK04 held replay rejects changed Access, fence and relay evidence before mutation', async () => {
  for (const damage of [
    (value: ReturnType<typeof recovery>) => { value.admission.idempotency_key = 'changed-request-key'; },
    (value: ReturnType<typeof recovery>) => { value.admission.request_digest = 'wrong'; },
    (value: ReturnType<typeof recovery>) => { value.fence.open = true; },
    (value: ReturnType<typeof recovery>) => { value.loseEvent(); },
  ]) {
    const fixture = recovery();
    const coverage = await relayCoverage(fixture.relay, 'work04-replay');
    damage(fixture);
    await expect(reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
      fixture.relay, coverage, '1')).rejects.toThrow();
    expect(fixture.commands()).toBe(0);
  }
});

test('WORK04 held replay restores a correction only for the digest-bound effective prior', async () => {
  const fixture = recovery({ corrects: prior, heldPrior: prior });
  const coverage = await relayCoverage(fixture.relay, 'work04-replay');
  const first = await reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1');
  expect(first).toEqual({ receipt: fixture.receiptId, derivation: ids[7], replayed: false });
  expect((await reconcileRetainedWorkDerivation(fixture.env, fixture.accessPool,
    fixture.relay, coverage, '1')).replayed).toBe(true);
  expect(fixture.commands()).toBe(1);
  for (const options of [{ corrects: prior }, { heldPrior: prior },
    { corrects: prior, heldPrior: ids[0]! }]) {
    const changed = recovery(options);
    await expect(reconcileRetainedWorkDerivation(changed.env, changed.accessPool, changed.relay,
      await relayCoverage(changed.relay, 'work04-replay'), '1')).rejects.toThrow(RetainedEffectConflict);
    expect(changed.commands()).toBe(0);
  }
});
