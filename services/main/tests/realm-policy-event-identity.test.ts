import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, Store } from 'n3';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { readMainOutboxEnvelope, relayMainOutboxOnce, type DeliveredMainEvent,
  type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { createRealmSpace, spaceCreationDigest } from '../src/modules/space/create.ts';
import { outboxEventHandlers } from '../src/modules/space/outbox-event.ts';
import { deliverRealmPolicy, policyHead, type RealmPolicyDelivery } from '../src/modules/space/policy.ts';
import { GRAPHS, ID, RV, hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const uuid = (digit: string) => `00000000-0000-4000-8000-${digit.repeat(12)}`;
const realm = ID + uuid('1'), space = ID + uuid('2'), actor = ID + uuid('3');
const lineage = { dataEpoch: uuid('4'), routingEpoch: 'route' };
const policyHandler = outboxEventHandlers.find(handler => handler.kind === `${RV}RealmPolicyChangedEvent`)!;
const intent: RealmPolicyDelivery = { realm, receipt_id: uuid('5'), generation: '2',
  visibility: 'private', review_mode: 'mandatory' };
const receiptFields = { outcome: 'outcome', digest: 'requestDigest', admissionId: 'admissionId',
  authorityEpoch: 'authorityEpoch', scope: 'admittedScope', epoch: 'dataEpoch', sequence: 'sequence',
  realm: 'realm', space: 'space', operation: 'operation', spaceRevision: 'spaceRevision',
  realmRevision: 'realmRevision', owner: 'owner' };

/** Parse the real command's INSERT triples. The test double implements only
 * the bounded reads these writes and the relay use, without a live backend. */
function fixture(objectDirectory = '') {
  const store = new Store();
  const commands: CommandEnvelope[] = [];
  const queries: string[] = [];
  const batches: MainOutboxBatch[] = [];
  const delivered: DeliveredMainEvent[] = [];
  let checkpoint = '0';
  const facts = (subject: string, graph: string, fields: Record<string, string>) => {
    const row: Record<string, { type: string; value: string }> = {};
    for (const [name, predicate] of Object.entries(fields)) {
      const object = store.getObjects(subject, `${RV}${predicate}`, graph)[0];
      if (object) row[name] = { type: object.termType === 'NamedNode' ? 'uri' : 'literal', value: object.value };
    }
    return row;
  };
  const rows = (row: Record<string, { type: string; value: string }>): SparqlResult =>
    ({ results: { bindings: Object.keys(row).length ? [row] : [] } });
  const graph = new FusekiClient('http://unused.test');
  graph.commandHealth = async () => ({ moduleVersion: '', instanceId: '', publicSearchWriteEpoch: '',
    publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([name, profile]) => [name, profile.sha256])) });
  graph.commandWithReceipt = async command => {
    commands.push(command);
    const inserted = command.update.match(/INSERT \{([\s\S]*?)\}\s*WHERE \{/);
    if (!inserted) throw new Error('Expected atomic graph command');
    const position = String(commands.length);
    // A later policy replaces these mutable facts, but retains every receipt.
    for (const predicate of ['visibility', 'reviewMode', 'realmPolicyHead', 'reviewPolicy']) {
      store.removeQuads(store.getQuads(realm, `${RV}${predicate}`, null, GRAPHS.current));
    }
    store.addQuads(new Parser({ format: 'TriG' }).parse(
      `@prefix rv: <${RV}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . ${inserted[1]!.replaceAll('?next', position)}`));
    const batchId = store.getSubjects(`${RV}sequence`, null, GRAPHS.outbox)
      .find(subject => facts(subject.value, GRAPHS.outbox, { sequence: 'sequence' }).sequence?.value === position)!.value;
    batches.push({ batchId, ...lineage, sequence: position,
      eventIds: store.getObjects(batchId, `${RV}event`, GRAPHS.outbox).map(event => event.value) });
    return { status: 'committed', position: { datasetId: 'product', dataEpoch: lineage.dataEpoch, sequence: position } };
  };
  graph.query = async query => {
    queries.push(query);
    const receipt = query.match(/<((?:urn:rezics:receipt:|urn:rezics:realm-policy:)[^>]+)>/)?.[1];
    if (query.includes('ASK')) {
      if (receipt) return { boolean: store.getObjects(receipt, `${RV}requestDigest`, GRAPHS.receipts)
        .some(digest => query.includes(JSON.stringify(digest.value))) };
      return { boolean: true };
    }
    if (query.includes('SELECT ?controlSequence')) {
      const next = query.match(/rv:streamSequence (\d+)/)![1];
      const batch = batches.find(candidate => candidate.sequence === next);
      return rows({ controlSequence: { type: 'literal', value: String(batches.length) },
        routing: { type: 'literal', value: lineage.routingEpoch }, ...batch ? {
          batch: { type: 'uri', value: batch.batchId }, eventCount: { type: 'literal', value: String(batch.eventIds.length) },
          graphSequence: { type: 'literal', value: batch.sequence } } : {} });
    }
    if (query.includes('SELECT ?event ?ordinal')) {
      const batchId = query.match(/<(urn:rezics:outbox:[^>]+)>/)![1];
      return { results: { bindings: batches.find(batch => batch.batchId === batchId)!.eventIds
        .map(event => ({ event: { type: 'uri', value: event }, ...facts(event, GRAPHS.outbox, { ordinal: 'ordinal' }) })) } };
    }
    if (query.includes('?kind ?ordinal ?action')) {
      const eventId = query.match(/<(urn:rezics:event:[^>]+)>/)![1];
      const event = facts(eventId, GRAPHS.outbox, { ordinal: 'ordinal', action: 'action', receipt: 'receipt',
        eventRealm: 'realm', eventSpace: 'space', eventOperation: 'operation' });
      if (!event.receipt) return rows({});
      const kind = store.getObjects(eventId, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', GRAPHS.outbox)[0]!;
      return rows({ ...event, kind: { type: 'uri', value: kind.value },
        ...facts(event.receipt.value, GRAPHS.receipts, receiptFields) });
    }
    if (query.includes('SELECT ?visibility ?mode ?generation')) {
      expect(query).toContain(`GRAPH <${GRAPHS.receipts}>`);
      expect(query).not.toContain(GRAPHS.current);
      expect(query).toContain('LIMIT 2');
      const proof = facts(receipt!, GRAPHS.receipts,
        { visibility: 'visibility', mode: 'reviewMode', generation: 'policyGeneration' });
      return rows(proof.visibility && proof.mode && proof.generation ? proof : {});
    }
    if (query.includes('SELECT ?manifest')) {
      const revision = query.match(/GRAPH <[^>]+> \{ <([^>]+)>/)![1];
      return rows(facts(revision!, GRAPHS.revisions, { manifest: 'manifest' }));
    }
    if (query.includes('SELECT\n    ?outcome')) return rows(facts(receipt!, GRAPHS.receipts,
      { ...receiptFields, id: 'admissionId', epoch: 'authorityEpoch', dataEpoch: 'dataEpoch' }));
    if (query.includes('SELECT ?space ?spaceProfile ?realmProfile')) return rows({ space: { type: 'uri', value: space } });
    throw new Error(`Unexpected graph query: ${query}`);
  };
  const pool = { query: async (query: string, args: unknown[] = []) => {
    if (query.startsWith('SELECT stream_scope')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: lineage.dataEpoch, sequence: checkpoint }] };
    if (query.includes('INSERT INTO relay.delivered_event')) delivered.push(JSON.parse(args[4] as string));
    else if (query.includes('UPDATE relay.checkpoint')) {
      expect(args[3]).toBe(checkpoint); checkpoint = args[2] as string;
    } else if (!query.includes('INSERT INTO relay.delivered_batch')) throw new Error(`Unexpected relay query: ${query}`);
    return { rowCount: 1, rows: [] };
  } } as unknown as Pool;
  const env = { fuseki: graph, lineage, objectDirectory } as WorkActivationEnvironment;
  return { env, graph, pool, store, facts, commands, batches, queries, delivered };
}

test.each([false, true])('policy relay retains exact receipt proof for canonical=%s', async canonical => {
  const f = fixture();
  const op = { ...intent, ...canonical ? { policy_head: policyHead(intent.receipt_id) } : {} };
  await deliverRealmPolicy(f.env, op);
  const batch = f.batches[0]!;
  const event = await readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!);
  const receipt = canonical ? policyHead(intent.receipt_id) : `urn:rezics:realm-policy:${intent.receipt_id}`;
  expect(event.data.receipt).toEqual({ id: receipt, action: 'realm.policy.publish', outcome: 'succeeded',
    requestDigest: hash(JSON.stringify(intent)), realm, space, visibility: 'private', reviewMode: 'mandatory', generation: '2',
    systemProof: { kind: 'realm-settings-receipt', receiptId: canonical ? receipt.slice('urn:rezics:receipt:'.length) : intent.receipt_id } });
  expect(await readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!)).toEqual(event);
});

test('two committed canonical policy changes relay in order with their original policy fields', async () => {
  const f = fixture();
  await deliverRealmPolicy(f.env, { ...intent, policy_head: policyHead(intent.receipt_id) });
  const second = { ...intent, receipt_id: uuid('6'), generation: '3', visibility: 'restricted' as const,
    review_mode: 'trusted-members' as const };
  await deliverRealmPolicy(f.env, { ...second, policy_head: policyHead(second.receipt_id) });
  expect(f.facts(realm, GRAPHS.current, { visibility: 'visibility' }).visibility?.value).toBe('restricted');
  expect((await relayMainOutboxOnce(f.graph, f.pool, 'policy'))?.sequence).toBe('1');
  expect((await relayMainOutboxOnce(f.graph, f.pool, 'policy'))?.sequence).toBe('2');
  expect(await relayMainOutboxOnce(f.graph, f.pool, 'policy')).toBeNull();
  expect(f.delivered.map(event => event.data.receipt)).toMatchObject([
    { id: policyHead(intent.receipt_id), visibility: 'private', reviewMode: 'mandatory', generation: '2' },
    { id: policyHead(second.receipt_id), visibility: 'restricted', reviewMode: 'trusted-members', generation: '3' },
  ]);
});

test('initial canonical policy keeps the real Space creation event and Realm-node policy facts', async () => {
  const directory = mkdtempSync(resolve('.temp/realm-policy-identity-'));
  try {
    const f = fixture(directory);
    const input = { name: 'Private Realm', actingSubject: actor, initialSettings: {
      visibility: 'private' as const, reviewMode: 'trusted-members' as const, reviewRequired: false,
      whoMaySubmit: 'members' as const, selfJoin: false, rules: [] } };
    const admission: RegisteredAdmission = { id: uuid('7'), principalId: uuid('8'), actingSubject: actor,
      action: 'space.create', scope: 'space:create:root', authorityEpoch: '0', requestDigest: spaceCreationDigest(input),
      idempotencyKey: 'creation', state: 'claimed', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      dispatchEligible: true, replayed: false };
    const created = await createRealmSpace(f.env, admission, input);
    expect(created.receipt).toMatch(/^urn:rezics:receipt:[0-9a-f]{64}$/);
    expect(f.facts(created.realm!, GRAPHS.current, { head: 'realmPolicyHead', visibility: 'visibility', mode: 'reviewMode' }))
      .toMatchObject({ head: { value: created.receipt }, visibility: { value: 'private' }, mode: { value: 'trusted-members' } });
    const batch = f.batches[0]!;
    const event = await readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!);
    expect(event.type).toBe('com.rezics.space.created.v1');
    expect(event.data.receipt).toMatchObject({ id: created.receipt, realm: created.realm, space: created.space,
      action: 'space.create', admissionId: admission.id });
    expect(f.store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${RV}RealmPolicyChangedEvent`, GRAPHS.outbox)).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  ['epoch', 'wrong-epoch'], ['sequence', '9'], ['receipt', policyHead(uuid('9'))],
  ['receipt', 'urn:rezics:receipt:short'], ['receipt', `urn:rezics:receipt:${'g'.repeat(64)}`],
  ['receipt', 'urn:rezics:realm-policy:short'], ['eventRealm', ID + uuid('9')],
  ['outcome', `${RV}Cancelled`], ['digest', ''],
])('policy proof refuses mismatched %s=%s', async (field, replacement) => {
  const f = fixture();
  await deliverRealmPolicy(f.env, { ...intent, policy_head: policyHead(intent.receipt_id) });
  const batch = f.batches[0]!, receipt = policyHead(intent.receipt_id);
  const values: Record<string, string> = { receipt, realm, space, eventRealm: realm, outcome: `${RV}Succeeded`,
    digest: hash(JSON.stringify(intent)), epoch: lineage.dataEpoch, sequence: batch.sequence, [field]: replacement };
  await expect(policyHandler.read({ fuseki: f.graph, batch, eventId: batch.eventIds[0]!, ordinal: 0,
    value: name => values[name] })).rejects.toThrow('Realm policy event differs');
});

test('policy relay refuses missing, ambiguous or invalid immutable policy evidence', async () => {
  const f = fixture();
  await deliverRealmPolicy(f.env, { ...intent, policy_head: policyHead(intent.receipt_id) });
  const query = f.graph.query.bind(f.graph), batch = f.batches[0]!;
  for (const proof of [[], [{ visibility: { type: 'literal', value: 'public' } }],
    ...[{ visibility: 'hidden', mode: 'open', generation: '2' },
      { visibility: 'public', mode: 'automatic', generation: '2' },
      { visibility: 'public', mode: 'open', generation: '-1' }].map(row => [Object.fromEntries(
        Object.entries(row).map(([name, value]) => [name, { type: 'literal', value }]))])]) {
    f.graph.query = async (sql, maximum) => sql.includes('SELECT ?visibility')
      ? { results: { bindings: proof } } : query(sql, maximum);
    await expect(readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!)).rejects.toThrow('Realm policy event is incomplete');
  }
  f.graph.query = async (sql, maximum) => {
    const result = await query(sql, maximum);
    if (sql.includes('SELECT ?visibility')) result.results!.bindings.push(result.results!.bindings[0]!);
    return result;
  };
  await expect(readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!)).rejects.toThrow('Realm policy event is incomplete');
  const unavailable = new Error('Receipt store unavailable');
  f.graph.query = async () => { throw unavailable; };
  await expect(readMainOutboxEnvelope(f.graph, batch, batch.eventIds[0]!)).rejects.toThrow(unavailable);
});
