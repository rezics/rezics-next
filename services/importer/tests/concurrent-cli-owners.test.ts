import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import work from '../../../specs/fixtures/imports/open-library/work.json';

// A pre-effect local proof, deliberately with no HTTP reply double. Native publication belongs to kernel acceptance.
test('ordinary CLI holds acquisition ownership until cancellation and rejects only the competing alias before Auth', async () => {
  const directory = await mkdtemp('/dev/shm/importer-cli-owners-');
  const state = join(directory, 'state.sqlite');
  const key = join(directory, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(
    key,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
    { mode: 0o600 },
  );
  await writeFile(state, '', { mode: 0o600 });
  const requests: string[] = [];
  const controllers: AbortController[] = [];
  const pending: Promise<Awaited<ReturnType<typeof runImportCli>>>[] = [];
  const args = (alias: string) => [
    '--source',
    'openlibrary',
    '--source-alias',
    alias,
    '--dump',
    '-',
    '--state',
    state,
    '--api',
    'https://kernel.import.test',
    '--auth',
    'https://auth.import.test',
    '--account-key',
    key,
    '--account',
    '00000000-0000-4000-8000-000000000001',
    '--client',
    'ordinary-importer',
  ];
  const fetchBoundary = (async (url: Request | string | URL) => {
    requests.push(url instanceof Request ? url.url : String(url));
    throw new Error('Acquisition must not reach HTTP');
  }) as unknown as typeof fetch;
  function hold(alias: string) {
    const controller = new AbortController();
    controllers.push(controller);
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => (ready = resolve));
    let finish: ((value: IteratorResult<Uint8Array>) => void) | undefined;
    let sent = false;
    let returns = 0;
    const stdin: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (!sent) {
          sent = true;
          return {
            done: false,
            value: new TextEncoder().encode(
              [work.type.key, work.key, work.revision, work.last_modified.value, JSON.stringify(work)].join('\t') +
                '\n',
            ),
          };
        }
        ready();
        return new Promise<IteratorResult<Uint8Array>>((resolve) => (finish = resolve));
      },
      async return() {
        returns++;
        const end = { done: true as const, value: undefined };
        finish?.(end);
        return end;
      },
    };
    const done = runImportCli(args(alias), { stdin, signal: controller.signal, fetch: fetchBoundary });
    pending.push(done);
    return {
      done,
      controller,
      waiting: Promise.race([
        waiting,
        done.then((r) => {
          throw new Error(`Unexpected early exit ${JSON.stringify(r)}`);
        }),
      ]),
      get returns() {
        return returns;
      },
    };
  }
  const owners = (alias: string) => {
    const db = new Database(state, { readonly: true });
    try {
      return db.query('SELECT source,pid,birth,capability FROM import_owners WHERE source=?').get(alias);
    } finally {
      db.close();
    }
  };
  try {
    const a = hold('books-a');
    await a.waiting;
    const before = owners('books-a');
    expect(before).toMatchObject({ source: 'books-a', pid: process.pid });
    const competitor = await runImportCli(args('books-a'), {
      stdin: {
        async *[Symbol.asyncIterator]() {
          throw new Error('Busy CLI must not consume input');
        },
      },
      fetch: fetchBoundary,
    });
    expect(competitor.code).toBe(5);
    expect(competitor.openHandles).toBe(0);
    expect(owners('books-a')).toEqual(before);
    const b = hold('books-b');
    await b.waiting;
    expect(owners('books-b')).toMatchObject({ source: 'books-b', pid: process.pid });
    a.controller.abort();
    expect([1, 130]).toContain((await a.done).code);
    expect(a.returns).toBeGreaterThan(0);
    expect(owners('books-a')).toBeNull();
    expect(owners('books-b')).not.toBeNull();
    const reopened = hold('books-a');
    await reopened.waiting;
    expect(owners('books-a')).not.toEqual(before);
    reopened.controller.abort();
    b.controller.abort();
    for (const result of await Promise.all(pending)) {
      expect([1, 130]).toContain(result.code);
      expect(result.openHandles).toBe(0);
    }
    expect(owners('books-a')).toBeNull();
    expect(owners('books-b')).toBeNull();
    const invalid = await runImportCli(args('books-a'), {
      stdin: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('malformed native TSV\n');
        },
      },
      fetch: fetchBoundary,
    });
    expect(invalid.code).toBe(2);
    expect(invalid.openHandles).toBe(0);
    expect(owners('books-a')).toBeNull();
    expect(requests).toEqual([]);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
    await rm(directory, { recursive: true, force: true });
  }
});
