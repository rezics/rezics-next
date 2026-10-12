import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import { enrichSerialSearch, readSerialStatistics, readSerialSummaries } from '../src/modules/work/summary-serial.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import { searchPageSerial } from '../src/modules/search/result-cards.ts';
import { serialWork, serialId } from './serial-selected-fixture.ts';

function fixture() {
  const state = { count: 2, visible: true, otherCount: 1 };
  const graph = new FusekiClient('http://graph.invalid/serial-consumer');
  graph.query = async () => ({ results: { bindings: [{ work: { type: 'uri', value: serialWork } }] } });
  const deps = { environment: { fuseki: graph }, serialStats: { batch: async () => new Map([
    [serialWork, { chapterCount: state.visible ? state.count : null, wordCount: state.visible ? 480 : null, lastUpdatedAt: null }],
    [serialId(99), { chapterCount: state.otherCount, wordCount: 1, lastUpdatedAt: null }],
  ]) } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/'), {}, { dataEpoch: 'epoch', sequence: '1' });
  return { state, session, deps };
}

for (const consumer of ['summary', 'shared', 'search card'] as const) {
  for (const changed of ['aggregate', 'disclosure'] as const) {
    test(`${consumer} serial facts fence selected ${changed} movement`, async () => {
      const f = fixture();
      if (consumer === 'summary') await readSerialSummaries(f.session, [serialWork]);
      else if (consumer === 'search card') await searchPageSerial(f.session, [serialWork]);
      else await readSerialStatistics(f.session, [serialWork]);
      if (changed === 'aggregate') f.state.count++;
      else f.state.visible = false;
      await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
    });
  }
}

test('shared serial owner fence excludes unrequested rows', async () => {
  const f = fixture(); await readSerialStatistics(f.session, [serialWork]); f.state.otherCount++;
  await f.session.fenceDependencies();
});

test('sessionless serial search rejects owner movement before returning its enriched relation', async () => {
  const f = fixture(); let calls = 0;
  const original = f.deps.serialStats!.batch.bind(f.deps.serialStats);
  f.deps.serialStats!.batch = async (...args) => {
    const values = await original(...args);
    if (++calls === 1) f.state.count++;
    return values;
  };
  await expect(enrichSerialSearch({ resultGrain: 'mainVersion', results: [{ work: serialWork }],
    sourcePosition: { dataEpoch: 'epoch', sequence: '1' } }, f.deps.serialStats)).rejects.toBeInstanceOf(SearchSnapshotMoved);
});
