import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { IMPORTER_SCOPES } from '../src/credentials.ts';
import { runImportCli, type ImportCliObserver } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';
import { insertSourceDestination, readSourceDestination } from '../src/source-destination.ts';
import type { SourceProjection } from '../src/run-store.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
const origin = 'http://127.0.0.1:43179';
const otherOrigin = 'http://127.0.0.1:43180';
const authOrigin = 'https://auth.importer.test';
const account = '6b147e8d-1762-4717-9a65-aeb435cb843e';
const dumpFixture = new URL('../../../specs/fixtures/imports/dumps/bangumi-subject.jsonlines', import.meta.url);

function directory() {
  mkdirSync(temporaryRoot, { recursive: true });
  const path = mkdtempSync(join(temporaryRoot, 'source-destination-cli-'));
  const dump = join(path, 'bangumi.jsonl');
  const state = join(path, 'state.sqlite');
  const key = join(path, 'account.jwk');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(dump, readFileSync(dumpFixture));
  writeFileSync(
    key,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'dest-cli', alg: 'ES256', key_ops: ['sign'] }),
    { mode: 0o600 },
  );
  return {
    path,
    dump,
    state,
    key,
    close() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function credentials(key: string, api = origin) {
  return ['--api', api, '--account-key', key, '--account', account, '--client', 'dest-cli', '--auth', authOrigin];
}

const clock = { now: () => 1_000, sleep: async () => {} };

function importFetch(requests: string[]) {
  let session = '';
  let tokens = 0;
  const subjects = new Map<string, string>();
  const effects = new Map<string, BatchWriteResult['results'][number]>();
  return async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === authOrigin) {
      if (url.pathname === '/signin/key') {
        const body = (await request.json()) as { scope?: string[] };
        if (JSON.stringify(body.scope) !== JSON.stringify([...IMPORTER_SCOPES, 'subject:read']))
          return new Response('', { status: 401 });
        session = `dest-${++tokens}`;
        return Response.json({}, { headers: { 'set-cookie': `session=${session}; HttpOnly; Secure` } });
      }
      if (url.pathname === '/token')
        return Response.json({ access_token: `DEST_TOKEN_${tokens}`, token_type: 'Bearer', expires_in: 300 });
      return new Response('', { status: 404 });
    }
    if (url.pathname === '/v1/sourceFences:check') return Response.json({ fenced: false, securityRevision: null });
    if (url.pathname === '/v1/source-records:setMetadata') {
      const body = (await request.json()) as { metadata: Record<string, unknown> };
      return Response.json({ record: body.metadata, metadata_revision: 1, effect: 'filled' }, { status: 201 });
    }
    if (url.pathname !== '/v1/subjects:batchWrite') return new Response('', { status: 404 });
    const body = (await request.json()) as BatchWriteRequest;
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

function staged(source: string, key: string) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    } satisfies SourceProjection,
  };
}

function tableNames(state: string) {
  const database = new Database(state, { readonly: true, create: false });
  const names = database
    .query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
  database.close();
  return names;
}

function generationColumns(state: string) {
  const database = new Database(state, { readonly: true, create: false });
  const names = database
    .query('PRAGMA table_info(run_generations)')
    .all()
    .map((row) => (row as { name: string }).name);
  database.close();
  return names;
}

function dropDiagnosticRecords(state: string) {
  const database = new Database(state);
  database.exec('ALTER TABLE run_generations DROP COLUMN diagnostic_records');
  database.close();
}

function seedLegacy(state: string, source = 'wikidata') {
  const session = new ImportSession(state);
  const run = session.store.begin(source);
  if (run === 'busy') throw new Error('busy');
  session.store.stage(run, staged(source, 'Q1'));
  expect(session.store.seal(run, { complete: true }).status).toBe('ready');
  session.store.classify(run, 'Q1', { commands: [] });
  session.store.acknowledgeNoEffects(run, 'Q1', { reason: 'no-owned-candidates' });
  expect(session.store.finalize(run, 100)).toBe('complete');
  const journal = session.store.database.query('SELECT source,record_key,bytes FROM run_envelopes').all();
  const acknowledged = session.store.database.query('SELECT record_key FROM run_acknowledged').all();
  session.close();
  const database = new Database(state);
  database.exec('DROP TABLE IF EXISTS source_destinations');
  database.close();
  return { journal, acknowledged };
}

async function importBangumi(dir: ReturnType<typeof directory>, api = origin, requests: string[] = []) {
  return runImportCli(['--source', 'bangumi', '--dump', dir.dump, '--state', dir.state, ...credentials(dir.key, api)], {
    fetch: importFetch(requests) as unknown as typeof fetch,
    testOrigin: api,
    clock,
  });
}

test('destination help is local and does not require credentials', async () => {
  const help = await runImportCli(['destination', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local configuration, not verified historical destination evidence');
  expect(help.stdout).toContain('Same-origin server replacement cannot be detected');
  expect(help.openHandles).toBe(0);
});

test('ordinary import records first-use origin; a different --api fails before credentials or importer construction', async () => {
  const dir = directory();
  try {
    const requests: string[] = [];
    const first = await importBangumi(dir, origin, requests);
    expect(first.code, first.stderr).toBe(0);
    expect(requests.some((item) => item.includes('/signin/key'))).toBe(true);
    const session = new ImportSession(dir.state, { create: false });
    expect(readSourceDestination(session.store.database, 'bangumi')).toMatchObject({
      origin,
      provenance: 'first-use',
    });
    session.close();

    const inspected = await runImportCli(['inspect', '--state', dir.state, '--source', 'bangumi', '--json']);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout).destination).toEqual({
      status: 'bound',
      origin,
      provenance: 'first-use',
      recorded: 'first-use',
    });
    expect(inspected.stdout).not.toContain('Private');

    const laterRequests: string[] = [];
    let constructed = false;
    let keyRead = false;
    const observer: ImportCliObserver = {
      onAccountKey() {
        keyRead = true;
      },
    };
    const mismatch = await runImportCli(
      ['--source', 'bangumi', '--dump', dir.dump, '--state', dir.state, ...credentials(dir.key, otherOrigin)],
      {
        fetch: importFetch(laterRequests) as unknown as typeof fetch,
        testOrigin: otherOrigin,
        clock,
        observer,
        createImporter() {
          constructed = true;
          throw new Error('createImporter must not run on a destination mismatch');
        },
      },
    );
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toContain('does not match source "bangumi" recorded origin');
    expect(mismatch.stderr).toContain('before credentials or native replay');
    expect(laterRequests).toEqual([]);
    expect(keyRead).toBe(false);
    expect(constructed).toBe(false);

    const resumeRequests: string[] = [];
    let resumeKeyRead = false;
    let resumeConstructed = false;
    const resumeMismatch = await runImportCli(
      ['resume', '--source', 'bangumi', '--state', dir.state, ...credentials(dir.key, otherOrigin)],
      {
        fetch: importFetch(resumeRequests) as unknown as typeof fetch,
        testOrigin: otherOrigin,
        clock,
        observer: {
          onAccountKey() {
            resumeKeyRead = true;
          },
        },
        createImporter() {
          resumeConstructed = true;
          throw new Error('createImporter must not run on a sealed-resume destination mismatch');
        },
      },
    );
    expect(resumeMismatch.code).toBe(2);
    expect(resumeMismatch.stderr).toContain('does not match source "bangumi" recorded origin');
    expect(resumeMismatch.stderr).toContain('before credentials or native replay');
    expect(resumeRequests).toEqual([]);
    expect(resumeKeyRead).toBe(false);
    expect(resumeConstructed).toBe(false);
  } finally {
    dir.close();
  }
});

test('same-origin credential rotation is allowed after first use', async () => {
  const dir = directory();
  try {
    expect((await importBangumi(dir)).code).toBe(0);
    const rotated = join(dir.path, 'rotated.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(
      rotated,
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        kid: 'dest-rotated',
        alg: 'ES256',
        key_ops: ['sign'],
      }),
      { mode: 0o600 },
    );
    const requests: string[] = [];
    const again = await runImportCli(
      ['--source', 'bangumi', '--dump', dir.dump, '--state', dir.state, ...credentials(rotated)],
      { fetch: importFetch(requests) as unknown as typeof fetch, testOrigin: origin, clock },
    );
    expect(again.code, again.stderr).toBe(0);
    expect(requests.some((item) => item.includes('/signin/key'))).toBe(true);
  } finally {
    dir.close();
  }
});

test('legacy unbound history stays inspectable, refuses silent publish, then declares without rewriting the journal', async () => {
  const dir = directory();
  try {
    const before = seedLegacy(dir.state, 'wikidata');
    const inspect = await runImportCli(['inspect', '--state', dir.state, '--source', 'wikidata']);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain('API destination: not recorded');
    expect(inspect.stdout).not.toContain('Private request body');

    const requests: string[] = [];
    let keyRead = false;
    const refused = await runImportCli(
      ['--source', 'wikidata', '--dump', dir.dump, '--state', dir.state, ...credentials(dir.key)],
      {
        fetch: importFetch(requests) as unknown as typeof fetch,
        testOrigin: origin,
        clock,
        observer: {
          onAccountKey() {
            keyRead = true;
          },
        },
      },
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('no recorded API origin');
    expect(refused.stderr).toContain('rezics-import destination');
    expect(keyRead).toBe(false);
    expect(requests).toEqual([]);

    const review = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--json',
    ]);
    expect(review.code, review.stderr).toBe(0);
    const document = JSON.parse(review.stdout) as { status: string; reviewRevision: string; recorded: null };
    expect(document.status).toBe('unbound');
    expect(document.recorded).toBeNull();

    dropDiagnosticRecords(dir.state);
    const tablesBefore = tableNames(dir.state);
    const columnsBefore = generationColumns(dir.state);
    expect(columnsBefore).not.toContain('diagnostic_records');

    const declared = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--review-revision',
      document.reviewRevision,
      '--declare',
      '--acknowledge-unverified',
      '--json',
    ]);
    expect(declared.code, declared.stderr).toBe(0);
    const after = JSON.parse(declared.stdout) as { status: string; recorded: string; origin: string };
    expect(after).toMatchObject({ status: 'bound', recorded: 'operator-declared', origin: 'https://api.a.example' });
    expect(generationColumns(dir.state)).toEqual(columnsBefore);
    expect(tableNames(dir.state).filter((name) => name !== 'source_destinations')).toEqual(tablesBefore);
    expect(tableNames(dir.state)).toContain('source_destinations');

    const boundReview = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.b.example',
      '--json',
    ]);
    expect(boundReview.code, boundReview.stderr).toBe(0);
    const boundDocument = JSON.parse(boundReview.stdout) as { status: string; reviewRevision: string; origin: string };
    expect(boundDocument).toMatchObject({ status: 'bound', origin: 'https://api.a.example' });
    const rebound = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.b.example',
      '--review-revision',
      boundDocument.reviewRevision,
      '--declare',
      '--acknowledge-unverified',
    ]);
    expect(rebound.code).toBe(2);
    expect(rebound.stderr).toContain('already has recorded origin');
    expect(generationColumns(dir.state)).toEqual(columnsBefore);
    expect(tableNames(dir.state).filter((name) => name !== 'source_destinations')).toEqual(tablesBefore);

    const database = new Database(dir.state, { readonly: true, create: false });
    expect(database.query('SELECT source,record_key,bytes FROM run_envelopes').all()).toEqual(before.journal);
    expect(database.query('SELECT record_key FROM run_acknowledged').all()).toEqual(before.acknowledged);
    database.close();
  } finally {
    dir.close();
  }
});

test('refused declaration through the destination CLI leaves a legacy generation schema unchanged', async () => {
  const dir = directory();
  try {
    const session = new ImportSession(dir.state);
    insertSourceDestination(session.store.database, 'wikidata', 'https://api.a.example', 'first-use');
    session.close();
    dropDiagnosticRecords(dir.state);
    const tablesBefore = tableNames(dir.state);
    const columnsBefore = generationColumns(dir.state);
    expect(columnsBefore).not.toContain('diagnostic_records');
    const refused = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.b.example',
      '--review-revision',
      'a'.repeat(64),
      '--declare',
      '--acknowledge-unverified',
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('Declaration cannot rebind it');
    expect(generationColumns(dir.state)).toEqual(columnsBefore);
    expect(tableNames(dir.state)).toEqual(tablesBefore);
  } finally {
    dir.close();
  }
});

test('stale review, live owner, missing database and offline preview keep destination honest', async () => {
  const dir = directory();
  try {
    seedLegacy(dir.state, 'wikidata');
    const review = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--json',
    ]);
    const revision = JSON.parse(review.stdout).reviewRevision as string;
    const holder = new ImportSession(dir.state);
    const run = holder.store.begin('wikidata');
    if (run === 'busy') throw new Error('busy');
    const stale = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--review-revision',
      revision,
      '--declare',
      '--acknowledge-unverified',
    ]);
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('stale');
    holder.store.abandon(run);
    const live = holder.acquire('wikidata');
    expect(live).not.toBe('busy');
    const busy = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--json',
    ]);
    const liveDeclare = await runImportCli([
      'destination',
      '--state',
      dir.state,
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
      '--review-revision',
      JSON.parse(busy.stdout).reviewRevision,
      '--declare',
      '--acknowledge-unverified',
    ]);
    expect(liveDeclare.code).toBe(5);
    expect(liveDeclare.stderr).toContain('live or uninspectable owner');
    holder.release(live as { source: string; capability: string });
    holder.close();

    const missing = await runImportCli([
      'destination',
      '--state',
      join(dir.path, 'missing.sqlite'),
      '--source',
      'wikidata',
      '--api',
      'https://api.a.example',
    ]);
    expect(missing.code).toBe(2);

    const preview = await runImportCli(['preview', '--source', 'bangumi', '--dump', dir.dump]);
    expect(preview.code).toBe(0);
    expect(preview.stderr).not.toContain('account-key');
  } finally {
    dir.close();
  }
});
