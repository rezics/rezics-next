import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli, type ImportCliOptions } from '../src/cli.ts';
import { createImporter, type ImporterOptions } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

// Local construction/cancellation proof only. The frozen kernel case owns native rate acceptance.
async function withInput(run: (argv: string[], state: string) => Promise<void>, input = '') {
  const directory = await mkdtemp('/dev/shm/import-cli-boundary-');
  try {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const keyPath = join(directory, 'operator.jwk');
    await writeFile(
      keyPath,
      JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', key.privateKey)), kid: 'operator', alg: 'ES256' }),
      { mode: 0o600 },
    );
    const dump = join(directory, 'empty.jsonl');
    const state = join(directory, 'state.sqlite');
    await writeFile(dump, input, { mode: 0o600 });
    await writeFile(state, '', { mode: 0o600 });
    await run(
      [
        '--source',
        'bangumi',
        '--dump',
        dump,
        '--state',
        state,
        '--api',
        'https://kernel.test',
        '--auth',
        'https://auth.test',
        '--account-key',
        keyPath,
        '--account',
        '00000000-0000-4000-8000-000000000001',
        '--client',
        'operator',
      ],
      state,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const noNetwork = (async () => {
  throw new Error('Unexpected network request');
}) as unknown as typeof fetch;

test('CLI construction preserves the real coordinator, durable completion and shared retry clock', async () => {
  await withInput(async (argv, state) => {
    let now = 1000;
    const waits: number[] = [];
    let holdWait = false;
    let constructed: ImporterOptions | undefined;
    const options: ImportCliOptions = {
      clock: {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          if (holdWait) await new Promise<void>(() => {});
          now += ms;
        },
      },
      fetch: noNetwork,
      createImporter(input) {
        constructed = input;
        return createImporter(input);
      },
    };
    const result = await runImportCli(argv, options);
    expect(result.code, result.stderr).toBe(0);
    expect(result.openHandles).toBe(0);
    expect(constructed?.path).toBe(state);
    expect(constructed?.mediaResolver).toBeDefined();
    expect(constructed!.now!()).toBe(now);
    await constructed!.sleep!(17, new AbortController().signal);
    expect(waits).toEqual([17]);
    expect(constructed!.now!()).toBe(1017);
    const aborted = new AbortController();
    aborted.abort(new Error('cancelled wait'));
    await expect(constructed!.sleep!(29, aborted.signal)).rejects.toThrow('cancelled wait');
    expect(waits).toEqual([17]);
    holdWait = true;
    const interrupted = new AbortController();
    const waiting = constructed!.sleep!(31, interrupted.signal);
    await Promise.resolve();
    expect(waits).toEqual([17, 31]);
    interrupted.abort(new Error('interrupted active wait'));
    await expect(waiting).rejects.toThrow('interrupted active wait');
    expect(constructed!.now!()).toBe(1017);
    const session = new ImportSession(state);
    try {
      expect(session.store.source('bangumi').count).toBe(0);
      expect(session.store.source('bangumi').generation).not.toBeNull();
      expect(session.store.activeRun('bangumi')).toBeNull();
    } finally {
      session.close();
    }
  });
});

test('a construction failure closes the opened dump and keeps private diagnostics out of CLI output', async () => {
  await withInput(async (argv) => {
    const result = await runImportCli(argv, {
      fetch: noNetwork,
      createImporter() {
        throw new Error('PRIVATE_FACTORY_FAILURE');
      },
    });
    expect(result.code).toBe(1);
    expect(result.openHandles).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_FACTORY_FAILURE');
  });
});

test('ordinary CLI seals supplied rows and feeds retryable command failures into adaptive backpressure', async () => {
  const input =
    Array.from({ length: 8 }, (_, index) =>
      JSON.stringify({ id: index + 1, type: 2, name: `Backpressure record ${index + 1}` }),
    ).join('\n') + '\n';
  await withInput(async (argv, state) => {
    let activeCreates = 0;
    let peakCreates = 0;
    let createAttempts = 0;
    const receipts = new Map<string, BatchWriteResult['results'][number]>();
    const commandBodies = new Map<string, string>();
    const metadata = sourceRecordMetadataFixture();
    const seals: { supplied: number; status: string }[] = [];
    const options: ImportCliOptions = {
      fetch: noNetwork,
      createImporter(inputOptions) {
        const transport = {
          ...inputOptions.transport,
          setSourceRecordMetadata: metadata.setSourceRecordMetadata,
          async readFence() {
            return { fenced: false as const, securityRevision: null };
          },
          async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
            const results: BatchWriteResult['results'] = [];
            for (const command of request.commands) {
              const serialized = JSON.stringify(command);
              const priorBody = commandBodies.get(command.key);
              if (priorBody !== undefined) expect(serialized).toBe(priorBody);
              else commandBodies.set(command.key, serialized);
              const prior = receipts.get(command.key);
              if (prior) {
                results.push(prior);
                continue;
              }
              if (command.op === 'create') {
                createAttempts++;
                activeCreates++;
                peakCreates = Math.max(peakCreates, activeCreates);
                const cohort = activeCreates;
                await new Promise<void>((resolve) => setTimeout(resolve, 2));
                activeCreates--;
                if (cohort > 1) {
                  const problem = {
                    type: 'https://rezics.com/problems/transaction_retry_exhausted',
                    title: 'Transaction Retry Exhausted',
                    status: 503,
                    code: 'transaction_retry_exhausted',
                    retryable: true,
                  };
                  results.push({
                    key: command.key,
                    status: 503,
                    problem,
                  });
                  continue;
                }
                const accepted = {
                  key: command.key,
                  status: 201 as const,
                  value: { id: crypto.randomUUID(), revision: 1 },
                };
                receipts.set(command.key, accepted);
                results.push(accepted);
                continue;
              }
              const accepted = {
                key: command.key,
                status: 201 as const,
                value: { candidate: crypto.randomUUID(), revision: 1 },
              };
              receipts.set(command.key, accepted);
              results.push(accepted);
            }
            return { results };
          },
        };
        const importer = createImporter({ ...inputOptions, transport, recordConcurrency: 8 });
        const store = importer.session.store;
        const seal = store.seal.bind(store);
        store.seal = (run, value) => {
          const result = seal(run, value);
          if (value.complete) seals.push({ supplied: result.supplied, status: result.status });
          return result;
        };
        return importer;
      },
    };
    const result = await runImportCli(argv, options);
    expect(result.code, result.stderr).toBe(0);
    expect(result.openHandles).toBe(0);
    expect(result.stdout).toContain('new=8');
    expect(seals).toEqual([{ supplied: 8, status: 'ready' }]);
    expect(peakCreates).toBeGreaterThan(1);
    expect(createAttempts).toBeGreaterThan(8);
    expect(receipts.size).toBeGreaterThan(8);
    const session = new ImportSession(state);
    try {
      expect(session.store.source('bangumi').count).toBe(8);
      expect(session.store.activeRun('bangumi')).toBeNull();
    } finally {
      session.close();
    }
  }, input);
});
