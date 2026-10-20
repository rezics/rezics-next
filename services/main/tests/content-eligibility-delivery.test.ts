import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentCore, EligibilityDeliveryPage, EligibilityDeliveryProgress } from '../../content/src/core.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { RetainedRelayBatch } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const GRAPH_EPOCH = '00000000-0000-4000-8000-000000000101';
const CONTENT_EPOCH = '00000000-0000-4000-8000-000000000102';
const ROUTING_EPOCH = '7';
const SCOPE = 'https://rezics.com/services/main';
const SEARCH_ELIGIBLE = 'com.rezics.content.search-eligible.v1';
const proof = { eligibility: { id: 'urn:eligibility:decision', variant: 'urn:variant:1',
  resource: 'urn:resource:1', publicationDecision: 'urn:publication:1', graphSequence: '42',
  rightsBasis: 'https://rezics.com/vocab/OriginalContribution', sourceReceiptId: 'urn:receipt:eligibility',
  requestDigest: 'a'.repeat(64) },
publication: { id: 'urn:publication:1', variant: 'urn:variant:1', resource: 'urn:resource:1',
  revision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000103', digest: 'b'.repeat(64),
  preparationId: 'prepare-1', ownerDataEpoch: CONTENT_EPOCH, ownerSequence: '3', graphSequence: '40' },
revisionId: '00000000-0000-4000-8000-000000000103' };

const originalRelay = { ...await import('../src/modules/outbox/relay.ts') };
const originalEligibilityState = { ...await import('../src/modules/content-publication/eligibility-state.ts') };
let readRange: (consumer: string, after: string, limit: number) => Promise<{
  coverage: { streamScope: string; consumer: string; dataEpoch: string; sequence: string };
  batches: RetainedRelayBatch[];
}> = async () => { throw new Error('retained range fixture is missing'); };
const rangeMock = mock(async (_pool: Pool, consumer: string, after: string, limit: number) =>
  readRange(consumer, after, limit));
const proofMock = mock(async () => proof);
await mock.module('../src/modules/outbox/relay.ts', () => ({ ...originalRelay,
  verifiedRetainedRelayRange: rangeMock }));
await mock.module('../src/modules/content-publication/eligibility-state.ts', () => ({ ...originalEligibilityState,
  readRetainedContentEligibilitySource: proofMock }));
const { deliverRetainedContentEligibilityOnce } = await import('../src/modules/content-publication/eligibility-delivery.ts');
const { ContentEligibilityStateUnavailable } = originalEligibilityState;

afterAll(async () => {
  await mock.module('../src/modules/outbox/relay.ts', () => originalRelay);
  await mock.module('../src/modules/content-publication/eligibility-state.ts', () => originalEligibilityState);
});

beforeEach(() => {
  rangeMock.mockClear();
  proofMock.mockClear();
});

function retainedEvent(sequence: string, ordinal: number, eligible = true) {
  const batchId = `main-batch-${sequence}`;
  return { specversion: '1.0', id: `urn:main:event:${sequence}:${ordinal}`, source: SCOPE,
    type: eligible ? SEARCH_ELIGIBLE : 'com.rezics.work.edited.v1', datacontenttype: 'application/json',
    data: { batchId, sourcePosition: { datasetId: 'product', dataEpoch: GRAPH_EPOCH, sequence: `${42 + ordinal}` },
      routingEpoch: ROUTING_EPOCH, ordinal,
      relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: GRAPH_EPOCH, sequence },
      receipt: eligible ? { id: `urn:main:receipt:${sequence}:${ordinal}`, action: 'content.search-eligibility',
        outcome: 'succeeded', requestDigest: 'c'.repeat(64), resource: 'urn:resource:1', variant: 'urn:variant:1',
        publicationDecision: 'urn:publication:1', eligibilityDecision: 'urn:eligibility:decision', disclosure: 'public' }
        : { id: `urn:main:receipt:${sequence}:${ordinal}` } } };
}

function batch(sequence: string, events: ReturnType<typeof retainedEvent>[]): RetainedRelayBatch {
  return { streamScope: MAIN_RELAY_STREAM_SCOPE, sequence, batchId: `main-batch-${sequence}`,
    routingEpoch: ROUTING_EPOCH, events: events as never };
}

function configureRange(batches: RetainedRelayBatch[], coverageSequence = batches.at(-1)?.sequence ?? '0',
  coverageEpoch = GRAPH_EPOCH) {
  readRange = async (consumer, _after, _limit) => ({ coverage: { streamScope: MAIN_RELAY_STREAM_SCOPE,
    consumer, dataEpoch: coverageEpoch, sequence: coverageSequence }, batches });
}

function fixture() {
  const progress: EligibilityDeliveryProgress = { streamScope: MAIN_RELAY_STREAM_SCOPE,
    graphDataEpoch: GRAPH_EPOCH, contentDataEpoch: CONTENT_EPOCH, sequence: '0' };
  const pages: EligibilityDeliveryPage[] = [];
  let failAfterCommit = false;
  const content = {
    readEligibilityDeliveryProgress: async () => ({ ...progress }),
    ownerPosition: async () => ({ dataEpoch: CONTENT_EPOCH, sequence: '12' }),
    ingestEligibilityDeliveryPage: async (page: EligibilityDeliveryPage) => {
      pages.push(page);
      progress.sequence = page.batches.at(-1)!.sequence;
      const result = { progress: { ...progress }, replayed: false, events: [] };
      if (failAfterCommit) { failAfterCommit = false; throw new Error('response lost after Content commit'); }
      return result;
    },
    loseNextAcknowledgement() { failAfterCommit = true; },
  } as unknown as ContentCore & { loseNextAcknowledgement(): void };
  const env = { lineage: { dataEpoch: GRAPH_EPOCH, routingEpoch: ROUTING_EPOCH } } as WorkActivationEnvironment;
  return { env, content, progress, pages };
}

const noRelayPool = {} as Pool;

test('SEARCH19: retained startup pages preserve irrelevant batches and exact approval pins', async () => {
  const f = fixture();
  configureRange([batch('1', [retainedEvent('1', 0, false)]), batch('2', [retainedEvent('2', 0)])]);
  proofMock.mockImplementation(async () => proof);

  const result = await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'delivery-test');

  expect(result).toMatchObject({ graphDataEpoch: GRAPH_EPOCH, contentDataEpoch: CONTENT_EPOCH,
    sequence: '2', batchCount: 2 });
  expect(f.pages).toHaveLength(1);
  expect(f.pages[0]!.batches.map(page => page.events.length)).toEqual([0, 1]);
  expect(f.pages[0]!.batches[1]!.events[0]!.publication).toEqual({
    preparationId: proof.publication.preparationId, revisionId: proof.revisionId });
  expect(f.pages[0]!.batches[1]!.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(rangeMock).toHaveBeenLastCalledWith(noRelayPool, 'delivery-test', '0', 100);
});

test('SEARCH19: retained delivery stops at the largest whole-batch prefix within 100 events', async () => {
  const f = fixture();
  const first = Array.from({ length: 60 }, (_, ordinal) => retainedEvent('1', ordinal));
  const second = Array.from({ length: 60 }, (_, ordinal) => retainedEvent('2', ordinal));
  configureRange([batch('1', first), batch('2', second)]);
  proofMock.mockImplementation(async () => proof);

  const result = await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'bounded-test');

  expect(result?.sequence).toBe('1');
  expect(f.pages[0]!.batches).toHaveLength(1);
  expect(f.pages[0]!.batches[0]!.events).toHaveLength(60);
  expect(proofMock).toHaveBeenCalledTimes(60);
});

test('qualification withdrawal advances the retained delivery prefix without delivering another positive approval', async () => {
  const f = fixture();
  const withdrawal = { ...retainedEvent('1', 0), type: 'com.rezics.content.search-eligibility-withdrawn.v1' };
  configureRange([batch('1', [withdrawal])]);
  const result = await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'withdrawal-test');
  expect(result?.sequence).toBe('1');
  expect(f.pages[0]!.batches[0]!.events).toEqual([]);
  expect(proofMock).not.toHaveBeenCalled();
});

test('SEARCH20/OPS16: rebuild delivery commits only its frozen retained Main prefix', async () => {
  const f = fixture();
  configureRange([batch('1', []), batch('2', [retainedEvent('2', 0)]), batch('3', [])]);
  proofMock.mockImplementation(async () => proof);
  expect((await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'frozen-test', '2'))
    ?.sequence).toBe('2');
  expect(f.pages).toHaveLength(1);
  expect(f.pages[0]!.batches.map(value => value.events.length)).toEqual([0, 1]);
  expect(f.pages[0]!.batches[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(proofMock).toHaveBeenCalledTimes(1);
  rangeMock.mockClear();
  expect(await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'frozen-test', '2')).toBeNull();
  expect(rangeMock).not.toHaveBeenCalled();
  const empty = fixture();
  configureRange([batch('1', []), batch('2', []), batch('3', [retainedEvent('3', 0)])]);
  proofMock.mockClear();
  expect((await deliverRetainedContentEligibilityOnce(empty.env, empty.content, noRelayPool, 'empty-frozen-test', '2'))
    ?.sequence).toBe('2');
  expect(empty.pages[0]!.batches.map(value => value.events)).toEqual([[], []]);
  expect(proofMock).not.toHaveBeenCalled();
  expect(await deliverRetainedContentEligibilityOnce(empty.env, empty.content, noRelayPool, 'empty-frozen-test', '2')).toBeNull();
  expect(empty.pages).toHaveLength(1);
  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'frozen-test', '0'))
    .rejects.toThrow('delivery cursor exceeds frozen Main frontier');
});

test('SEARCH19: Content commit followed by a lost bridge response resumes after its durable cursor', async () => {
  const f = fixture();
  configureRange([batch('1', []), batch('2', [retainedEvent('2', 0)]), batch('3', [])]);
  proofMock.mockImplementation(async () => proof);
  f.content.loseNextAcknowledgement();

  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'restart-test'))
    .rejects.toThrow('response lost after Content commit');
  expect(f.progress.sequence).toBe('3');
  expect(f.pages[0]!.batches.map(value => value.events.length)).toEqual([0, 1, 0]);
  expect(proofMock).toHaveBeenCalledTimes(1);
  readRange = async (consumer, _after, _limit) => ({ coverage: { streamScope: MAIN_RELAY_STREAM_SCOPE,
    consumer, dataEpoch: GRAPH_EPOCH, sequence: '3' }, batches: [] });
  expect(await deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'restart-test')).toBeNull();
  expect(f.pages).toHaveLength(1);
  expect(rangeMock).toHaveBeenLastCalledWith(noRelayPool, 'restart-test', '3', 100);
});

test('SEARCH19: foreign coverage, damaged positions and unproven receipts never advance Content progress', async () => {
  const f = fixture();
  configureRange([batch('1', [])], '1', '00000000-0000-4000-8000-000000000999');
  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'foreign-test'))
    .rejects.toBeInstanceOf(ContentEligibilityStateUnavailable);

  configureRange([{ ...batch('1', []), batchId: '' }]);
  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'empty-header-test'))
    .rejects.toBeInstanceOf(ContentEligibilityStateUnavailable);

  const damaged = retainedEvent('1', 0);
  damaged.data.relayPosition.sequence = '2';
  configureRange([batch('1', [damaged])]);
  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'damaged-test'))
    .rejects.toBeInstanceOf(ContentEligibilityStateUnavailable);

  configureRange([batch('1', [retainedEvent('1', 0)])]);
  proofMock.mockImplementation(async () => { throw new ContentEligibilityStateUnavailable('receipt proof mismatch'); });
  await expect(deliverRetainedContentEligibilityOnce(f.env, f.content, noRelayPool, 'unproven-test'))
    .rejects.toThrow('receipt proof mismatch');
  expect(f.progress.sequence).toBe('0');
  expect(f.pages).toHaveLength(0);
});
