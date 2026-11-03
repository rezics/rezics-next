import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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

async function mixedManifest(root: string, editions: Uint8Array = gzipSync(Buffer.from(row(editionSource)))) {
  await writeFile(join(root, 'authors.txt.gz'), gzipSync(Buffer.from(row(author))), { mode: 0o600 });
  await writeFile(join(root, 'works.txt'), row(workSource), { mode: 0o600 });
  await writeFile(join(root, 'editions.txt.gz'), editions, { mode: 0o600 });
  const path = join(root, 'manifest.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      source: 'openlibrary',
      members: [
        { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
        { family: 'work', path: 'works.txt', compression: 'none' },
        { family: 'edition', path: 'editions.txt.gz', compression: 'gzip' },
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

test('dump-set decode-budget is a whole-set ceiling and gzip still rejects --compression', async () => {
  const root = await mkdtemp('/dev/shm/ol-set-cli-budget-');
  try {
    const key = await account(root);
    const path = await mixedManifest(root);
    const requests: string[] = [];
    const blocked = (async (input: Request | string | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      throw new Error('network');
    }) as unknown as typeof fetch;
    const compressed = await runImportCli([...required(root, path, key), '--compression', 'gzip'], { fetch: blocked });
    expect(compressed.code).toBe(2);
    expect(requests).toEqual([]);
    const over = await runImportCli([...required(root, path, key), '--decode-budget', '32'], { fetch: blocked });
    expect(over.code).toBe(2);
    expect(over.stderr).toContain('decode-budget');
    expect(requests.every((url) => !url.includes('subjects') && !url.includes('source-records'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt gzip final member reports the member and never contacts Auth', async () => {
  const root = await mkdtemp('/dev/shm/ol-set-cli-late-gzip-');
  try {
    const key = await account(root);
    const path = await mixedManifest(
      root,
      Buffer.concat([gzipSync(Buffer.from(row(editionSource))), Buffer.from('trail')]),
    );
    const requests: string[] = [];
    const result = await runImportCli(required(root, path, key), {
      fetch: (async (input: Request | string | URL) => {
        requests.push(input instanceof Request ? input.url : String(input));
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
    expect(result.stderr).toContain('member 2');
    expect(result.stderr).toContain('gzip-trailing-garbage');
    expect(requests.every((url) => !url.includes('subjects') && !url.includes('source-records'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preview of a dump set prints the dump-set import invocation without credentials', async () => {
  const root = await mkdtemp('/dev/shm/ol-set-cli-preview-');
  try {
    const path = await mixedManifest(root);
    const requests: string[] = [];
    const result = await runImportCli(['preview', '--source', 'openlibrary', '--dump-set', path, '--json'], {
      fetch: (async (input: Request | string | URL) => {
        requests.push(input instanceof Request ? input.url : String(input));
        throw new Error('network');
      }) as unknown as typeof fetch,
    });
    expect(requests).toEqual([]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      complete: boolean;
      acquisition: string;
      inputFamilies: { family: string; compression: string }[];
      importInvocation: string[];
      phases: { preview: string; nativePublication: string };
    };
    expect(document.complete).toBe(true);
    expect(document.acquisition).toBe('dump-set');
    expect(document.inputFamilies).toEqual([
      { family: 'author', compression: 'gzip' },
      { family: 'work', compression: 'none' },
      { family: 'edition', compression: 'gzip' },
    ]);
    expect(document.phases.preview).toBe('complete');
    expect(document.phases.nativePublication).toBe('not-started');
    expect(document.importInvocation.join('\n')).toContain('--dump-set <complete-manifest-path>');
    expect(document.importInvocation.join('\n')).toContain('--account-key <path>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('help names dump-set gzip members and whole-set decode-budget', async () => {
  const help = await runImportCli(['--help']);
  expect(help.stdout).toContain('--dump-set');
  expect(help.stdout).toContain('whole-set decoded-byte ceiling');
  expect(help.stdout).toContain('version 2');
});
