import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { backfillOccurrenceLabels, OccurrenceLabelProjectionStalled, projectOccurrenceLabelsOnce,
  type OccurrenceLabelProgress } from '../src/modules/structure/label-index-backfill.ts';
import { OccurrenceLabelWorker } from '../src/modules/structure/label-index-worker.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ type: 'literal', value });
function fixture() {
  const generation = id(), revision = id(), textGeneration = `urn:rezics:text-index-generation:${randomUUID()}`;
  const row = { generation: binding(generation), revision: binding(revision), checkpoint: binding('1'),
    build: binding(revision), targetText: binding(textGeneration), textGeneration: binding(textGeneration) };
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async () => ({ results: { bindings: [row] } }),
    commandWithReceipt: async () => ({ status: 'committed', position: { dataEpoch: 'epoch', sequence: '2' } }),
  } } as unknown as WorkActivationEnvironment;
  return { generation, revision, textGeneration, row, env };
}

test('G1056: rebuild initialization and its revisited checkpoint have distinct receipts after restart', async () => {
  const { env, row, generation } = fixture();
  row.targetText = binding(`urn:rezics:text-index-generation:${randomUUID()}`);
  const receipts: string[] = [], progress: OccurrenceLabelProgress[] = [];
  let phase: 'initialize' | 'project' | 'current' = 'initialize';
  env.fuseki.query = async query => ({ results: { bindings: query.includes('occurrenceProjectedCount')
    ? [{ count: binding('0') }] : phase === 'current' ? [] : [row] } });
  env.fuseki.commandWithReceipt = async request => {
    receipts.push(request.receipt);
    if (phase === 'initialize') {
      expect(request.update).not.toContain('rv:occurrenceSearchRevision');
      row.checkpoint = binding('0'); row.targetText = row.textGeneration; phase = 'project';
    } else {
      expect(request.update).toContain('rv:occurrenceSearchRevision');
      if (row.checkpoint.value === '1') phase = 'current';
      row.checkpoint = binding(String(Number(row.checkpoint.value) + 1));
    }
    return { status: 'committed', position: { datasetId: 'dataset', dataEpoch: 'epoch', sequence: '2' } };
  };
  await projectOccurrenceLabelsOnce(env, { generation, onProgress: item => progress.push(item) });
  // Recreate the client environment from its durable cursor, retaining receipts.
  expect(await backfillOccurrenceLabels({ ...env }, { generation, onProgress: item => progress.push(item) }))
    .toMatchObject({ batches: 2, indexed: 0 });
  expect(new Set(receipts).size).toBe(3);
  expect(progress.map(item => [item.action, item.checkpoint, item.nextCheckpoint])).toEqual([
    ['initialize', '1', '0'], ['project', '0', '1'], ['project', '1', '2'],
  ]);
});

test('G1056: unchanged rejected guards surface the exact stuck item, while concurrent movement retries', async () => {
  const { env, row, generation, revision, textGeneration } = fixture();
  let unchanged = true, queries = 0;
  env.fuseki.query = async query => {
    queries++;
    return query.includes('ASK') ? { boolean: unchanged } : { results: { bindings: [row] } };
  };
  env.fuseki.commandWithReceipt = async () => ({ status: 'guard-unmatched' });
  try {
    await projectOccurrenceLabelsOnce(env);
    throw new Error('expected a stalled projection');
  } catch (error) {
    expect(error).toBeInstanceOf(OccurrenceLabelProjectionStalled);
    expect((error as OccurrenceLabelProjectionStalled).projection).toMatchObject({
      generation, revision, textGeneration, checkpoint: '1', action: 'project',
    });
    expect((error as Error).message).toContain('unchanged checkpoint');
    expect((error as Error).message).toContain(generation);
  }
  expect(queries).toBe(2);
  unchanged = false;
  expect(await projectOccurrenceLabelsOnce(env)).toBe(true);
  expect(queries).toBe(4);
});

test('G1056: a replay without a bounded proof reports its receipt and emits no successful progress', async () => {
  const { env, row } = fixture();
  const progress: OccurrenceLabelProgress[] = [];
  env.fuseki.query = async query => ({ results: { bindings: query.includes('occurrenceProjectedCount') ? [] : [row] } });
  await expect(projectOccurrenceLabelsOnce(env, { onProgress: item => progress.push(item) }))
    .rejects.toThrow('no bounded receipt proof');
  expect(progress).toEqual([]);
});

test('G1056: restore lineage changes cannot reuse an earlier projection receipt', async () => {
  const { env, row } = fixture();
  const receipts: string[] = [];
  env.fuseki.query = async query => ({ results: { bindings: query.includes('occurrenceProjectedCount')
    ? [{ count: binding('0') }] : [row] } });
  env.fuseki.commandWithReceipt = async request => {
    receipts.push(request.receipt);
    return { status: 'committed', position: { datasetId: 'dataset', dataEpoch: env.lineage.dataEpoch, sequence: '2' } };
  };
  await projectOccurrenceLabelsOnce(env);
  env.lineage.dataEpoch = 'restored-epoch';
  await projectOccurrenceLabelsOnce(env);
  env.lineage.routingEpoch = 'restored-routing';
  await projectOccurrenceLabelsOnce(env);
  expect(new Set(receipts).size).toBe(3);
});

test('G1056: the background worker logs bounded progress and starts again after stop', async () => {
  const { env, row } = fixture();
  let pending = true, commands = 0;
  env.fuseki.query = async query => ({ results: { bindings: query.includes('occurrenceProjectedCount')
    ? [{ count: binding('1') }] : pending ? [row] : [] } });
  env.fuseki.commandWithReceipt = async () => {
    pending = false; commands++;
    return { status: 'committed', position: { datasetId: 'dataset', dataEpoch: 'epoch', sequence: '2' } };
  };
  const logs: string[] = [], log = console.info;
  console.info = line => { logs.push(String(line)); };
  const worker = new OccurrenceLabelWorker(env, 2);
  try {
    for (let run = 1; run <= 2; run++) {
      pending = true;
      worker.start();
      for (let wait = 0; commands < run && wait < 100; wait++) await Bun.sleep(2);
      await worker.stop();
      expect(commands).toBe(run);
    }
  } finally { await worker.stop(); console.info = log; }
  expect(logs.map(line => JSON.parse(line))).toEqual(Array.from({ length: 2 }, () =>
    expect.objectContaining({ event: 'occurrence_label_projection_progress',
      generation: row.generation.value, checkpoint: '1', nextCheckpoint: '2', projected: 1 })));
});
