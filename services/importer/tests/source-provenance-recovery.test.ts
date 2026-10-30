import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

test('source provenance refresh preserves acknowledged proposals through partial receipts and response loss on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-provenance-recovery-'));
  type Result = BatchWriteResult['results'][number];
  const receipts = new Map<string, { bytes: string; result: Result }>();
  const requests: BatchWriteRequest[] = [];
  const effects: BatchCommand[] = [];
  let fault: 'partial' | 'lost' | null = null;
  const transport = {
    async readFence() { return { fenced: false, securityRevision: null }; },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      let refused = false;
      return { results: request.commands.map((command): Result => {
        const prior = receipts.get(command.key);
        if (prior) { expect(JSON.stringify(command)).toBe(prior.bytes); return prior.result; }
        if (fault === 'partial' && command.op === 'retract' && !refused) {
          refused = true;
          return { key: command.key, status: 409, problem: { type: 'conflict', title: 'Synthetic partial receipt', status: 409 } };
        }
        const result: Result = command.op === 'create'
          ? { key: command.key, status: 201, value: { id: randomUUID(), revision: 1 } }
          : command.op === 'propose'
            ? { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } }
            : { key: command.key, status: 200, value: { revision: 1 } };
        effects.push(structuredClone(command));
        receipts.set(command.key, { bytes: JSON.stringify(command), result });
        return result;
      }) };
    },
  };
  const open = () => new Importer({
    path: join(directory, 'state.sqlite'), transport,
    afterBulkSuccess() { if (fault === 'lost') throw new Error('Synthetic response loss before local acknowledgement'); },
  });
  let importer = open();
  const owner = { source: 'bangumi', external_id: '1' };
  const registration = createSourceRegistration('bangumi');
  const run = (date: string) => importer.runDump(registration, (async function* () {
    yield new TextEncoder().encode(JSON.stringify({ id: 1, type: 1, name: 'Same Book', date }) + '\n');
  })());
  try {
    expect((await run('2000-01-01')).status).toBe('committed');
    const baseline = importer.session.store.source('bangumi');
    const claim = importer.session.bindings.claim(owner);
    const initialReceipts = structuredClone([...receipts]);
    const old = importer.session.bindings.candidates(owner, 'facts', { limit: 100 });
    const offset = requests.length;
    fault = 'partial';
    expect((await run('2001-01-01')).status).toBe('bulk-failed');
    expect(importer.session.store.source('bangumi')).toEqual(baseline);
    const plan = requests[offset]!;
    expect(plan.commands.filter((command) => command.op === 'propose')).toHaveLength(2);
    const acknowledged = importer.session.bindings.candidates(owner, 'facts', { limit: 100 }).filter((candidate) => !old.some((prior) => prior.candidate === candidate.candidate));
    expect(acknowledged).toHaveLength(2);
    const runId = importer.session.store.activeRun('bangumi')!.id;
    await importer.close();
    importer = open();
    fault = 'lost';
    expect((await run('2001-01-01')).status).toBe('interrupted');
    expect(importer.session.store.source('bangumi')).toEqual(baseline);
    expect(importer.session.store.activeRun('bangumi')!.id).toBe(runId);
    const uncertain = requests.at(-1)!;
    expect(uncertain.commands).toHaveLength(1);
    expect(uncertain.commands[0]!.op).toBe('retract');
    await importer.close();
    importer = open();
    fault = null;
    expect((await run('2001-01-01')).status).toBe('committed');
    expect(requests.at(-1)).toEqual(uncertain);
    const current = importer.session.bindings.candidates(owner, 'facts', { limit: 100 });
    expect(current).toEqual(acknowledged);
    expect(importer.session.bindings.claim(owner)).toEqual(claim);
    const digest = importer.session.store.key('bangumi', '1').baseline!.digest;
    for (const candidate of current) expect((JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!.source.digest).toBe(digest);
    expect(digest).not.toBe(JSON.parse(old[0]!.bytes).commands[0].source.digest);
    expect(effects.filter((command) => command.op === 'propose')).toHaveLength(4);
    expect(effects.filter((command) => command.op === 'retract').every((command) => old.some((candidate) => candidate.candidate === command.candidate))).toBe(true);
    for (const [key, receipt] of initialReceipts) expect(receipts.get(key)).toEqual(receipt);
    const count = requests.length;
    expect((await run('2001-01-01')).status).toBe('committed');
    expect(requests).toHaveLength(count);
  } finally { await importer.close(); await rm(directory, { recursive: true, force: true }); }
});
