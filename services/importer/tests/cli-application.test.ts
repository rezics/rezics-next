import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportCliApplication } from '../src/cli-application.ts';
import { planImportCliArgv } from '../src/cli-contract.ts';
import { createImportCliHost } from '../src/cli-host.ts';
import { runBatchCli } from '../src/batch-cli.ts';
import type { ImportCliOptions, ImportCliResult } from '../src/cli-contract.ts';

const origin = 'http://127.0.0.1:43179';
const authOrigin = 'https://auth.importer.test';
const account = '6b147e8d-1762-4717-9a65-aeb435cb843e';
const bangumiDump = new URL('../../../specs/fixtures/imports/dumps/bangumi-subject.jsonlines', import.meta.url);
const libraryDump = new URL('../../../specs/fixtures/imports/api/openlibrary.tsv', import.meta.url);

test('command plans classify help, batch and ordinary import before any host work', () => {
  expect(planImportCliArgv(['--help'])).toEqual({ kind: 'help', usage: 'import' });
  expect(planImportCliArgv(['--help', 'batch'])).toEqual({ kind: 'help', usage: 'batch' });
  expect(planImportCliArgv(['batch', '--manifest', 'jobs.json'])).toEqual({
    kind: 'subcommand',
    name: 'batch',
    argv: ['--manifest', 'jobs.json'],
  });
  expect(planImportCliArgv(['--source', 'bangumi', '--dump', '-'])).toEqual({
    kind: 'ordinary',
    argv: ['--source', 'bangumi', '--dump', '-'],
  });
});

test('batch nested jobs use the constructed executor and retain host fetch, clock and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-application-'));
  await writeFile(join(directory, 'bangumi.jsonl'), await readFile(bangumiDump), { mode: 0o600 });
  await writeFile(join(directory, 'openlibrary.tsv'), await readFile(libraryDump), { mode: 0o600 });
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = join(directory, 'account.jwk');
  await writeFile(
    key,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'cli-app', alg: 'ES256', key_ops: ['sign'] }),
    { mode: 0o600 },
  );
  const manifest = join(directory, 'batch.json');
  await writeFile(
    manifest,
    `${JSON.stringify({
      version: 1,
      jobs: [
        { source: 'bangumi', dump: 'bangumi.jsonl', state: 'state.sqlite' },
        { source: 'openlibrary', sourceAlias: 'catalogue-ol', dump: 'openlibrary.tsv', state: 'state.sqlite' },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const fetchImpl = (async () => new Response('unused')) as unknown as typeof fetch;
  const clock = { now: () => 1_000, sleep: async () => {} };
  const signal = new AbortController().signal;
  const calls: { argv: readonly string[]; options: ImportCliOptions }[] = [];
  const result = await runBatchCli(
    [
      '--manifest',
      manifest,
      '--run',
      '--api',
      origin,
      '--account-key',
      key,
      '--account',
      account,
      '--client',
      'cli-app',
      '--auth',
      authOrigin,
    ],
    { fetch: fetchImpl, clock, signal, testOrigin: origin },
    {
      async runSingleSource(argv, options): Promise<ImportCliResult> {
        calls.push({ argv, options });
        return {
          code: 0,
          stdout: `Import complete: new=0 changed=0 unchanged=1 vanished=0 skipped=0\n`,
          stderr: '',
          openHandles: 0,
        };
      },
    },
  );
  expect(result.code).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.options.fetch === fetchImpl)).toBe(true);
  expect(calls.every((call) => call.options.clock === clock)).toBe(true);
  expect(calls.every((call) => call.options.signal === signal)).toBe(true);
  expect(calls.map((call) => call.argv[1])).toEqual(['bangumi', 'openlibrary']);
});

test('constructed application dispatches batch through the same host without re-entering the process entry', async () => {
  const fetchImpl = (async () => new Response('unused')) as unknown as typeof fetch;
  const host = createImportCliHost({ fetch: fetchImpl, testOrigin: origin });
  const application = createImportCliApplication(host);
  const help = await application.run(['--help', 'batch']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('rezics-import batch --manifest');
  expect(host.fetch).toBe(fetchImpl);
  expect(host.processIdentity.pid).toBe(process.pid);
  expect(host.processIdentity.birth.length).toBeGreaterThan(0);
});
