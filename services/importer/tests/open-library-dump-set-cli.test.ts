import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};

function row(record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } }) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

async function account(root: string) {
  const path = join(root, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(
    path,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'dump-set', alg: 'ES256' }),
    { mode: 0o600 },
  );
  return path;
}

async function manifest(
  root: string,
  files: { authors?: string; works?: string; editions?: string } = {},
) {
  await writeFile(join(root, 'authors.txt'), files.authors ?? row(author), { mode: 0o600 });
  await writeFile(join(root, 'works.txt'), files.works ?? row(workSource), { mode: 0o600 });
  await writeFile(join(root, 'editions.txt'), files.editions ?? row(editionSource), { mode: 0o600 });
  const path = join(root, 'manifest.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      source: 'openlibrary',
      members: [
        { family: 'author', path: 'authors.txt' },
        { family: 'work', path: 'works.txt' },
        { family: 'edition', path: 'editions.txt' },
      ],
    }),
    { mode: 0o600 },
  );
  return path;
}

const required = (root: string, dumpSet: string, key: string) => [
  '--source',
  'openlibrary',
  '--dump-set',
  dumpSet,
  '--state',
  join(root, 'state.sqlite'),
  '--api',
  'https://kernel.import.test',
  '--auth',
  'https://auth.import.test',
  '--account-key',
  key,
  '--account',
  '00000000-0000-4000-8000-000000000001',
  '--client',
  'dump-set',
];

test('dump-set is exclusive with --dump and is Open Library only', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-cli-args-');
  try {
    const key = await account(root);
    const path = await manifest(root);
    const requests: string[] = [];
    const blocked = (async (input: Request | string | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      throw new Error('network');
    }) as unknown as typeof fetch;
    const both = await runImportCli([...required(root, path, key), '--dump', join(root, 'works.txt')], {
      fetch: blocked,
    });
    expect(both.code).toBe(2);
    expect(requests).toEqual([]);
    const other = await runImportCli(
      ['--source', 'wikidata', '--dump-set', path, ...required(root, path, key).slice(4)],
      { fetch: blocked },
    );
    expect(other.code).toBe(2);
    expect(requests).toEqual([]);
    const compressed = await runImportCli([...required(root, path, key), '--compression', 'gzip'], {
      fetch: blocked,
    });
    expect(compressed.code).toBe(2);
    expect(requests).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing members never contact Auth or the catalogue', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-cli-missing-');
  try {
    const key = await account(root);
    const path = await manifest(root);
    await rm(join(root, 'editions.txt'));
    const requests: string[] = [];
    const result = await runImportCli(required(root, path, key), {
      fetch: (async (input: Request | string | URL) => {
        requests.push(input instanceof Request ? input.url : String(input));
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
    expect(requests).toEqual([]);
    expect(result.stderr).toContain('member 2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a malformed final member produces no catalogue HTTP and keeps the prior baseline', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-cli-late-');
  try {
    const key = await account(root);
    const path = await manifest(root, { editions: '/type/edition\t/books/OL1M\t1\t2025-01-01\t{"key":' });
    const catalogue: string[] = [];
    const result = await runImportCli(required(root, path, key), {
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.includes('subjects') || url.pathname.includes('source-records')) catalogue.push(url.pathname);
        throw new Error('Unexpected catalogue effect');
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
    expect(catalogue).toEqual([]);
    expect(result.stderr).toContain('member 2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('help lists dump-set and single --dump stdin still parses', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--dump-set');
  const root = await mkdtemp('/dev/shm/ol-dump-set-cli-dump-');
  try {
    const key = await account(root);
    const requests: string[] = [];
    const result = await runImportCli(
      [
        '--source',
        'openlibrary',
        '--dump',
        '-',
        '--state',
        join(root, 'state.sqlite'),
        '--api',
        'https://kernel.import.test',
        '--auth',
        'https://auth.import.test',
        '--account-key',
        key,
        '--account',
        randomUUID(),
        '--client',
        'dump-set',
      ],
      {
        stdin: (async function* () {
          yield new TextEncoder().encode('{');
        })(),
        fetch: (async (input: Request | string | URL) => {
          requests.push(input instanceof Request ? input.url : String(input));
          throw new Error('network');
        }) as unknown as typeof fetch,
      },
    );
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
