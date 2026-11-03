import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { STAGING_INCOMPATIBLE } from '../src/staging-checkpoint.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);

function wiki(id: number, title = `Title ${id}`) {
  const record = structuredClone(fixture);
  record.id = `Q${id}`;
  record.labels.en.value = title;
  for (const claims of Object.values(record.claims) as { id: string }[][])
    for (const claim of claims) claim.id = claim.id.replace(/^Q1\$/, `${record.id}$`);
  return record;
}

function wikiDump(records: ReturnType<typeof wiki>[]) {
  return `[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`;
}

function olLine(id: number, title: string) {
  const key = `/works/OL${id}W`;
  return `/type/work\t${key}\t1\t2020-01-01T00:00:00.000000\t${JSON.stringify({
    type: { key: '/type/work' },
    key,
    revision: 1,
    title,
  })}\n`;
}

function fake() {
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          })),
        };
      },
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
    },
  };
}

function wrap(kind: 'wikidata' | 'openlibrary', convert: (n: number) => void) {
  let n = 0;
  return {
    observer: {
      onStagingConversion() {
        convert(++n);
      },
    },
    conversions: () => n,
  };
}

async function account(root: string) {
  const path = join(root, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(
    path,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
    { mode: 0o600 },
  );
  return path;
}

const blocked = (async () => {
  throw new Error('checkpointed compressed staging reached network');
}) as unknown as typeof fetch;

function argv(
  root: string,
  key: string,
  extra: string[],
) {
  return [
    ...extra,
    '--state',
    join(root, 'state.sqlite'),
    '--api',
    'https://api.test',
    '--auth',
    'https://auth.test',
    '--account-key',
    key,
    '--account',
    randomUUID(),
    '--client',
    'local',
  ];
}

test('help names dump-set checkpointing and gzip dump-set files are admitted before network', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--dump-set <manifest-path>');
  expect(help.stdout).toContain('--checkpoint-staging');
  expect(help.stdout).toContain('whole-set decoded-byte ceiling');
  const root = await mkdtemp('/dev/shm/cli-gz-admit-');
  try {
    const key = await account(root);
    await writeFile(join(root, 'dump.json.gz'), gzipSync(Buffer.from(wikiDump([wiki(1)]))), { mode: 0o600 });
    const host = fake();
    const gzip = await runImportCli(
      argv(root, key, ['--source', 'wikidata', '--dump', join(root, 'dump.json.gz'), '--compression', 'gzip', '--checkpoint-staging']),
      {
        fetch: blocked,
        createImporter: (options) => new Importer(Object.assign(options, { transport: host.transport })),
      },
    );
    expect(gzip.code).toBe(0);
    expect(host.requests.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gzip Open Library and Wikidata CLI resume convert only the suffix', async () => {
  const root = await mkdtemp('/dev/shm/cli-gz-resume-');
  try {
    const key = await account(root);
    for (const source of ['openlibrary', 'wikidata'] as const) {
      const dumpPath = join(root, `${source}.gz`);
      const state = join(root, `${source}.sqlite`);
      const plain = source === 'openlibrary' ? olLine(1, 'A') + olLine(2, 'B') + olLine(3, 'C') + olLine(4, 'D') : wikiDump([wiki(21), wiki(22), wiki(23), wiki(24)]);
      await writeFile(dumpPath, gzipSync(Buffer.from(plain)), { mode: 0o600 });
      const flags = ['--source', source, '--dump', dumpPath, '--compression', 'gzip', '--state', state, '--api', 'https://api.test', '--auth', 'https://auth.test', '--account-key', key, '--account', randomUUID(), '--client', 'local'];
      const f = fake();
      const stop = new AbortController();
      const first = wrap(source, (n) => {
        if (n === 3) {
          stop.abort(new DOMException('stop', 'AbortError'));
          throw stop.signal.reason;
        }
      });
      const interrupted = await runImportCli([...flags, '--checkpoint-staging'], {
        signal: stop.signal,
        fetch: blocked,
        createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport, observer: first.observer })),
      });
      expect(interrupted.code).toBe(130);
      expect(interrupted.stderr).toContain('--resume-staging');
      expect(interrupted.stderr).toContain('original input');
      expect(f.requests).toHaveLength(0);
      const stored = new ImportSession(state, { create: false });
      try {
        expect(stored.store.stagingCheckpoint(source, '1')?.committedOrdinal).toBe(2);
        expect(stored.store.stagingCheckpoint(source, '1')?.identity.decoderId).toBe('dumps-gzip-v1');
      } finally {
        stored.close();
      }
      const second = wrap(source, () => {});
      const resumed = await runImportCli([...flags, '--resume-staging', '--generation', '1'], {
        fetch: blocked,
        createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport, observer: second.observer })),
      });
      expect(resumed.code).toBe(0);
      expect(second.conversions()).toBe(2);
      expect(f.requests.length).toBeGreaterThan(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dump-set CLI resumes the same generation and a changed budget keeps the checkpoint', async () => {
  const root = await mkdtemp('/dev/shm/cli-set-resume-');
  try {
    const key = await account(root);
    const author = {
      type: { key: '/type/author' },
      key: '/authors/OL900000001A',
      revision: 1,
      last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
      name: 'Ada Example',
    };
    const row = (
      record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } } & Record<
        string,
        unknown
      >,
    ) =>
      `${[record.type.key, record.key, record.revision, record.last_modified?.value ?? '2025-01-01T00:00:00Z', JSON.stringify(record)].join('\t')}\n`;
    const works = [
      { ...workSource, covers: [] },
      { ...workSource, key: '/works/OL900000011W', title: 'Second work', covers: [] },
      { ...workSource, key: '/works/OL900000012W', title: 'Third work', covers: [] },
    ];
    await writeFile(join(root, 'authors.txt.gz'), gzipSync(Buffer.from(row(author))), { mode: 0o600 });
    await writeFile(join(root, 'works.txt'), works.map(row).join(''), { mode: 0o600 });
    await writeFile(join(root, 'editions.txt.gz'), gzipSync(Buffer.from(row({ ...editionSource, covers: [] }))), { mode: 0o600 });
    const manifest = join(root, 'manifest.json');
    await writeFile(
      manifest,
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
    const flags = argv(root, key, ['--source', 'openlibrary', '--dump-set', manifest]);
    const f = fake();
    const stop = new AbortController();
    const first = wrap('openlibrary', (n) => {
      if (n === 2) {
        stop.abort(new DOMException('stop', 'AbortError'));
        throw stop.signal.reason;
      }
    });
    const interrupted = await runImportCli([...flags, '--checkpoint-staging'], {
      signal: stop.signal,
      fetch: blocked,
      createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport, observer: first.observer })),
    });
    expect(interrupted.code).toBe(130);
    const stored = new ImportSession(join(root, 'state.sqlite'), { create: false });
    try {
      const checkpoint = stored.store.stagingCheckpoint('openlibrary', '1');
      expect(checkpoint?.committedOrdinal).toBe(1);
      expect(checkpoint?.completedMembers).toBe(1);
      expect(checkpoint?.identity.decoderId).toBe('open-library-dump-set-v1');
    } finally {
      stored.close();
    }
    const budget = await runImportCli([...flags, '--decode-budget', '4096', '--resume-staging', '--generation', '1'], {
      fetch: blocked,
      createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport })),
    });
    expect(budget.code).toBe(2);
    expect(budget.stderr).toContain(STAGING_INCOMPATIBLE);
    const kept = new ImportSession(join(root, 'state.sqlite'), { create: false });
    try {
      expect(kept.store.stagingCheckpoint('openlibrary', '1')?.committedOrdinal).toBe(1);
    } finally {
      kept.close();
    }
    const second = wrap('openlibrary', () => {});
    const resumed = await runImportCli([...flags, '--resume-staging', '--generation', '1'], {
      fetch: blocked,
      createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport, observer: second.observer })),
    });
    expect(resumed.code).toBe(0);
    expect(second.conversions()).toBe(3);
    expect(f.requests.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concatenated gzip with a truncated final member keeps the prefix and publishes nothing', async () => {
  const root = await mkdtemp('/dev/shm/cli-gz-trunc-');
  try {
    const key = await account(root);
    const first = gzipSync(Buffer.from(olLine(1, 'Lantern') + olLine(2, 'Harbor')));
    const truncated = gzipSync(Buffer.from(olLine(3, 'Broken') + olLine(4, 'Tail'))).subarray(0, 16);
    const dump = join(root, 'works.gz');
    await writeFile(dump, Buffer.concat([first, truncated]), { mode: 0o600 });
    const f = fake();
    const result = await runImportCli(
      argv(root, key, ['--source', 'openlibrary', '--dump', dump, '--compression', 'gzip', '--checkpoint-staging']),
      {
        fetch: blocked,
        createImporter: (options) => new Importer(Object.assign(options, { transport: f.transport })),
      },
    );
    expect(result.code).toBe(2);
    expect(f.requests).toHaveLength(0);
    const stored = new ImportSession(join(root, 'state.sqlite'), { create: false });
    try {
      expect(stored.store.peekActive('openlibrary')?.status).not.toBe('ready');
    } finally {
      stored.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
