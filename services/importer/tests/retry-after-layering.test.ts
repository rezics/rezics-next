import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportPipelineDriver, type WriteSimulation } from './pipeline-driver.ts';

const rows = [
  { key: '1', revision: 1 },
  { key: '2', revision: 1 },
];
const bootstrapA = (request: { commands: { op: string; source: { external_id: string } }[] }) =>
  request.commands[0]!.source.external_id === '1' && request.commands.every((command) => command.op === 'create');

for (const status of [429, 503]) {
  for (const form of ['seconds', 'date']) {
    test(`retry-after survives the final transport response without an early coordinator send (${status}, ${form})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'retry-layer-'));
      let sends = 0;
      let notBefore = 0;
      const times: number[] = [];
      const writes: WriteSimulation = {
        limit: Infinity,
        http: { maxAttempts: 2 },
        invocations: [],
        attempts: [],
        accepted: new Map(),
        onSend(request, at) {
          if (request.commands[0]!.source.external_id === '2') return { delayMs: 1500 };
          if (!bootstrapA(request)) return;
          times.push(at);
          if (++sends === 1) return { status, delayMs: 1 };
          if (sends === 2) {
            notBefore = form === 'seconds' ? at + 1 + 5000 : Math.ceil((at + 1 + 5000) / 1000) * 1000;
            return { status, delayMs: 1, retryAfter: form === 'seconds' ? '5' : new Date(notBefore).toUTCString() };
          }
        },
      };
      const driver = await createImportPipelineDriver({ directory, writes, recordConcurrency: 2 });
      try {
        const report = await driver.run(rows);
        expect(times).toHaveLength(3);
        expect(times[2]!).toBeGreaterThanOrEqual(notBefore);
        expect(writes.invocations!.filter((call) => bootstrapA(JSON.parse(call.bytes)))).toHaveLength(2);
        expect(report.result.status).toBe('committed');
        expect(report.peakRecords).toBeLessThanOrEqual(2);
        expect((await driver.effects()).duplicateEffects).toBe(0);
      } finally {
        await driver.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  for (const cap of ['per-wait', 'total', 'deadline', 'unrepresentable'] as const) {
    test(`oversized retry-after leaves durable unresolved work without retrying early (${status}, ${cap})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'retry-refusal-'));
      let sends = 0;
      const writes: WriteSimulation = {
        limit: Infinity,
        invocations: [],
        attempts: [],
        accepted: new Map(),
        http:
          cap === 'total'
            ? { maxAttempts: 2, maxTotalWaitMs: 1000 }
            : cap === 'deadline'
              ? { maxAttempts: 1, deadlineMs: 1500 }
              : { maxAttempts: 1 },
        onSend(request) {
          if (!bootstrapA(request)) return { delayMs: 100 };
          sends++;
          if (cap === 'total' && sends === 1) return { status, delayMs: 1 };
          if (sends <= (cap === 'total' ? 2 : 1))
            return {
              status,
              delayMs: 1,
              retryAfter:
                cap === 'unrepresentable'
                  ? '999999999999999999999'
                  : cap === 'per-wait'
                    ? '31'
                    : cap === 'deadline'
                      ? '2'
                      : '1',
            };
        },
      };
      const driver = await createImportPipelineDriver({ directory, writes, recordConcurrency: 2 });
      try {
        const report = await driver.run(rows);
        expect(report.result.status).toBe('bulk-failed');
        expect(sends).toBe(cap === 'total' ? 2 : 1);
        expect(writes.invocations!.filter((call) => bootstrapA(JSON.parse(call.bytes)))).toHaveLength(1);
        expect(report.records.find((record) => record.recordKey === '1')!.acknowledged).toBe(false);
        const database = new Database(join(directory, 'imports.sqlite'), { readonly: true });
        try {
          expect(database.query("SELECT acknowledgement FROM binding_journal WHERE external_id='1'").get()).toEqual({
            acknowledgement: null,
          });
          expect(database.query("SELECT state FROM binding_records WHERE external_id='1'").get()).toEqual({
            state: 'pending',
          });
        } finally {
          database.close();
        }
        expect(report.activeRequestsAtEnd).toBe(0);
      } finally {
        await driver.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
