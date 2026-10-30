import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';

async function fixture() {
  const root = join(import.meta.dir, '../../../.temp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'cli-upstream-'));
  const state = join(dir, 'state.sqlite');
  const key = join(dir, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(key, JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'local' }), {
    mode: 0o600,
  });
  const args = [
    '--source',
    'bangumi',
    '--dump',
    '-',
    '--state',
    state,
    '--api',
    'https://api.rezics.test',
    '--account-key',
    key,
    '--account',
    '00000000-0000-4000-8000-000000000001',
    '--client',
    'rezics-importer',
    '--auth',
    'https://auth.rezics.test',
  ];
  let requests = 0;
  const fetchBoundary = (async () => {
    requests++;
    throw new Error('HTTP forbidden during acquisition');
  }) as unknown as typeof fetch;
  const invoke = (stdin: AsyncIterable<Uint8Array>, signal?: AbortSignal) =>
    runImportCli(args, { stdin, ...(signal ? { signal } : {}), fetch: fetchBoundary });
  const snapshot = () => {
    const db = new Database(state, { readonly: true });
    try {
      return {
        members: db
          .query('SELECT source,record_key,active,row_json FROM run_members WHERE active=1 ORDER BY record_key')
          .all(),
        owners: db.query('SELECT * FROM import_owners').all(),
        source: db.query('SELECT generation,present_count FROM run_sources WHERE source=?').get('bangumi'),
      };
    } finally {
      db.close();
    }
  };
  return { dir, invoke, snapshot, requests: () => requests };
}

function completeIgnoredInput(): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode('{"id":9,"type":3,"name":"Music"}\n');
  })();
}

for (const cleanup of ['never settles', 'rejects late', 'queued generator return'] as const) {
  test(`interrupted acquisition preserves its baseline and requests cleanup once when cleanup ${cleanup}`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const upstream = Promise.withResolvers<IteratorResult<Uint8Array>>();
    const returned = Promise.withResolvers<IteratorResult<Uint8Array>>();
    let reads = 0;
    let returns = 0;
    let generatorClosed = false;
    const generator = (async function* () {
      try {
        yield new TextEncoder().encode('{"id":1,"type":1,"name":"Book"}\n');
        ready.resolve();
        await upstream.promise;
      } finally {
        generatorClosed = true;
      }
    })();
    const stdin: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        reads++;
        if (cleanup === 'queued generator return') return generator.next();
        if (reads === 1)
          return Promise.resolve({ done: false, value: new TextEncoder().encode('{"id":1,"type":1,"name":"Book"}\n') });
        ready.resolve();
        return upstream.promise;
      },
      return() {
        returns++;
        return cleanup === 'queued generator return' ? generator.return(undefined) : returned.promise;
      },
    };
    try {
      // A complete ignored source member establishes a real local baseline without HTTP replies.
      expect((await f.invoke(completeIgnoredInput())).code).toBe(0);
      const before = f.snapshot();
      expect(before.members).toHaveLength(1);
      const run = f.invoke(stdin, controller.signal);
      await ready.promise;
      controller.abort(new DOMException('Operator stop', 'AbortError'));
      expect(await run).toMatchObject({ code: 130, openHandles: 0 });
      expect(returns).toBe(1);
      expect(reads).toBe(2);
      expect(f.snapshot()).toEqual(before);
      if (cleanup === 'rejects late') returned.reject(new Error('Late cleanup rejection'));
      upstream.reject(new Error('Late read rejection'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (cleanup === 'queued generator return') expect(generatorClosed).toBe(true);
      // The same source guard can be acquired normally in this same process.
      expect((await f.invoke(completeIgnoredInput())).code).toBe(0);
      expect(f.snapshot().members).toEqual(before.members);
      expect(f.snapshot().owners).toEqual([]);
      expect(f.requests()).toBe(0);
    } finally {
      controller.abort();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

for (const abortCleanup of [false, true]) {
  test(`parser failure ${abortCleanup ? 'can be interrupted during' : 'awaits ordinary'} upstream cleanup`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const cleaning = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<IteratorResult<Uint8Array>>();
    let returns = 0;
    let completed = false;
    try {
      const run = f
        .invoke(
          {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  return { done: false, value: new TextEncoder().encode('invalid JSON\n') };
                },
                return() {
                  returns++;
                  cleaning.resolve();
                  return returned.promise;
                },
              };
            },
          },
          controller.signal,
        )
        .then((result) => {
          completed = true;
          return result;
        });
      await cleaning.promise;
      expect(completed).toBe(false);
      if (abortCleanup) controller.abort();
      else returned.resolve({ done: true, value: undefined });
      expect(await run).toMatchObject({ code: abortCleanup ? 130 : 2, openHandles: 0 });
      expect(returns).toBe(1);
      expect(f.snapshot().members).toEqual([]);
      expect(f.snapshot().owners).toEqual([]);
      expect(f.requests()).toBe(0);
      if (abortCleanup) returned.reject(new Error('Late parser cleanup rejection'));
    } finally {
      controller.abort();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}
