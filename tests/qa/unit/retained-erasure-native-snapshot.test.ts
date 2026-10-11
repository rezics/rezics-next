import { expect, test } from 'bun:test';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { assertRetainedErasureNativeSnapshotMatches,
  type RetainedErasureNativeSnapshot } from '../fault-recovery/retained-erasure-recovery-fixture.ts';

const sourceCut: RetainedErasureNativeSnapshot['sourceCut'] = {
  dataEpoch: 'data-epoch-1',
  routingEpoch: 'routing-epoch-1',
  sequence: '31',
  relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'data-epoch-1', sequence: '47' },
};

test('a retained native snapshot matches only its complete graph and Main source cut', () => {
  const snapshot: RetainedErasureNativeSnapshot = { volume: 'immutable-native-cut', sourceCut };
  expect(() => assertRetainedErasureNativeSnapshotMatches(sourceCut, snapshot)).not.toThrow();

  const changedCuts: RetainedErasureNativeSnapshot['sourceCut'][] = [
    { ...sourceCut, sequence: '32' },
    { ...sourceCut, routingEpoch: 'routing-epoch-2' },
    { ...sourceCut, dataEpoch: 'data-epoch-2', relay: { ...sourceCut.relay, dataEpoch: 'data-epoch-2' } },
    { ...sourceCut, relay: { ...sourceCut.relay, streamScope: 'urn:rezics:relay:other' } },
    { ...sourceCut, relay: { ...sourceCut.relay, sequence: '48' } },
  ];

  for (const changedCut of changedCuts) {
    expect(() => assertRetainedErasureNativeSnapshotMatches(changedCut, snapshot))
      .toThrow('source graph cut changed before native snapshot reuse');
  }
});
