import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from '../src/credentials.ts';
import { runImportCli, type ImportCliObserver } from '../src/cli.ts';
import { parseBatchArgs, batchUsage } from '../src/batch-cli.ts';
import { ImportSession } from '../src/import-session.ts';
import type { ImportProgressSink } from '../src/import-progress.ts';

const origin = 'http://127.0.0.1:43179';
const authOrigin = 'https://auth.importer.test';
const account = '6b147e8d-1762-4717-9a65-aeb435cb843e';
const bangumiDump = new URL('../../../specs/fixtures/imports/dumps/bangumi-subject.jsonlines', import.meta.url);
const libraryDump = new URL('../../../specs/fixtures/imports/api/openlibrary.tsv', import.meta.url);

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'batch-cli-'));
  const bangumi = join(directory, 'bangumi.jsonl');
  const openlibrary = join(directory, 'openlibrary.tsv');
  const state = join(directory, 'state.sqlite');
  const key = join(directory, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(bangumi, await readFile(bangumiDump), { mode: 0o600 });
  await writeFile(openlibrary, await readFile(libraryDump), { mode: 0o600 });
  await writeFile(state, '', { mode: 0o600 });
  await writeFile(
    key,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'batch-cli', alg: 'ES256', key_ops: ['sign'] }),
    { mode: 0o600 },
  );
  return { directory, bangumi, openlibrary, state, key };
}

async function writeManifest(directory: string, jobs: unknown[], name = 'batch.json') {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify({ version: 1, jobs })}\n`, { mode: 0o600 });
  return path;
}

function credentials(key: string) {
  return [
    '--api',
    origin,
    '--account-key',
    key,
    '--account',
    account,
    '--client',
    'batch-cli',
    '--auth',
    authOrigin,
  ];
}

const clock = { now: () => 1_000, sleep: async () => {} };

function importFetch(options: { loseOpenLibrary?: boolean; requests?: string[]; slow?: () => Promise<void> } = {}) {
  let session = '';
  let tokens = 0;
  const subjects = new Map<string, string>();
  const effects = new Map<string, BatchWriteResult['results'][number]>();
  return async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    options.requests?.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === authOrigin) {
      if (url.pathname === '/signin/key') {
        const body = (await request.json()) as { scope?: string[] };
        const scopes = body.scope ?? [];
        const allowed = [IMPORTER_SCOPES, [...IMPORTER_SCOPES, 'subject:read'], [...VNDB_IMPORTER_SCOPES, 'subject:read']];
        if (!allowed.some((expected) => JSON.stringify(expected) === JSON.stringify(scopes)))
          return new Response('', { status: 401 });
        session = `batch-${++tokens}`;
        return Response.json({}, { headers: { 'set-cookie': `session=${session}; HttpOnly; Secure` } });
      }
      if (url.pathname === '/token') {
        return Response.json({ access_token: `BATCH_TOKEN_${tokens}`, token_type: 'Bearer', expires_in: 300 });
      }
      return new Response('', { status: 404 });
    }
    if (options.slow) await options.slow();
    if (url.pathname === '/v1/sourceFences:check') return Response.json({ fenced: false, securityRevision: null });
    if (url.pathname === '/v1/source-records:setMetadata') {
      const body = (await request.json()) as { metadata: Record<string, unknown> };
      return Response.json({ record: body.metadata, metadata_revision: 1, effect: 'filled' }, { status: 201 });
    }
    if (url.pathname !== '/v1/subjects:batchWrite') return new Response('', { status: 404 });
    const body = (await request.json()) as BatchWriteRequest;
    if (options.loseOpenLibrary && body.commands.some((command) => command.source.source === 'openlibrary')) {
      throw new DOMException('Lost Open Library write response', 'AbortError');
    }
    const result: BatchWriteResult = {
      results: body.commands.map((command) => {
        const cached = effects.get(command.key);
        if (cached) return cached;
        const home = `${command.source.source}:${command.source.external_id}`;
        if (command.op === 'create' && !subjects.has(home)) subjects.set(home, randomUUID());
        const value =
          command.op === 'create'
            ? { id: subjects.get(home)!, revision: 1 }
            : command.op === 'propose'
              ? { candidate: randomUUID(), revision: 1 }
              : { revision: 1 };
        const receipt = { key: command.key, status: 200 as const, value };
        effects.set(command.key, receipt);
        return receipt;
      }),
    };
    return Response.json(result);
  };
}

function inspect(state: string, source: string) {
  const session = new ImportSession(state);
  try {
    return {
      count: session.store.source(source).count,
      active: session.store.activeRun(source),
    };
  } finally {
    session.close();
  }
}

test('batch help is self-contained and preview is the default', async () => {
  expect(parseBatchArgs(['--help'])).toBe('help');
  const help = await runImportCli(['batch', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain(batchUsage().slice(0, 40));
  expect(help.stdout).toContain('local shape and path validation');
  expect(() => parseBatchArgs(['--manifest', 'batch.json', '--account-key', 'key'])).toThrow(
    'Credential flags must be supplied together',
  );
});

test('preview performs no credential, state or network work', async () => {
  const { directory, key } = await workspace();
  const manifest = await writeManifest(directory, [
    { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
    { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
  ]);
  const requests: string[] = [];
  const observer: ImportCliObserver = {
    onAccountKey() {
      throw new Error('preview must not read the account key');
    },
    onDatabaseOpen() {
      throw new Error('preview must not open state');
    },
  };
  const result = await runImportCli(
    [
      'batch',
      '--manifest',
      manifest,
      '--json',
      '--api',
      'https://api.rezics.example',
      '--account-key',
      key,
      '--account',
      account,
      '--client',
      'batch-cli',
      '--auth',
      authOrigin,
    ],
    {
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        throw new Error('preview network');
      }) as unknown as typeof fetch,
      observer,
    },
  );
  expect(requests).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.openHandles).toBe(0);
  const document = JSON.parse(result.stdout) as {
    mode: string;
    jobs: { sourceAlias: string; status: string; inputMode: string }[];
  };
  expect(document.mode).toBe('preview');
  expect(document.jobs.map((job) => job.sourceAlias)).toEqual(['bangumi', 'catalogue-ol']);
  expect(document.jobs.every((job) => job.status === 'planned')).toBe(true);
  expect(inspect(join(directory, 'state.sqlite'), 'bangumi').count).toBe(0);
});

test('run executes independent jobs serially, reimports idempotently and stops later jobs', async () => {
  const { directory, key, state } = await workspace();
  const manifest = await writeManifest(directory, [
    { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
    { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
  ]);
  const frames: string[] = [];
  const sink: ImportProgressSink = {
    write(frame) {
      frames.push(frame);
    },
  };
  const first = await runImportCli(
    ['batch', '--manifest', manifest, '--run', '--json', '--progress', 'jsonl', ...credentials(key)],
    { fetch: importFetch() as unknown as typeof fetch, testOrigin: origin, progressSink: sink, clock },
  );
  expect(first.code, first.stderr + first.stdout).toBe(0);
  expect(first.openHandles).toBe(0);
  const document = JSON.parse(first.stdout) as {
    jobs: { status: string; sourceComplete: boolean; runComplete: boolean; code: number; sourceAlias: string }[];
    stopping: null;
  };
  expect(document.jobs.map((job) => [job.sourceAlias, job.status, job.code, job.runComplete])).toEqual([
    ['bangumi', 'completed', 0, true],
    ['catalogue-ol', 'completed', 0, true],
  ]);
  expect(frames.some((frame) => frame.includes('"index":1') && frame.includes('"jobs":2'))).toBe(true);
  expect(inspect(state, 'bangumi').count).toBeGreaterThan(0);
  expect(inspect(state, 'catalogue-ol').count).toBeGreaterThan(0);

  const repeat = await runImportCli(['batch', '--manifest', manifest, '--run', '--json', ...credentials(key)], {
    fetch: importFetch() as unknown as typeof fetch,
    testOrigin: origin,
    clock,
  });
  expect(repeat.code).toBe(0);
  expect(JSON.parse(repeat.stdout).jobs.every((job: { diagnostic: string }) => job.diagnostic.includes('unchanged'))).toBe(
    true,
  );

  await writeFile(join(directory, 'openlibrary.tsv'), 'not-a-dump\n', { mode: 0o600 });
  const stopped = await runImportCli(['batch', '--manifest', manifest, '--run', '--json', ...credentials(key)], {
    fetch: importFetch() as unknown as typeof fetch,
    testOrigin: origin,
    clock,
  });
  expect(stopped.code).toBe(2);
  const report = JSON.parse(stopped.stdout) as {
    jobs: { status: string; recovery: string[] | null }[];
    stopping: { index: number };
    notStarted: unknown[];
  };
  expect(report.jobs[0]!.status).toBe('completed');
  expect(report.jobs[1]!.status).toBe('stopped');
  expect(report.stopping.index).toBe(2);
  expect(report.notStarted).toEqual([]);
  expect(report.jobs[1]!.recovery?.join('\n')).toContain('ordinary importer');
  expect(inspect(state, 'bangumi').count).toBeGreaterThan(0);
});

test('run stops on lost writes, cancellation, busy owners and broken sinks without starting later jobs', async () => {
  const { directory, key, state } = await workspace();
  const wikidata = join(directory, 'wikidata.jsonl');
  await writeFile(wikidata, '{"type":"item","id":"Q1","labels":{"en":{"language":"en","value":"Book"}}}\n', {
    mode: 0o600,
  });
  const three = await writeManifest(directory, [
    { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
    { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
    { source: 'wikidata', dump: 'wikidata.jsonl', state: 'state.sqlite' },
  ]);
  const lost = await runImportCli(['batch', '--manifest', three, '--run', '--json', ...credentials(key)], {
    fetch: importFetch({ loseOpenLibrary: true }) as unknown as typeof fetch,
    testOrigin: origin,
    clock,
  });
  expect([1, 130]).toContain(lost.code);
  const lostReport = JSON.parse(lost.stdout) as {
    jobs: { status: string; sourceAlias: string }[];
    notStarted: { index: number; name: string }[];
  };
  expect(lostReport.jobs.map((job) => job.status)).toEqual(['completed', 'stopped', 'not-started']);
  expect(lostReport.notStarted).toEqual([{ index: 3, name: 'wikidata' }]);
  expect(inspect(state, 'bangumi').count).toBeGreaterThan(0);
  expect(inspect(state, 'wikidata').count).toBe(0);

  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled before jobs', 'AbortError'));
  const cancelled = await runImportCli(['batch', '--manifest', three, '--run', '--json', ...credentials(key)], {
    fetch: importFetch() as unknown as typeof fetch,
    testOrigin: origin,
    signal: controller.signal,
    clock,
  });
  expect(cancelled.code).toBe(130);
  expect(JSON.parse(cancelled.stdout).jobs.every((job: { status: string }) => job.status !== 'completed')).toBe(true);

  const owner = new ImportSession(state);
  expect(owner.acquire('bangumi')).not.toBe('busy');
  const busy = await runImportCli(['batch', '--manifest', three, '--run', '--json', ...credentials(key)], {
    fetch: importFetch() as unknown as typeof fetch,
    testOrigin: origin,
    clock,
  });
  owner.close();
  expect(busy.code).toBe(5);
  expect(JSON.parse(busy.stdout).jobs[0]!.status).toBe('stopped');
  expect(JSON.parse(busy.stdout).notStarted).toHaveLength(2);

  const sink: ImportProgressSink = {
    write() {
      throw new Error('broken sink');
    },
  };
  const broken = await runImportCli(
    ['batch', '--manifest', three, '--run', '--json', '--progress', 'jsonl', ...credentials(key)],
    { fetch: importFetch() as unknown as typeof fetch, testOrigin: origin, progressSink: sink, clock },
  );
  expect(broken.code).toBe(1);
  expect(JSON.parse(broken.stdout).notStarted.length).toBeGreaterThan(0);
});

test('changed dump after earlier success is refused and credentials stay off the report', async () => {
  const { directory, key } = await workspace();
  const manifest = await writeManifest(directory, [
    { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
    { source: 'openlibrary', dump: 'openlibrary.tsv', state: 'state.sqlite' },
  ]);
  const observer: ImportCliObserver = {
    onCoordinator() {
      writeFileSync(join(directory, 'openlibrary.tsv'), 'replaced\n', { mode: 0o600 });
    },
  };
  const result = await runImportCli(['batch', '--manifest', manifest, '--run', '--json', ...credentials(key)], {
    fetch: importFetch() as unknown as typeof fetch,
    testOrigin: origin,
    observer,
    clock,
  });
  expect(result.code).toBe(2);
  expect(result.stdout).not.toContain(key);
  expect(result.stdout).not.toContain('BATCH_TOKEN');
  const report = JSON.parse(result.stdout) as { jobs: { status: string; diagnostic: string | null }[] };
  expect(report.jobs[0]!.status).toBe('completed');
  expect(report.jobs[1]!.status).toBe('stopped');
  expect(report.jobs[1]!.diagnostic).toContain('changed between local preview and execution');
});
