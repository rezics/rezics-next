import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { parseResumeArgs, resumeUsage } from '../src/resume-cli.ts';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import type { ImportProgressPhase } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import entity from '../../../specs/fixtures/imports/wikidata/entity.json';

const account = '6b147e8d-1762-4717-9a65-aeb435cb843e';
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);
const registration = createSourceRegistration('wikidata');

function directory() {
  return mkdtempSync(join(tmpdir(), 'import-resume-'));
}

function row(id = 1, title = 'Target') {
  const r = structuredClone(fixture);
  r.id = `Q${id}`;
  r.labels.en.value = title;
  for (const claims of Object.values(r.claims) as { id: string }[][])
    for (const c of claims) c.id = c.id.replace(/^Q1\$/, `${r.id}$`);
  return { source: 'wikidata' as const, key: r.id, revision: String(r.lastrevid), payload: r };
}

async function* records(...rows: ReturnType<typeof row>[]) {
  yield* rows;
}

function fake() {
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  const requests: BatchWriteRequest[] = [];
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((command) => {
          const prior = receipts.get(command.key);
          if (prior) {
            expect(command.key).toBe(prior.key);
            return structuredClone(prior);
          }
          const result = {
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, result);
          return result;
        }),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
  };
  return { transport, requests, receipts };
}

async function keyFile(dir: string) {
  const path = join(dir, 'operator.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(
    path,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
    { mode: 0o600 },
  );
  return path;
}

function argv(state: string, keyPath: string, extra: readonly string[] = []) {
  return [
    'resume',
    '--source',
    'wikidata',
    '--state',
    state,
    '--api',
    'https://api.test',
    '--auth',
    'https://auth.test',
    '--account-key',
    keyPath,
    '--account',
    account,
    '--client',
    'local',
    ...extra,
  ];
}

test('resume help is self-contained and rejects dump and threshold flags', async () => {
  expect(parseResumeArgs(['--help'])).toBe('help');
  expect(() => parseResumeArgs(['--source', 'wikidata', '--dump', 'n.jsonl'])).toThrow();
  expect(() =>
    parseResumeArgs(['--source', 'wikidata', '--state', 's.sqlite', '--disappearance-threshold', '0.5']),
  ).toThrow();
  const help = await runImportCli(['resume', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain(resumeUsage().slice(0, 40));
  expect(help.stdout).toContain('inspect');
  expect(help.stdout).toContain('--source-alias');
  expect(help.openHandles).toBe(0);
  const top = await runImportCli(['--help']);
  expect(top.stdout).toContain('resume');
});

test('absent, staging, busy, missing database and incompatible conversion never start replacement input', async () => {
  const dir = directory();
  const keyPath = await keyFile(dir);
  const missing = join(dir, 'missing.sqlite');
  const stdin = async function* () {
    throw new Error('stdin must not be read');
  };
  const denyFetch = (async () => {
    throw new Error('credential HTTP must not run');
  }) as unknown as typeof globalThis.fetch;
  try {
    const missingResult = await runImportCli(argv(missing, keyPath), { stdin: stdin(), fetch: denyFetch });
    expect(missingResult.code).toBe(2);
    expect(missingResult.stderr).toContain('does not exist');
    expect(existsSync(missing)).toBe(false);

    const state = join(dir, 'state.sqlite');
    const session = new ImportSession(state);
    const own = session.acquire('wikidata');
    if (own === 'busy') throw 0;
    const begun = session.store.begin('wikidata');
    if (begun === 'busy') throw 0;
    const seed = row();
    const conversion = registration.convert(
      { external_id: seed.key, record_revision: seed.revision, record: seed.payload },
      { source: 'wikidata' },
    );
    session.store.stage(begun, {
      row: {
        source: 'wikidata',
        recordKey: 'Q1',
        recordRevision: conversion.record_revision ?? 'unversioned',
        converter_revision: registration.converter_revision,
        digest: conversion.digest,
        state: 'present',
      },
      projection: { sourceKind: 'wikidata', normalizedRecord: conversion.normalized },
    });
    const lease = begun.lease;
    session.release(own);
    session.close();

    const staging = await runImportCli(argv(state, keyPath), { stdin: stdin(), fetch: denyFetch });
    expect(staging.code).toBe(2);
    expect(staging.stderr).toContain('incomplete staging');
    const afterStaging = new ImportSession(state);
    try {
      expect(afterStaging.store.activeRun('wikidata')?.lease).toBe(lease);
      expect(afterStaging.store.source('wikidata').generation).toBeNull();
      expect(
        afterStaging.store.key('wikidata', 'Q1', afterStaging.store.activeRun('wikidata')!).staged?.row.digest,
      ).toBe(conversion.digest);
    } finally {
      afterStaging.close();
    }

    const empty = join(dir, 'empty.sqlite');
    new ImportSession(empty).close();
    const none = await runImportCli(argv(empty, keyPath), { stdin: stdin(), fetch: denyFetch });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('No resumable sealed acquisition');
    const afterNone = new ImportSession(empty);
    try {
      expect(afterNone.store.activeRun('wikidata')).toBeNull();
      expect(afterNone.store.source('wikidata').generation).toBeNull();
    } finally {
      afterNone.close();
    }

    const holder = new ImportSession(state);
    const held = holder.acquire('wikidata');
    if (held === 'busy') throw 0;
    const busy = await runImportCli(argv(state, keyPath), { stdin: stdin(), fetch: denyFetch });
    expect(busy.code).toBe(5);
    expect(holder.store.activeRun('wikidata')?.lease).toBe(lease);
    holder.release(held);
    holder.close();

    const ready = new ImportSession(state);
    const writer = ready.acquire('wikidata');
    if (writer === 'busy') throw 0;
    const sealed = ready.store.reopen(ready.store.activeRun('wikidata')!)!;
    ready.store.seal(sealed, { complete: true });
    ready.release(writer);
    ready.close();
    const wrongKind = await runImportCli(
      ['resume', '--source', 'bangumi', '--source-alias', 'wikidata', ...argv(state, keyPath).slice(3)],
      { stdin: stdin(), fetch: denyFetch },
    );
    expect(wrongKind.code).toBe(2);
    expect(wrongKind.stderr).toContain('source kind');
    expect(wrongKind.stderr).toContain('not replaced');
    const afterKind = new ImportSession(state);
    try {
      expect(afterKind.store.source('wikidata').generation).toBeNull();
      expect(afterKind.store.activeRun('wikidata')?.id).toBe(sealed.id);
    } finally {
      afterKind.close();
    }

    const mutate = new ImportSession(state);
    const mutator = mutate.acquire('wikidata');
    if (mutator === 'busy') throw 0;
    mutate.store.database.prepare(`UPDATE run_entries SET row_json=? WHERE source=? AND record_key=?`).run(
      JSON.stringify({
        source: 'wikidata',
        recordKey: 'Q1',
        recordRevision: conversion.record_revision ?? 'unversioned',
        converter_revision: 'other-converter@9',
        digest: conversion.digest,
        state: 'present',
      }),
      'wikidata',
      'Q1',
    );
    mutate.release(mutator);
    mutate.close();
    const incompatible = await runImportCli(argv(state, keyPath), { stdin: stdin(), fetch: denyFetch });
    expect(incompatible.code).toBe(2);
    expect(incompatible.stderr).toContain('converter revision');
    expect(incompatible.stderr).toContain('not replaced');
    const afterIncompatible = new ImportSession(state);
    try {
      expect(afterIncompatible.store.source('wikidata').generation).toBeNull();
      expect(afterIncompatible.store.activeRun('wikidata')?.id).toBe(sealed.id);
    } finally {
      afterIncompatible.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume finishes a sealed generation without dump input and retains identity across a second interruption', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const f = fake();
  let lose = true;
  const transport = {
    ...f.transport,
    async batchWrite(request: BatchWriteRequest) {
      const result = await f.transport.batchWrite(request);
      if (lose && request.commands.some((command) => command.op === 'propose')) {
        lose = false;
        throw new DOMException('lost acknowledgement', 'AbortError');
      }
      return result;
    },
  };
  let importer = new Importer({ path: state, transport });
  try {
    const first = await importer.runRecords(registration, records(row()));
    expect(['interrupted', 'bulk-failed']).toContain(first.status);
    const pending = importer.session.store.pagePending(importer.session.store.activeRun('wikidata')!, { limit: 8 });
    expect(pending.length).toBeGreaterThan(0);
    const original = {
      bytes: pending[0]!.bytes,
      keys: pending[0]!.keys,
      id: importer.session.store.activeRun('wikidata')!.id,
    };
    const skipped = importer.session.store.skipped(importer.session.store.activeRun('wikidata')!);
    await importer.close();
    let cancelNext = true;
    importer = new Importer({
      path: state,
      transport: {
        ...f.transport,
        async batchWrite(request: BatchWriteRequest) {
          const result = await f.transport.batchWrite(request);
          if (cancelNext) {
            cancelNext = false;
            throw new DOMException('second interruption', 'AbortError');
          }
          return result;
        },
      },
    });
    const resumePhases: ImportProgressPhase[] = [];
    const again = await importer.resumeExisting(registration, {
      progress: {
        onPhase(phase) {
          resumePhases.push(phase);
        },
      },
    });
    expect(['interrupted', 'bulk-failed']).toContain(again.status);
    expect(
      resumePhases.some((phase) => phase === 'acquiring' || phase === 'materializing' || phase === 'staging'),
    ).toBe(false);
    expect(importer.session.store.activeRun('wikidata')?.id).toBe(original.id);
    expect(
      importer.session.store.pagePending(importer.session.store.activeRun('wikidata')!, { limit: 8 })[0]!.bytes,
    ).toBe(original.bytes);
    await importer.close();

    const keyPath = await keyFile(dir);
    const dump = join(dir, 'gone.jsonl');
    await writeFile(dump, 'must-not-be-read');
    renameSync(dump, `${dump}.removed`);
    const consumed: string[] = [];
    const resume = await runImportCli(argv(state, keyPath, ['--progress', 'jsonl']), {
      stdin: (async function* () {
        consumed.push('stdin');
        yield new Uint8Array([1]);
      })(),
      fetch: (async () => {
        throw new Error('Auth must not be required for fake transport');
      }) as unknown as typeof fetch,
      createImporter(options) {
        return new Importer({ ...options, transport });
      },
      observer: {
        onInputPass() {
          throw new Error('resume must not acquire input');
        },
        onInputChunk() {
          throw new Error('resume must not read dump chunks');
        },
        onInputBuffer() {
          throw new Error('resume must not materialize');
        },
      },
      progressSink: {
        write() {},
      },
    });
    expect(consumed).toEqual([]);
    expect(resume.code).toBe(0);
    expect(resume.stdout).toContain('Import complete:');
    expect(f.requests.some((request) => JSON.stringify(request) === original.bytes)).toBe(true);
    const done = new ImportSession(state);
    try {
      expect(done.store.source('wikidata').generation).toBe(original.id);
      expect(
        (
          done.store.database
            .query('SELECT skipped FROM run_generations WHERE source=? AND id=?')
            .get('wikidata', original.id) as { skipped: number }
        ).skipped,
      ).toBe(skipped);
      expect(done.store.activeRun('wikidata')).toBeNull();
    } finally {
      done.close();
    }
  } finally {
    await importer.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI resume of VNDB and Wikidata sealed work does not open the original dump', async () => {
  const dir = directory();
  try {
    await mkdir(dir, { recursive: true });
    const keyPath = await keyFile(dir);
    for (const source of ['wikidata', 'vndb'] as const) {
      const state = join(dir, `${source}.sqlite`);
      const f = fake();
      const argvImport = [
        '--source',
        source,
        '--dump',
        '-',
        '--state',
        state,
        '--api',
        'https://api.test',
        '--auth',
        'https://auth.test',
        '--account-key',
        keyPath,
        '--account',
        account,
        '--client',
        'local',
      ];
      let lose = true;
      const transport = {
        ...f.transport,
        async batchWrite(request: BatchWriteRequest) {
          const result = await f.transport.batchWrite(request);
          if (lose && request.commands.some((command) => command.op === 'propose')) {
            lose = false;
            throw new DOMException('lost', 'AbortError');
          }
          return result;
        },
      };
      const record = structuredClone(entity);
      const bytes = new TextEncoder().encode(`[\n${JSON.stringify(record)}\n]\n`);
      const first = await runImportCli(argvImport, {
        stdin: (async function* () {
          yield bytes;
        })(),
        ...(source === 'vndb'
          ? {
              entries: (async function* () {
                const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
                for (const name of names) {
                  const text = readFileSync(
                    new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url),
                    'utf8',
                  );
                  const chunk = new TextEncoder().encode(text);
                  yield {
                    path: `db/${name}`,
                    kind: 'file' as const,
                    declaredBytes: chunk.length,
                    bytes: (async function* () {
                      yield chunk;
                    })(),
                  };
                }
              })(),
            }
          : {}),
        createImporter(options) {
          return new Importer({ ...options, transport });
        },
        fetch: (async () => {
          throw new Error('no auth');
        }) as unknown as typeof fetch,
      });
      expect([1, 130]).toContain(first.code);
      const before = new ImportSession(state);
      const active = before.store.activeRun(source)!;
      const pending = before.store.pagePending(active, { limit: 8 });
      const identity = { id: active.id, pending: pending.map((row) => row.bytes) };
      before.close();
      lose = false;
      let inputPasses = 0;
      const resumed = await runImportCli(
        ['resume', ...argvImport.filter((part) => part !== '--dump' && part !== '-')],
        {
          stdin: (async function* () {
            throw new Error('stdin');
          })(),
          entries: (async function* () {
            throw new Error('archive');
          })(),
          createImporter(options) {
            return new Importer({ ...options, transport });
          },
          fetch: (async () => {
            throw new Error('no auth');
          }) as unknown as typeof fetch,
          observer: {
            onInputPass() {
              inputPasses++;
            },
            onVndbStore() {
              throw new Error('resume must not materialize VNDB tables');
            },
          },
        },
      );
      expect(inputPasses).toBe(0);
      expect(resumed.code, resumed.stderr).toBe(0);
      const after = new ImportSession(state);
      try {
        expect(after.store.source(source).generation).toBe(identity.id);
        expect(after.store.activeRun(source)).toBeNull();
      } finally {
        after.close();
      }
      expect(f.requests.some((request) => JSON.stringify(request) === identity.pending[0])).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalization interrupted mid-cursor resumes without duplicate native effects or source input', async () => {
  const dir = directory();
  const state = join(dir, 'state.sqlite');
  const f = fake();
  const rows = Array.from({ length: 140 }, (_, i) => row(i + 1, `Title ${i + 1}`));
  let importer = new Importer({ path: state, transport: f.transport });
  try {
    expect((await importer.runRecords(registration, records(...rows))).status).toBe('committed');
    const generation = importer.session.store.source('wikidata').generation!;
    const writes = f.requests.length;
    importer.session.store.database
      .prepare("UPDATE run_sources SET lease_run=?, generation=NULL WHERE source='wikidata'")
      .run(generation);
    importer.session.store.database
      .prepare("UPDATE run_generations SET status='finalizing', cursor=? WHERE source=? AND id=?")
      .run(rows[99]!.key, 'wikidata', generation);
    await importer.close();
    importer = new Importer({ path: state, transport: f.transport, existing: true });
    const resumed = await importer.resumeExisting(registration);
    expect(resumed.status, resumed.diagnostic).toBe('committed');
    expect(f.requests.length).toBe(writes);
    expect(importer.session.store.source('wikidata').generation).toBe(generation);
    expect(importer.session.store.activeRun('wikidata')).toBeNull();
  } finally {
    await importer.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
