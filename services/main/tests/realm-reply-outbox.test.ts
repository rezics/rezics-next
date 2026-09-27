import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { replyReceiptIri, replySlotIri } from '../src/modules/realm-reply/graph.ts';
import { hash, ID, RV } from '../src/modules/work/activate.ts';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
const admissionId = id('1');
const realm = ID + id('2');
const reply = ID + id('3');
const placement = ID + id('4');
const receipt = replyReceiptIri({ id: admissionId, action: 'reply.place' });
const eventId = `urn:rezics:event:${hash(placement)}`;
const batch: MainOutboxBatch = { batchId: `urn:rezics:outbox:${hash(receipt)}`,
  dataEpoch: id('5'), sequence: '17', routingEpoch: 'route', eventIds: [eventId] };
const revision = `urn:rezics:content:revision:${id('6')}`;
const review = `urn:rezics:realm-review:${id('7')}`;
const ownerEpoch = id('8');
const bytes = 'a'.repeat(64);

function fixture(overrides: Record<string, string> = {}, receiptOverrides: Record<string, string> = {}) {
  const shared: Record<string, string> = { kind: `${RV}RealmReplyPlacedEvent`, ordinal: '0',
    action: 'reply.place', receipt, outcome: `${RV}Succeeded`, admissionId,
    digest: 'b'.repeat(64), authorityEpoch: '1', scope: `reply:place:${realm}`,
    realm, eventRealm: realm, epoch: batch.dataEpoch, sequence: batch.sequence,
    contentRevision: revision, ownerDataEpoch: ownerEpoch, ownerSequence: '9', ...receiptOverrides };
  const proof: Record<string, string> = { placement, slot: replySlotIri(realm, reply), reply,
    root: ID + id('9'), rootRevision: ID + id('a'), author: ID + id('b'), actor: ID + id('c'),
    revision, bytes, preparation: admissionId, ownerEpoch, ownerSequence: '9', review,
    reviewDigest: 'c'.repeat(64), ...overrides };
  const binding = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key, { type: 'literal', value }]));
  let calls = 0;
  const queries: { query: string; maximum?: number }[] = [];
  const graph = { query: async (query: string, maximum?: number) => {
    queries.push({ query, maximum });
    return { results: { bindings: [binding(++calls === 1 ? shared : proof)] } };
  } } as unknown as FusekiClient;
  return { graph, queries };
}

test('G-277: reply relay retains exact preparation and placement without reading present authority or bytes', async () => {
  const { graph, queries } = fixture();
  const envelope = await readMainOutboxEnvelope(graph, batch, eventId);
  expect(envelope.type).toBe('com.rezics.realm.reply-placed.v1');
  expect(envelope.data.receipt).toMatchObject({ id: receipt, realm, reply, placement,
    contentRevision: revision, byteDigest: bytes, contentPreparation: admissionId,
    reviewDecision: review, ownerDataEpoch: ownerEpoch, ownerSequence: '9' });
  expect(envelope.data.receipt).not.toHaveProperty('body');
  expect(queries).toHaveLength(2);
  expect(queries[1]?.maximum).toBe(16 * 1024);
  expect(queries[1]?.query).toContain('LIMIT 2');
  expect(queries[1]?.query).not.toContain('replyPlacementHead');
});

test.each([
  ['wrong slot', { slot: replySlotIri(ID + id('d'), reply) }],
  ['wrong preparation', { preparation: id('d') }],
  ['wrong placement', { placement: ID + id('d') }],
  ['wrong revision', { revision: `urn:rezics:content:revision:${id('d')}` }],
  ['wrong Content epoch', { ownerEpoch: id('d') }],
  ['wrong Content position', { ownerSequence: '10' }],
  ['missing digest', { bytes: '' }],
  ['invalid review', { review: ID + id('d') }],
  ['unpaired parent', { parent: ID + id('d') }],
  ['unpaired parent revision', { parentRevision: id('d') }],
  ['unproved predecessor', { previous: ID + id('d') }],
] as const)('G-277: reply relay rejects %s', async (_name, overrides) => {
  await expect(readMainOutboxEnvelope(fixture(overrides).graph, batch, eventId))
    .rejects.toThrow('placement proof');
});

test('G-277: reply relay binds predecessor, parent and context when present', async () => {
  const previous = ID + id('d');
  const parent = ID + id('e');
  const parentRevision = id('f');
  const context = ID + id('f');
  const { graph } = fixture({ previous, expectedHead: previous, parent, parentRevision, context },
    { expectedHead: previous });
  const envelope = await readMainOutboxEnvelope(graph, batch, eventId);
  expect(envelope.data.receipt).toMatchObject({ expectedHead: previous,
    parentReply: parent, parentRevision, contextRevision: context });
  await expect(readMainOutboxEnvelope(fixture({ previous, expectedHead: previous }).graph, batch, eventId))
    .rejects.toThrow('placement proof');
});

test('G-277: reply relay rejects cancellation, scope substitution and wrong batch identity', async () => {
  const invalid: Record<string, string>[] = [
    { outcome: `${RV}Cancelled` }, { scope: `reply:place:${ID + id('d')}` },
  ];
  for (const overrides of invalid) {
    await expect(readMainOutboxEnvelope(fixture({}, overrides).graph, batch, eventId))
      .rejects.toThrow('terminal receipt');
  }
  await expect(readMainOutboxEnvelope(fixture().graph, { ...batch, batchId: 'urn:wrong:batch' }, eventId))
    .rejects.toThrow('terminal receipt');
});

test('G-277: missing or ambiguous placement proof stops delivery', async () => {
  for (const duplicate of [false, true]) {
    const { graph } = fixture();
    const query = graph.query.bind(graph);
    let calls = 0;
    graph.query = async (...args) => {
      const result = await query(...args);
      if (++calls === 2) result.results!.bindings = duplicate
        ? [...result.results!.bindings, ...result.results!.bindings] : [];
      return result;
    };
    await expect(readMainOutboxEnvelope(graph, batch, eventId)).rejects.toThrow('placement proof');
  }
});
