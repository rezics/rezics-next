import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli, type ImportCliOptions } from '../src/cli.ts';
import { createImporter, type ImporterOptions } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';

// Local construction/cancellation proof only. The frozen kernel case owns native rate acceptance.
async function withInput(run: (argv: string[], state: string) => Promise<void>) {
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
    await writeFile(dump, '', { mode: 0o600 });
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
