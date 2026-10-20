import { expect, test } from 'bun:test';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import { discoveryGenerationCurrent, discoveryRefreshSourceChanged, DISCOVERY_REFRESH_COST,
  type DiscoveryRefreshStore, type RefreshJob, type RefreshSourceBasis } from '../src/modules/discovery/refresh-store.ts';
import { DISCOVERY_SOURCE_PROFILE } from '../src/modules/discovery/profile.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { invalidWorkReadSource } from '../src/modules/work/read-source-fault.ts';
import { MediaInvalid, MediaUnavailable } from '../src/modules/media/contract.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { AlsoEnjoyedStore } from '../src/modules/also-enjoyed/store.ts';

test('discovery ticks fold co-reader logs on their schedule and advance one build batch every tick', async () => {
  const calls: string[] = [];
  const store = { purge: async () => {}, claim: async () => null } as unknown as DiscoveryRefreshStore;
  const alsoEnjoyed = { purge: async () => { calls.push('purge'); },
    fold: async () => { calls.push('fold'); },
    refresh: async () => { calls.push('refresh'); } } as unknown as AlsoEnjoyedStore;
  const worker = new DiscoveryRefreshWorker({ alsoEnjoyed } as MainWorkDependencies, store, {} as DiscoveryProjection);
  (worker as unknown as { enroll: () => Promise<void> }).enroll = async () => {};
  expect(await worker.tick()).toBe('idle');
  expect(await worker.tick()).toBe('idle');
  expect(calls).toEqual(['purge', 'fold', 'refresh', 'purge', 'refresh']);
});

test('a slow catalog read defers enrollment while the refresh tick still claims a Work', async () => {
  const calls: string[] = [];
  const store = { purge: async () => { calls.push('purge'); },
    claim: async () => { calls.push('claim'); return null; } } as unknown as DiscoveryRefreshStore;
  const worker = new DiscoveryRefreshWorker({} as MainWorkDependencies, store, {} as DiscoveryProjection);
  (worker as unknown as { enroll: () => Promise<void> }).enroll = async () => {
    throw new WorkReadUnavailable('Work read deadline exceeded');
  };
  expect(await worker.tick()).toBe('idle');
  expect(calls).toEqual(['purge', 'claim']);
});

test('a saved discovery generation from the old source query rebuilds at the same relay position', () => {
  const position = { dataEpoch: 'epoch', sequence: '806' };
  const since = { generation: '0', wide: false, statements: [] };
  const prior = { source_epoch: 'epoch', source_sequence: '806',
    recovery_generation: '0', source_profile: null };
  expect(discoveryGenerationCurrent(prior, position, since)).toBe(false);
  expect(discoveryGenerationCurrent({ ...prior, source_profile: DISCOVERY_SOURCE_PROFILE },
    position, since)).toBe(true);
});

test('a judged Statement or a wide Access change folded after the basis outdates the generation', () => {
  const position = { dataEpoch: 'epoch', sequence: '806' };
  const prior = { source_epoch: 'epoch', source_sequence: '806',
    recovery_generation: '0', source_profile: DISCOVERY_SOURCE_PROFILE };
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '0', wide: false, statements: ['https://rezics.com/id/statement'] })).toBe(false);
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '0', wide: true, statements: [] })).toBe(false);
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '1', wide: false, statements: [] })).toBe(false);
});

const sourceBasis: RefreshSourceBasis = { dataEpoch: 'epoch', sequence: '1', graphVersion: null,
  accessRevision: '0', recoveryGeneration: '0', sourceProfile: DISCOVERY_SOURCE_PROFILE };

test('quarantine rearms for graph repairs, receipted changes, Access changes, recovery and a new projector', () => {
  expect(discoveryRefreshSourceChanged(sourceBasis, { ...sourceBasis })).toBe(false);
  for (const changed of [{ dataEpoch: 'restored' }, { sequence: '2' }, { graphVersion: 'repaired' },
    { accessRevision: '1' }, { recoveryGeneration: '1' }, { sourceProfile: 'revised' }])
    expect(discoveryRefreshSourceChanged(sourceBasis, { ...sourceBasis, ...changed })).toBe(true);
});

/** Real workRead and projection source path, with only owner/transport doubles.
 * The native integration regression separately exercises the durable owners. */
function refusedSource(mode: 'invalid' | 'limit' | 'invalid-basis' | 'missing-basis' | 'inactive' | 'unavailable' | 'moved' | 'probe-unavailable' | 'media-invalid' | 'media-unavailable' | 'media-moved') {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const field = (value: string) => ({ type: 'literal', value });
  const job: RefreshJob = { scope_key: 'a'.repeat(64), basis: {
    scope: mode === 'invalid-basis' ? 'realm' : 'global', realm: null,
    context: mode === 'missing-basis' ? `${work}-context` : null, owner: null }, generation_id: 'pending',
    lease_epoch: '1', attempts: '2', ...(mode === 'probe-unavailable' ? {
      quarantine_basis: sourceBasis, quarantine_reason: 'basis-invalid' as const,
      last_error: 'Discovery source is ambiguous' } : {}) };
  const finishes: Parameters<DiscoveryRefreshStore['finish']>[] = [];
  let released = 0, sourceReads = 0, candidateReads = 0;
  const row = { generation_id: 'pending', complete: false, checkpoint: '', source_sequence: '1', population_sequence: '1' };
  const store = { purge: async () => 0, catalog: async () => null, claim: async () => job,
    inspect: async () => ({ fresh: false, row, principal: null, sourceBasis, inactive: mode === 'inactive' }),
    attach: async () => {}, finish: async (...args: Parameters<DiscoveryRefreshStore['finish']>) => { finishes.push(args); },
  } as unknown as DiscoveryRefreshStore;
  const projection = { beginStep: async () => ({ lease: 'step' }),
    releaseStep: async () => { released++; } } as unknown as DiscoveryProjection;
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, fuseki: {
    query: async (sparql: string) => {
      if (mode === 'probe-unavailable') throw new WorkReadUnavailable('Graph is unavailable');
      if (sparql.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [
        { epoch: field('epoch'), sequence: field('1') }] } };
      if (sparql === 'ASK {}') return { boolean: true };
      if (sparql.includes('SELECT ?context WHERE')) return { results: { bindings: [] } };
      if (sparql.includes('SELECT ?epoch ?prior')) return { results: { bindings: [] } };
      if (sparql.includes('SELECT DISTINCT ?work WHERE')) {
        candidateReads++;
        if (mode === 'unavailable') throw new WorkReadUnavailable('Transport is unavailable');
        return { results: { bindings: mode === 'media-moved' && candidateReads > 1 ? [] : [{ work: field(work) }] } };
      }
      if (sparql.includes('SELECT DISTINCT ?work ?head')) {
        sourceReads++;
        if (mode === 'media-invalid' || mode === 'media-moved') throw new MediaInvalid('resource summary request is invalid');
        if (mode === 'media-unavailable') throw new MediaUnavailable('Summary media owner is unavailable');
        return { results: { bindings: mode === 'moved' && sourceReads > 1 ? [] : (mode === 'limit' ? ['9223372036854775808'] : ['1', '2']).map(sequence => ({
          work: field(work), head: field(`${work}-head`), main: field(`${work}-main`),
          sequence: field(sequence), epochOrder: field('0'), classified: field('false'), credited: field('false'),
        })) } };
      }
      throw new Error(`Unexpected fixture query: ${sparql}`);
    } } }, access: { assertRecoveryOpen: async () => {} },
    relayPosition: { read: async () => ({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '1' }) },
  } as unknown as MainWorkDependencies;
  return { worker: new DiscoveryRefreshWorker(deps, store, projection), finishes,
    released: () => released };
}

test('stable malformed source evidence is quarantined after the closing fences and releases its step', async () => {
  const fixture = refusedSource('invalid');
  expect(await fixture.worker.tick()).toBe('basis-invalid');
  expect(fixture.finishes[0]!.slice(1)).toEqual(['pending', 'basis-invalid', expect.any(Number),
    DISCOVERY_REFRESH_COST.maximumRetryMs,
    { basis: sourceBasis, reason: 'basis-invalid', error: 'Discovery source is ambiguous' }]);
  expect(fixture.released()).toBe(1);
  expect(invalidWorkReadSource('ambiguous')).toBeInstanceOf(WorkReadUnavailable);
});

test('transport failure preserves the checkpoint and exponential transient backoff', async () => {
  const fixture = refusedSource('unavailable');
  expect(await fixture.worker.tick()).toBe('retry');
  expect(fixture.finishes[0]!.slice(1)).toEqual(['pending', 'retry', expect.any(Number), 60_000, undefined]);
  expect(fixture.released()).toBe(1);
});

test('a moved closing fence cannot quarantine apparently malformed source evidence', async () => {
  const fixture = refusedSource('moved');
  expect(await fixture.worker.tick()).toBe('retry');
  expect(fixture.finishes[0]![4]).toBe(DISCOVERY_REFRESH_COST.intervalMs);
  expect(fixture.finishes[0]![5]).toBeUndefined();
  expect(fixture.released()).toBe(1);
});

test('a probe outage retains the original quarantine instead of rearming full work', async () => {
  const fixture = refusedSource('probe-unavailable');
  expect(await fixture.worker.tick()).toBe('retry');
  expect(fixture.finishes[0]![5]).toEqual({ basis: sourceBasis, reason: 'basis-invalid',
    error: 'Discovery source is ambiguous' });
});

test('D5004C02: a stable MediaInvalid records its diagnostic and releases the projection lease', async () => {
  const fixture = refusedSource('media-invalid');
  expect(await fixture.worker.tick()).toBe('basis-invalid');
  expect(fixture.finishes[0]!.slice(1)).toEqual(['pending', 'basis-invalid', expect.any(Number),
    DISCOVERY_REFRESH_COST.maximumRetryMs,
    { basis: sourceBasis, reason: 'basis-invalid', error: 'resource summary request is invalid' }]);
  expect(fixture.released()).toBe(1);
});

test('D5004C02: MediaUnavailable remains transient and keeps exponential backoff', async () => {
  const fixture = refusedSource('media-unavailable');
  expect(await fixture.worker.tick()).toBe('retry');
  expect(fixture.finishes[0]!.slice(1)).toEqual(['pending', 'retry', expect.any(Number), 60_000, undefined]);
  expect(fixture.released()).toBe(1);
});

test('D5004C02: a moved closing source fence prevents a MediaInvalid quarantine', async () => {
  const fixture = refusedSource('media-moved');
  expect(await fixture.worker.tick()).toBe('retry');
  expect(fixture.finishes[0]![4]).toBe(DISCOVERY_REFRESH_COST.intervalMs);
  expect(fixture.finishes[0]![5]).toBeUndefined();
  expect(fixture.released()).toBe(1);
});

for (const [mode, outcome, diagnostic, released] of [
  ['limit', 'basis-invalid', 'Discovery recency exceeds its order domain', 1],
  ['invalid-basis', 'basis-invalid', 'Realm requires its Realm; Mine requires a standing rating Context', 0],
  ['missing-basis', 'basis-unavailable', 'Rating Context is unavailable', 0],
  ['inactive', 'inactive', 'Reader is inactive', 0],
] as const) {
  test(`${mode} records its diagnosed disposition without advancing the checkpoint`, async () => {
    const fixture = refusedSource(mode);
    expect(await fixture.worker.tick()).toBe(outcome);
    expect(fixture.finishes[0]!.slice(1)).toEqual(['pending', outcome, expect.any(Number),
      DISCOVERY_REFRESH_COST.maximumRetryMs, { basis: sourceBasis, reason: outcome, error: diagnostic }]);
    expect(fixture.released()).toBe(released);
  });
}
