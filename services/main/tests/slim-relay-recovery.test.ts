import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import type { RelayCoverage } from '../src/modules/outbox/relay.ts';
import { assertGraphRecoveryRelayCut, assertRecoveryCoverage, assertRetainedRecoveryRelayCut,
  readGraphRecoverySource, RestoreLineageConflict, type GraphRecoverySource,
  type RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const source: GraphRecoverySource = {
  dataEpoch: epoch, routingEpoch: '1', sequence: '900',
  relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: epoch, sequence: '4' },
};
const relay: RelayCoverage = {
  consumer: 'product', streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: epoch,
  sequence: '4', batchCount: '4', batchDigest: digest, eventCount: '7', eventDigest: digest,
};
function coverage(): RecoveryCoverage {
  return {
    priorDataEpoch: epoch, priorSequence: '900',
    accountPg: { systemIdentifier: '1', flushedLsn: '0/10', walFile: '000000010000000000000001' },
    account: { rowCount: '0', rowDigest: digest },
    accessOutboxCount: '0', accessOutboxDigest: digest,
    accessStateCount: '0', accessStateDigest: digest,
    relay: { ...relay }, commerce: { version: 1, tables: {} as RecoveryCoverage['commerce']['tables'] },
  };
}
const literal = (value: string) => ({ type: 'literal', value });
const sourceRow = () => ({ epoch: literal(epoch), routing: literal('1'), sequence: literal('900'),
  streamEpoch: literal(epoch), streamSequence: literal('4') });
function graphResult(rows: NonNullable<SparqlResult['results']>['bindings']): FusekiClient {
  const graph = new FusekiClient('http://unused.invalid/rezics');
  graph.query = async () => ({ results: { bindings: rows } });
  return graph;
}

test('Recovery captures graph diagnostic 900 and acknowledged Main cut 4 independently', async () => {
  const captured = await readGraphRecoverySource(graphResult([sourceRow()]));
  expect(captured).toEqual(source);
  expect(() => assertGraphRecoveryRelayCut(captured, relay)).not.toThrow();
  expect(() => assertGraphRecoveryRelayCut(captured, { ...relay, sequence: '900', batchCount: '900' }))
    .toThrow(RestoreLineageConflict);
});

test('Recovery source refuses missing, ambiguous, malformed or foreign-epoch Main counters', async () => {
  const invalidSnapshots: NonNullable<SparqlResult['results']>['bindings'][] = [[], [sourceRow(), sourceRow()],
    [{ epoch: literal(epoch), routing: literal('1'), sequence: literal('900') }],
    [{ ...sourceRow(), streamEpoch: literal('another-epoch') }],
    [{ ...sourceRow(), streamSequence: literal('-1') }],
    [{ ...sourceRow(), sequence: literal('invalid') }]];
  for (const rows of invalidSnapshots) {
    await expect(readGraphRecoverySource(graphResult(rows))).rejects.toBeInstanceOf(RestoreLineageConflict);
  }
});

test('Source admission requires the complete matching scoped Main relay frontier', () => {
  for (const changed of [
    { streamScope: 'urn:rezics:stream:content' }, { dataEpoch: 'another-epoch' },
    { sequence: '3', batchCount: '3' }, { sequence: '5', batchCount: '5' },
    { batchCount: '900' }, { batchDigest: 'invalid' }, { eventDigest: 'invalid' },
  ]) {
    expect(() => assertGraphRecoveryRelayCut(source, { ...relay, ...changed })).toThrow(RestoreLineageConflict);
  }
  expect(() => assertGraphRecoveryRelayCut({ ...source,
    relay: { ...source.relay, streamScope: 'urn:rezics:stream:content' } }, relay)).toThrow(RestoreLineageConflict);
});

test('Signed release coverage preserves different diagnostic and Main cuts', () => {
  const key = '11'.repeat(32);
  const signed = JSON.stringify(sealRecoveryPayload(coverage(), key, 'graph-recovery-coverage'));
  const retained = openRecoveryPayload<RecoveryCoverage>(signed, key, 'graph-recovery-coverage');
  expect(retained.priorSequence).toBe('900');
  expect(retained.relay.sequence).toBe('4');
  expect(() => assertRecoveryCoverage(retained)).not.toThrow();
  expect(() => assertRetainedRecoveryRelayCut(retained, relay)).not.toThrow();
  expect(() => assertRecoveryCoverage({ ...retained, relay: { ...relay, batchCount: '900' } }))
    .toThrow(RestoreLineageConflict);
  expect(() => assertRecoveryCoverage({ ...retained, relay: { ...relay, streamScope: 'urn:rezics:stream:content' } }))
    .toThrow(RestoreLineageConflict);
  expect(() => assertRecoveryCoverage({ ...retained, relay: { ...relay, dataEpoch: 'another-epoch' } }))
    .toThrow(RestoreLineageConflict);
});

test('Release refuses another scope, consumer, epoch, position or retained delivery bytes', () => {
  const retained = coverage();
  for (const changed of [
    { streamScope: 'urn:rezics:stream:content' }, { consumer: 'another-consumer' },
    { dataEpoch: 'another-epoch' }, { sequence: '900', batchCount: '900' },
    { sequence: '3', batchCount: '3' }, { batchCount: '3' },
    { batchDigest: 'b'.repeat(64) }, { eventCount: '6' }, { eventDigest: 'b'.repeat(64) },
  ]) {
    expect(() => assertRetainedRecoveryRelayCut(retained, { ...relay, ...changed })).toThrow(RestoreLineageConflict);
  }
});
