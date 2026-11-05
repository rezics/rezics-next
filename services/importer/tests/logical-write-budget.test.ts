import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportPipelineDriver, type WriteSimulation } from './pipeline-driver.ts';

const rows = (neighbors: number) =>
  Array.from({ length: neighbors + 1 }, (_, i) => ({ key: String(i + 1), revision: 1, cover: true }));
const isLaterA = (bytes: string) => {
  const request = JSON.parse(bytes);
  return (
    request.commands[0].source.external_id === '1' &&
    request.commands.some(
      (c: { op: string; source: { field_group: string } }) => c.op !== 'create' && c.source.field_group !== 'cover',
    )
  );
};

// A remains in flight while B succeeds and restores width two. Every invocation
// also renews once after 401, so counted calls and physical sends differ.
function alternating(): WriteSimulation {
  let physical = 0;
  return {
    limit: Infinity,
    http: { maxAttempts: 1 },
    invocations: [],
    attempts: [],
    accepted: new Map(),
    onSend(request) {
      if (!isLaterA(JSON.stringify(request))) return;
      return { status: ++physical % 2 ? 401 : 429, delayMs: physical % 2 ? 1 : 50 };
    },
  };
}

export function pendingBytes(directory: string): string[] {
  const database = new Database(join(directory, 'imports.sqlite'), { readonly: true });
  try {
    return (
      database.query("SELECT bytes FROM run_envelopes WHERE record_key='1' AND pending=1").all() as { bytes: string }[]
    ).map((row) => row.bytes);
  } finally {
    database.close();
  }
}

for (const neighbors of [16, 64, 256]) {
  test(`unrelated successes cannot refill a failing logical write budget (${neighbors} neighbors)`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'logical-write-'));
    const writes = alternating();
    const driver = await createImportPipelineDriver({ directory, writes, recordConcurrency: 2, media: 'available' });
    try {
      const report = await driver.run(rows(neighbors));
      const invocations = writes.invocations!.filter((call) => isLaterA(call.bytes));
      expect(invocations.length).toBe(8);
      const keys = JSON.parse(invocations[0]!.bytes).commands.map((c: { key: string }) => c.key);
      const physical = writes.attempts.filter((attempt) => attempt.keys.some((key) => keys.includes(key)));
      expect(physical).toHaveLength(16); // A+1 physical sends for each of eight calls.
      expect(new Set(invocations.map((call) => call.bytes)).size).toBe(1);
      expect(report.result.status).toBe('bulk-failed');
      expect(report.records.find((record) => record.recordKey === '1')!.acknowledged).toBe(false);
      expect(report.records.filter((record) => record.recordKey !== '1').every((record) => record.acknowledged)).toBe(
        true,
      );
      expect(pendingBytes(directory)).toEqual([invocations[0]!.bytes]);
      expect(report.peakRecords).toBeLessThanOrEqual(2);
      expect(report.activeRequestsAtEnd).toBe(0);
      expect((await driver.effects()).duplicateEffects).toBe(0);
    } finally {
      await driver.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('prior completed effects and exact envelope identities survive retry exhaustion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'logical-resume-'));
  const writes = alternating();
  const driver = await createImportPipelineDriver({ directory, writes, recordConcurrency: 2, media: 'available' });
  try {
    const report = await driver.run(rows(64));
    expect(report.result.status).toBe('bulk-failed');
    const original = writes.invocations!.filter((call) => isLaterA(call.bytes));
    expect(original).toHaveLength(8);
    const earlier = report.exchanges.filter(
      (exchange) =>
        exchange.recordKey === '1' &&
        (exchange.kind === 'media-post' ||
          (exchange.kind === 'bulk' && exchange.request!.commands.every((command) => command.op === 'create'))),
    );
    expect(earlier.map((exchange) => exchange.kind).sort()).toEqual(['bulk', 'media-post']);
    expect(pendingBytes(directory)).toEqual([original[0]!.bytes]);
    const effects = await driver.effects();
    delete writes.onSend;
    const resumeStart = writes.invocations!.length;
    await driver.reopen();
    const resumed = await driver.run(rows(64).map((row) => ({ ...row, revision: 2 })));
    expect(resumed.result.status).toBe('committed');
    const replay = writes.invocations![resumeStart]!;
    expect(replay.recordKey).toBe('1');
    expect(replay.bytes).toBe(original[0]!.bytes);
    expect(resumed.records.every((record) => record.acknowledged)).toBe(true);
    expect(resumed.exchanges.filter((exchange) => exchange.kind === 'media-post')).toHaveLength(0);
    expect(
      resumed.exchanges.filter(
        (exchange) =>
          exchange.kind === 'bulk' && exchange.request!.commands.every((command) => command.op === 'create'),
      ),
    ).toHaveLength(0);
    expect((await driver.effects()).subjects).toBe(effects.subjects);
    expect((await driver.effects()).duplicateEffects).toBe(0);
  } finally {
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
