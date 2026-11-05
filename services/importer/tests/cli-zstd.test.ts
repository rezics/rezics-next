import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { parsePreviewArgs, runPreviewCli } from '../src/preview-cli.ts';
import { DumpPreview } from '../src/dump-preview.ts';
import { readDump } from '../src/dumps.ts';

const fixture = (path: string) => new URL(`../../../specs/fixtures/imports/${path}`, import.meta.url);
const noNetwork = (async () => {
  throw new Error('network must not be called');
}) as unknown as typeof fetch;

async function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const child = Bun.spawn(['/usr/bin/zstd', '-c', '-q', '-'], { stdin: bytes, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).bytes();
  if ((await child.exited) !== 0) throw new Error('zstd compress failed');
  return out;
}

function archive(): Uint8Array {
  const encoder = new TextEncoder();
  const member = (path: string, bytes: Uint8Array) => {
    const header = new Uint8Array(512);
    const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
    put(0, path);
    for (const offset of [100, 108, 116]) put(offset, '0000644\0');
    put(124, `${bytes.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(
      148,
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
    );
    return Buffer.concat([header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512)]);
  };
  const parts: Uint8Array[] = [];
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    parts.push(member(`db/${name}`, readFileSync(fixture(`vndb-tables/db/${name}`))));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

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
    'zstd-local',
    ...extra,
  ];
}

async function recordsOf(source: 'wikidata', bytes: Uint8Array) {
  const rows = [];
  for await (const record of readDump(
    source,
    (async function* () {
      yield bytes;
    })(),
  ))
    rows.push({ key: record.key, revision: record.revision });
  return rows;
}

test('help names zstd; bangumi, Open Library and stdin are refused before credentials', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--compression none|gzip|zstd');
  expect(help.stdout).toContain('--zstd-executable');
  expect(help.openHandles).toBe(0);
  const previewHelp = await runPreviewCli(['--help']);
  expect(previewHelp.stdout).toContain('--compression none|gzip|zstd');
  expect(() => parsePreviewArgs(['--plan-dir', '/tmp/plan', '--compression', 'zstd'])).toThrow('dump acquisition');

  const directory = await mkdtemp(join(tmpdir(), 'zstd-cli-admit-'));
  try {
    const keyPath = await keyFile(directory);
    const dump = join(directory, 'dump.zst');
    await writeFile(dump, await zstdCompress(new TextEncoder().encode('{"id":1,"type":2}\n')));
    const requests: string[] = [];
    const blocked = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('zstd admission reached network');
    }) as unknown as typeof fetch;
    for (const source of ['bangumi', 'openlibrary'] as const) {
      const result = await runImportCli(argv(source, dump, directory, keyPath, ['--compression', 'zstd']), {
        fetch: blocked,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('VNDB');
      expect(result.openHandles).toBe(0);
    }
    const stdin = await runImportCli(argv('wikidata', '-', directory, keyPath, ['--compression', 'zstd']), {
      fetch: blocked,
    });
    expect(stdin.code).toBe(2);
    expect(stdin.openHandles).toBe(0);
    const missing = await runImportCli(
      argv('wikidata', dump, directory, keyPath, ['--compression', 'zstd', '--zstd-executable', '/tmp/missing-zstd']),
      { fetch: blocked },
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr.toLowerCase()).toMatch(/zstd executable/);
    expect(requests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plain and zstd Wikidata and VNDB inputs decode identical records; preview stays offline and plan-dir skips input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zstd-cli-ident-'));
  try {
    const wikidata = await readFile(fixture('dumps/wikidata.json'));
    const vndb = archive();
    for (const [source, plain] of [
      ['wikidata', wikidata],
      ['vndb', vndb],
    ] as const) {
      const dump = join(directory, `${source}.zst`);
      await writeFile(dump, await zstdCompress(plain));
      const previewed = await DumpPreview.build({ source, dump, compression: 'zstd' });
      try {
        expect(previewed.plan.complete).toBe(true);
        expect(previewed.plan.admitted).toBeGreaterThan(0);
        if (source === 'wikidata') {
          const expected = await recordsOf(source, plain);
          expect(previewed.plan.admitted).toBe(expected.length);
          const detail = previewed.record(expected[0]!.key);
          expect(detail.found).toBe(true);
          if (detail.found && detail.kind !== 'vanished') expect(detail.digest).toHaveLength(64);
        }
      } finally {
        await previewed.close();
      }
      const output = join(directory, `${source}-plan`);
      const first = await runPreviewCli(
        ['--source', source, '--dump', dump, '--compression', 'zstd', '--output-dir', output, '--json'],
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

test('corrupt zstd, decode-budget exhaustion and default-none of a zstd file fail without network or publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zstd-cli-fail-'));
  try {
    const keyPath = await keyFile(directory);
    const dump = join(directory, 'wd.json.zst');
    const plain = await readFile(fixture('dumps/wikidata.json'));
    await writeFile(dump, (await zstdCompress(plain)).subarray(0, 12));
    const requests: string[] = [];
    const result = await runImportCli(argv('wikidata', dump, directory, keyPath, ['--compression', 'zstd']), {
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        throw new Error('corrupt zstd reached network');
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(2);
    expect(result.stderr.toLowerCase()).toMatch(/zstd|incomplete|invalid/);
    expect(requests).toEqual([]);
    expect(result.openHandles).toBe(0);

    await writeFile(dump, await zstdCompress(plain));
    const budget = await runPreviewCli(
      ['--source', 'wikidata', '--dump', dump, '--compression', 'zstd', '--decode-budget', '8', '--json'],
      { fetch: noNetwork },
    );
    expect(budget.code).toBe(2);

    const none = await runImportCli(argv('wikidata', dump, directory, keyPath), { fetch: noNetwork });
    expect(none.code).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
