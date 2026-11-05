import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runImportCli } from '../src/cli.ts';
import { parsePreviewArgs, runPreviewCli } from '../src/preview-cli.ts';
import { DumpPreview } from '../src/dump-preview.ts';
import { readDump } from '../src/dumps.ts';

const fixture = (path: string) => new URL(`../../../specs/fixtures/imports/${path}`, import.meta.url);
const noNetwork = (async () => {
  throw new Error('network must not be called');
}) as unknown as typeof fetch;

async function keyFile(directory: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const path = join(directory, 'key.jwk');
  await writeFile(
    path,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
    { mode: 0o600 },
  );
  return path;
}

function argv(source: string, dump: string, directory: string, keyPath: string, extra: string[] = []) {
  return [
    '--source',
    source,
    '--dump',
    dump,
    '--state',
    join(directory, 'state.sqlite'),
    '--api',
    'https://api.import.test',
    '--auth',
    'https://auth.import.test',
    '--account-key',
    keyPath,
    '--account',
    randomUUID(),
    '--client',
    'gzip-local',
    ...extra,
  ];
}

async function recordsOf(source: 'openlibrary' | 'wikidata', bytes: Uint8Array) {
  const rows = [];
  for await (const record of readDump(
    source,
    (async function* () {
      yield bytes;
    })(),
  ))
    rows.push({ key: record.key, revision: record.revision, payload: record.payload });
  return rows;
}

test('help names compression and decode-budget; gzip is refused for VNDB and Bangumi before credentials', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--compression');
  expect(help.stdout).toContain('--decode-budget');
  expect(help.openHandles).toBe(0);
  const previewHelp = await runPreviewCli(['--help']);
  expect(previewHelp.stdout).toContain('--compression none|gzip|zstd');
  expect(() => parsePreviewArgs(['--plan-dir', '/tmp/plan', '--compression', 'gzip'])).toThrow('dump acquisition');

  const directory = await mkdtemp(join(tmpdir(), 'gzip-cli-admit-'));
  try {
    const keyPath = await keyFile(directory);
    const dump = join(directory, 'dump.gz');
    await writeFile(dump, gzipSync(new TextEncoder().encode('{"id":1,"type":2}\n')));
    const requests: string[] = [];
    const blocked = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('gzip admission reached network');
    }) as unknown as typeof fetch;
    for (const source of ['vndb', 'bangumi'] as const) {
      const result = await runImportCli(argv(source, dump, directory, keyPath, ['--compression', 'gzip']), {
        fetch: blocked,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Open Library and Wikidata');
      expect(result.openHandles).toBe(0);
    }
    expect(requests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plain and gzip Open Library and Wikidata dumps decode identical records; preview stays offline and plan-dir skips input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gzip-cli-ident-'));
  try {
    const cases = [
      ['openlibrary', await readFile(fixture('dumps/openlibrary.tsv'))],
      ['wikidata', await readFile(fixture('dumps/wikidata.json'))],
    ] as const;
    for (const [source, plain] of cases) {
      const dump = join(directory, `${source}.txt.gz`);
      await writeFile(dump, gzipSync(plain, { level: 1 }));
      const expected = await recordsOf(source, plain);
      const previewed = await DumpPreview.build({ source, dump, compression: 'gzip' });
      try {
        expect(previewed.plan.complete).toBe(true);
        expect(previewed.plan.admitted).toBe(expected.length);
        const detail = previewed.record(expected[0]!.key);
        expect(detail.found).toBe(true);
        if (detail.found && detail.kind !== 'vanished') expect(detail.digest).toHaveLength(64);
      } finally {
        await previewed.close();
      }
      const output = join(directory, `${source}-plan`);
      const first = await runPreviewCli(
        ['--source', source, '--dump', dump, '--compression', 'gzip', '--output-dir', output, '--json'],
        { fetch: noNetwork },
      );
      expect(first.code).toBe(0);
      await rm(dump);
      const reopened = await runPreviewCli(['--plan-dir', output, '--json'], { fetch: noNetwork });
      expect(reopened.code).toBe(0);
      expect(JSON.parse(reopened.stdout).complete).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt gzip, decode-budget exhaustion and default-none of a gzip file fail without network or publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gzip-cli-fail-'));
  try {
    const keyPath = await keyFile(directory);
    const dump = join(directory, 'wd.json.gz');
    const plain = await readFile(fixture('dumps/wikidata.json'));
    await writeFile(dump, gzipSync(plain).subarray(0, 12));
    const requests: string[] = [];
    const result = await runImportCli(argv('wikidata', dump, directory, keyPath, ['--compression', 'gzip']), {
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        throw new Error('corrupt gzip reached network');
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(2);
    expect(result.stderr.toLowerCase()).toMatch(/gzip|incomplete|invalid/);
    expect(requests).toEqual([]);
    expect(result.openHandles).toBe(0);

    await writeFile(dump, gzipSync(plain));
    const budget = await runPreviewCli(
      ['--source', 'wikidata', '--dump', dump, '--compression', 'gzip', '--decode-budget', '8', '--json'],
      { fetch: noNetwork },
    );
    expect(budget.code).toBe(2);
    expect(JSON.parse(budget.stdout).error.identity ?? JSON.parse(budget.stdout).error).toBeDefined();

    const none = await runImportCli(argv('wikidata', dump, directory, keyPath), { fetch: noNetwork });
    expect(none.code).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
