import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citedAnimeCreditTargets, journeyTargets, selectJourneyWorks } from '../src/showcase-bangumi-journey.ts';
import { runImportCli } from '../src/cli.ts';
import {
  CrossMediaDumpFiles,
  CrossMediaTableScanLimitError,
  collectSelectedDumpRows,
  planCrossMediaSeed,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { ImportTransportError } from '../src/import-client.ts';
import {
  formatSeedFailure,
  remainingRequestFromPreparedCommand,
  remainingRequestFromPreparedJournal,
  readSeedRemainingRequest,
  writeSeedRemainingRequest,
} from '../src/seed-remaining-request.ts';
import {
  FIRST_PUBLIC_IMPORT_ROWS,
  assertCurrentOperatorFact,
  writeWalkInventoryArtifacts,
  receiveWalkInventoryArtifacts,
  sealInterruptedWalkInventory,
  applyWalkInventoryToCapabilities,
  capabilitiesResultCell,
  currentAnimeCharacterIds,
  firstPublicRow,
  licensedVndbArchive,
  retireWalkJournals,
  selectPublished,
  walkChildFailure,
  walkFailureCause,
  walkInventorySummary,
  walkRepairBrief,
  walkRepairSkipReason,
  walkSeedChildEnv,
  type WalkInventory,
  type WalkRowResult,
} from '../src/imports-public-journey.ts';
import {
  BOOK_OWNER_GRANT_ACTIONS,
  admitOrdinaryOwnerGrantStatus,
  grantOrdinaryOwnerActions,
  ordinaryOwnerGrantBody,
  ordinaryOwnerGrantKey,
  ordinaryOwnerGrantResource,
} from '../src/ordinary-owner-grants.ts';

function publishedRow(sourceKey: string, provider = 'bangumi') {
  return {
    provider,
    sourceKey,
    subjectId: `subject-${provider}-${sourceKey}`,
    nativeType: 'schema:Book',
    readerRoute: `/subjects/subject-${provider}-${sourceKey}`,
    assertions: [{ citations: [`https://bgm.tv/subject/${sourceKey}`] }],
  };
}

test('the journey visits the selected anime and both light-novel families once each', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  const works = selectJourneyWorks([...published, publishedRow('999', 'vndb')]);
  expect(works.map((work) => work.sourceKey)).toEqual(journeyTargets.map((target) => target.sourceKey));
  expect(works.find((work) => work.sourceKey === '233')).toMatchObject({ role: 'anime' });
  expect(works.find((work) => work.sourceKey === '5329')).toMatchObject({ role: 'volume', series: '2815' });
  expect(works.find((work) => work.sourceKey === '10862')).toMatchObject({ role: 'volume', series: '2815' });
});

test('a missing or duplicated target stops the journey by its exact source key', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  expect(() => selectJourneyWorks(published.filter((row) => row.sourceKey !== '233'))).toThrow(
    'journey target bangumi:233 has 0 rows',
  );
  expect(() => selectJourneyWorks([...published, publishedRow('2815')])).toThrow(
    'journey target bangumi:2815 has 2 rows',
  );
});

test('anime Work targets require the selected Bangumi credit row and preserve its exact citation', () => {
  const statement = (id: string, property: string, target: string, citation: string) => ({
    id,
    property: { id: property },
    value: { type: 'value', content: target },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: citation },
          },
        ],
      },
    ],
  });
  const read = {
    subject: {
      id: 'anime-233',
      type: 'schema:TVSeries',
      statements: {
        'wdt:P725': [
          statement('voice-1', 'wdt:P725', 'person-1', 'https://bgm.tv/subject/233#/person-characters/233/16/304'),
          statement(
            'voice-unrelated',
            'wdt:P725',
            'person-unrelated',
            'https://bgm.tv/subject/2815#/person-characters/2815/16/304',
          ),
        ],
        'schema:director': [
          statement(
            'director-1',
            'schema:director',
            'person-2',
            'https://bgm.tv/subject/233#/subject-persons/233/42/position',
          ),
          statement('director-uncited', 'schema:director', 'person-3', 'https://bgm.tv/subject/233'),
        ],
      },
    },
  };

  expect(citedAnimeCreditTargets(read, '233', 'cast')).toEqual([
    expect.objectContaining({
      id: 'person-1',
      property: 'wdt:P725',
      citation: 'https://bgm.tv/subject/233#/person-characters/233/16/304',
      statementId: 'voice-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
  expect(citedAnimeCreditTargets(read, '233', 'staff')).toEqual([
    expect.objectContaining({
      id: 'person-2',
      property: 'schema:director',
      citation: 'https://bgm.tv/subject/233#/subject-persons/233/42/position',
      statementId: 'director-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
});

test('I05 current Character reads keep only wd:Q95074 schema:character endpoints', () => {
  expect(
    currentAnimeCharacterIds([
      { property: 'schema:character', summary: { id: 'character-1', type: 'wd:Q95074' } },
      { property: 'schema:character', summary: { id: 'character-1', type: 'wd:Q95074' } },
      { property: 'wdt:P725', summary: { id: 'person-1', type: 'schema:Person' } },
      { property: 'schema:character', summary: { id: 'work-1', type: 'schema:TVSeries' } },
    ]),
  ).toEqual(['character-1']);
  expect(() =>
    currentAnimeCharacterIds([{ property: 'wdt:P725', summary: { id: 'person-1', type: 'schema:Person' } }]),
  ).toThrow('anime has no current Characters');
});

test('the first-public walk names twelve operator and catalogue rows once each', () => {
  expect(FIRST_PUBLIC_IMPORT_ROWS.map((row) => row.id)).toEqual([
    'I01',
    'I02',
    'I03',
    'I04',
    'I05',
    'I06',
    'I07',
    'I08',
    'I09',
    'I10',
    'I11',
    'I12',
  ]);
  expect(firstPublicRow('I03').path).toContain('Open Library');
  expect(firstPublicRow('I11').path).toContain('499');
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  expect(selectPublished(published, 'bangumi', '2815').sourceKey).toBe('2815');
  expect(() => selectPublished(published, 'bangumi', 'missing')).toThrow('published bangumi:missing has 0 rows');
});

test('ordinary owner grants use one action, a stable receipt key, and admit replay', () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const resource = ordinaryOwnerGrantResource();
  expect(BOOK_OWNER_GRANT_ACTIONS).toEqual(['statement:propose', 'context:accept', 'context:adopt']);
  expect(ordinaryOwnerGrantBody(account, 'context:adopt')).toEqual({
    resource,
    subject: { kind: 'account', id: account },
    actions: ['context:adopt'],
    valid: '(,)',
  });
  expect(ordinaryOwnerGrantKey(resource, account, 'context:adopt')).toBe(
    `accounts.grant:0:${resource.id}:${account}:context:adopt`,
  );
  expect(admitOrdinaryOwnerGrantStatus(201)).toBe(true);
  expect(admitOrdinaryOwnerGrantStatus(409)).toBe(true);
  expect(admitOrdinaryOwnerGrantStatus(403)).toBe(false);
});

test('ordinary owner grants post one action at a time and treat 409 as replay', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const posted: { action: string; key: string }[] = [];
  await grantOrdinaryOwnerActions({
    accountId: account,
    actions: BOOK_OWNER_GRANT_ACTIONS,
    post: async ({ body, idempotencyKey }) => {
      posted.push({ action: body.actions[0]!, key: idempotencyKey });
      return { status: posted.length === 1 ? 201 : 409, text: '' };
    },
  });
  expect(posted.map((row) => row.action)).toEqual([...BOOK_OWNER_GRANT_ACTIONS]);
  expect(posted[1]!.key).toContain('context:accept');
  await expect(
    grantOrdinaryOwnerActions({
      accountId: account,
      actions: ['context:adopt'],
      post: async () => ({ status: 403, text: 'forbidden' }),
    }),
  ).rejects.toThrow('Grant context:adopt');
});

test('the licensed VNDB walk archive starts with TIMESTAMP then db/vn.header', async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of licensedVndbArchive()) chunks.push(chunk);
  expect(new TextDecoder().decode(chunks[0]!.subarray(0, 9))).toBe('TIMESTAMP');
  expect(new TextDecoder().decode(chunks[1]!.subarray(0, 12))).toBe('db/vn.header');
  expect(chunks.at(-1)?.byteLength).toBe(1024);
});

test('the walk inventory reports passing over twelve and the slowest failing journey', () => {
  const inventory: WalkInventory = {
    command: 'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts',
    revision: 'abc',
    startedAt: '2026-11-07T00:00:00Z',
    endedAt: '2026-11-07T00:10:00Z',
    passing: 10,
    total: 12,
    slowestFailing: {
      id: 'I06',
      path: 'Game/Release/counterpart',
      elapsedMs: 12_000,
      cause: 'seed published no Game identity',
    },
    rows: FIRST_PUBLIC_IMPORT_ROWS.map((row) => ({
      id: row.id,
      path: row.path,
      result: row.id === 'I06' || row.id === 'I09' ? 'failing' : 'passing',
      elapsedMs: row.id === 'I06' ? 12_000 : 100,
      cause: row.id === 'I06' ? 'seed published no Game identity' : row.id === 'I09' ? 'no tag' : null,
      evidence: {},
    })),
  };
  expect(walkInventorySummary(inventory)).toBe(
    '10/12 passing; slowest failing I06 12000ms seed published no Game identity; 2 failing',
  );
});

test('the walk inventory replaces each pending capabilities row and names the slowest failure', () => {
  const failing: WalkRowResult = {
    id: 'I06',
    path: 'Game/Release/counterpart',
    result: 'failing',
    elapsedMs: 12_000,
    cause: 'seed published no Game identity',
    evidence: { seed: true },
  };
  const passing: WalkRowResult = {
    id: 'I01',
    path: 'Bangumi operator',
    result: 'passing',
    elapsedMs: 40,
    cause: null,
    evidence: { id: 'subject-1', type: 'schema:Thing' },
  };
  expect(capabilitiesResultCell(passing)).toContain('passing; 40ms; id subject-1');
  const markdown = `| Path | Scope | Current dev result and evidence |\n| ---- | ----- | ------------------------------- |\n| I01  | Bangumi operator | Pending initial dev walk.       |\n| I06  | Game | Pending initial dev walk.       |\n\nBooks owner-grant composition uses the ordinary Global grant intent.\n`;
  const updated = applyWalkInventoryToCapabilities(markdown, {
    command: 'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts',
    revision: 'abc',
    startedAt: '2026-11-07T00:00:00Z',
    endedAt: '2026-11-07T00:10:00Z',
    passing: 1,
    total: 2,
    slowestFailing: { id: 'I06', path: failing.path, elapsedMs: 12_000, cause: failing.cause! },
    rows: [passing, failing],
  });
  expect(updated).toContain('passing; 40ms; id subject-1, type schema:Thing');
  expect(updated).toContain('failing; 12000ms; seed published no Game identity');
  expect(updated).toContain('### Observed walk');
  expect(updated).toContain('Slowest failing: I06 12000ms seed published no Game identity.');
  expect(updated).toContain('Books owner-grant composition uses the ordinary Global grant intent.');
  const adjacent = updated.replace('\n\nBooks owner-grant', '\nBooks owner-grant');
  const rewritten = applyWalkInventoryToCapabilities(adjacent, {
    command: 'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts',
    revision: 'def',
    startedAt: '2026-11-07T01:00:00Z',
    endedAt: '2026-11-07T01:20:00Z',
    passing: 1,
    total: 2,
    slowestFailing: { id: 'I06', path: failing.path, elapsedMs: 4_000, cause: failing.cause! },
    rows: [passing, failing],
  });
  expect(rewritten).toContain('Revision `def`.');
  expect(rewritten).toContain('Slowest failing: I06 4000ms seed published no Game identity.');
  expect(rewritten).toContain('Books owner-grant composition uses the ordinary Global grant intent.');
  expect(walkRepairSkipReason(failing)).toBeNull();
  expect(
    walkRepairBrief(
      {
        command: 'walk',
        revision: 'abc',
        startedAt: 't0',
        endedAt: 't1',
        passing: 1,
        total: 2,
        slowestFailing: { id: 'I06', path: failing.path, elapsedMs: 12_000, cause: failing.cause! },
        rows: [passing, failing],
      },
      failing,
    ),
  ).toContain('Goal: imports');
  expect(
    walkRepairSkipReason({
      ...failing,
      id: 'I09',
      cause: 'same-handle continuation lost the independent property',
    }),
  ).toContain('same-handle continuation');
});

test('walk seed env uses native Auth transport and keeps the issuer for CSRF audience', async () => {
  const stack = {
    web: 'http://127.0.0.1:20060',
    issuer: 'http://127.0.0.1:20061',
    native: 'http://127.0.0.1:20062',
    kernel: 'http://127.0.0.1:20063',
  };
  const env = walkSeedChildEnv(stack, { REZICS_DEV_PERSONA_ACCOUNT: 'persona' }, { PATH: '/bin' });
  expect(env.AUTH_ORIGIN).toBe(stack.native);
  expect(env.REZICS_LOCAL_STACK_ISSUER_ORIGIN).toBe(stack.issuer);
  expect(env.KERNEL_ORIGIN).toBe(stack.kernel);
  expect(env.REZICS_DEV_PERSONA_ACCOUNT).toBe('persona');
  const source = await readFile(join(import.meta.dir, '../src/imports-public-journey.ts'), 'utf8');
  const seedAt = source.indexOf('scripts/datasets/cross-media-seed.ts');
  const pagesAt = source.search(/startWalkStackActions\(\s*\['pages', 'web'\]/);
  expect(seedAt).toBeGreaterThan(0);
  expect(pagesAt).toBeGreaterThan(seedAt);
});

test('ordinary CLI admits loopback HTTP Auth with the kernel test origin', async () => {
  const argv = [
    '--source',
    'bangumi',
    '--dump',
    '-',
    '--state',
    '/tmp/imports-walk-cli-origin.sqlite',
    '--api',
    'http://127.0.0.1:9',
    '--auth',
    'http://127.0.0.1:8',
    '--account-key',
    '/dev/null',
    '--account',
    '00000000-0000-0000-0000-000000000001',
    '--client',
    'walk',
  ];
  const loopback = await runImportCli(argv, { testOrigin: 'http://127.0.0.1:9' });
  expect(loopback.stderr).not.toContain('Invalid importer arguments.');
  const remote = await runImportCli(
    argv.map((value) => (value === 'http://127.0.0.1:8' ? 'http://example.test' : value)),
    { testOrigin: 'http://127.0.0.1:9' },
  );
  expect(remote.code).toBe(2);
  expect(remote.stderr).toContain('Invalid importer arguments.');
});

test('leftover walk journals are archived before persona so wiped slot databases cannot replay native IDs', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'imports-walk-journals-'));
  try {
    const seed = join(repository, '.temp/cross-media-seed');
    const walk = join(repository, '.temp/imports-walk/i01');
    await mkdir(seed, { recursive: true });
    await mkdir(walk, { recursive: true });
    await writeFile(join(seed, 'state.sqlite'), 'old-seed-ids');
    await writeFile(join(walk, 'state.sqlite'), 'old-operator-ids');
    await retireWalkJournals(repository);
    expect(await Bun.file(join(seed, 'state.sqlite')).exists()).toBe(false);
    expect(await Bun.file(join(walk, 'state.sqlite')).exists()).toBe(false);
    const archives = join(repository, '.temp/local-stack/seed-archives');
    const archived = await readdir(archives);
    expect(archived.some((name) => name.startsWith('cross-media-seed-'))).toBe(true);
    expect(archived.some((name) => name.startsWith('imports-walk-'))).toBe(true);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('operator causes keep safe status and request metadata without private nested text', () => {
  expect(walkFailureCause(new ImportTransportError(404))).toContain('status=404');
  expect(walkFailureCause(new ImportTransportError(403, 'about:blank', 'forbidden'))).toContain(
    'status=403 problem=forbidden',
  );
  const named = new ImportTransportError(503, undefined, undefined, false, undefined, undefined, {
    method: 'POST',
    path: '/v1/subjects:batchWrite',
  });
  expect(walkFailureCause(named)).toContain('method=POST target=unknown-origin/v1/subjects:batchWrite status=503');
  const nested = new ImportTransportError();
  nested.cause = new TypeError('Import requests must target the configured API origin under /v1/');
  expect(walkFailureCause(nested)).not.toContain('Import requests must target');
  expect(
    walkChildFailure(
      'seed',
      1,
      'Invalid record binding operation\nded its bounded scan\n',
      'TypeError: Invalid record binding operation\n',
    ).message,
  ).toBe('seed exited 1: TypeError: Invalid record binding operation');
  expect(walkChildFailure('seed', 1, 'noise\n', 'Invalid record binding operation\n').message).toBe(
    'seed exited 1: Invalid record binding operation',
  );
});

test('seed remaining request names the prepared classification create without bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-remaining-'));
  try {
    const remaining = remainingRequestFromPreparedCommand({
      op: 'create',
      source: {
        source: 'vndb_cross_media',
        external_id: 'vocabulary:vndb.releases.media',
        converter_revision: 'vndb-release-classification-vocabulary@1',
      },
      subject: { type: 'skos:ConceptScheme' },
    });
    expect(remaining).toEqual({
      method: 'POST',
      path: '/v1/subjects:batchWrite',
      op: 'create',
      source: 'vndb_cross_media',
      externalId: 'vocabulary:vndb.releases.media',
      nativeType: 'skos:ConceptScheme',
      converter: 'vndb-release-classification-vocabulary@1',
      journalState: 'prepared',
    });
    const error = new ImportTransportError();
    expect(formatSeedFailure(undefined, remaining)).toBe(
      'POST /v1/subjects:batchWrite create vndb_cross_media vocabulary:vndb.releases.media skos:ConceptScheme',
    );
    expect(walkFailureCause(error)).toContain('status=none');
    await writeSeedRemainingRequest(directory, remaining);
    expect(JSON.parse(await readFile(join(directory, 'remaining-request.json'), 'utf8'))).toEqual(remaining);
    const journal = join(directory, 'showcase.sqlite');
    const { Database } = await import('bun:sqlite');
    const db = new Database(journal);
    db.exec(
      `CREATE TABLE showcase_command (command_key TEXT PRIMARY KEY, command_json TEXT NOT NULL, state TEXT NOT NULL)`,
    );
    db.run(
      'INSERT INTO showcase_command VALUES (\'k\',\'{"op":"create","source":{"source":"vndb_cross_media","external_id":"vocabulary:vndb.releases.media","converter_revision":"vndb-release-classification-vocabulary@1"},"subject":{"type":"skos:ConceptScheme"}}\',\'prepared\')',
    );
    db.close();
    expect(remainingRequestFromPreparedJournal(journal)?.externalId).toBe('vocabulary:vndb.releases.media');
    const reviewed = {
      method: 'POST',
      path: '/v1/subjects:batchWrite',
      op: 'propose' as const,
      source: 'rezics_reviewed_vocabulary',
      externalId: 'v1:reviewed-episode-type-1',
      nativeType: 'skos:Concept',
      converter: 'reviewed-vocabulary@1',
      journalState: 'prepared' as const,
      status: 503,
      type: 'https://rezics.com/problems/transaction_retry_exhausted',
      code: 'transaction_retry_exhausted',
    };
    await writeSeedRemainingRequest(directory, reviewed);
    expect(await readSeedRemainingRequest(directory)).toMatchObject({
      method: 'POST',
      path: '/v1/subjects:batchWrite',
      op: 'propose',
      source: 'rezics_reviewed_vocabulary',
      nativeType: 'skos:Concept',
      status: 503,
      code: 'transaction_retry_exhausted',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded VNDB entry_meta pages continue until selected revisions are found', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entry-meta-continue-'));
  try {
    const db = join(directory, 'db');
    await mkdir(db);
    await writeFile(join(db, 'entry_meta.header'), 'id\trevision\tlastmod\n');
    await writeFile(
      join(db, 'entry_meta'),
      [
        'c1\t1\t2026-10-25 00:00:00+00',
        'c2\t1\t2026-10-25 00:00:00+00',
        'c3\t1\t2026-10-25 00:00:00+00',
        'v1\t7\t2026-10-25 00:00:00+00',
      ].join('\n') + '\n',
    );
    const input = new CrossMediaDumpFiles(directory, directory);
    const found = new Map<string, number>();
    const remaining = new Set(['v1']);
    await collectSelectedDumpRows(input, 'vndb', 'entry_meta', {
      limits: { maxRows: 2, maxBytes: 1024 },
      select: (row) => remaining.has(String(row.id ?? '')),
      onRow(row) {
        found.set(String(row.id), Number(row.revision));
        remaining.delete(String(row.id));
      },
      done: () => remaining.size === 0,
      onLimit() {
        throw new Error('selected VNDB entry_meta stopped before continuation finished');
      },
    });
    expect(found).toEqual(new Map([['v1', 7]]));

    const duckFound = new Map<string, number>();
    const duckRemaining = new Set(['v1']);
    const duck: CrossMediaTables = {
      async *rows(provider, table, limits) {
        if (provider !== 'vndb' || table !== 'entry_meta') return;
        if ((limits?.resumeBytes ?? 0) === 0) {
          yield { id: 'c1', revision: 1, lastmod: '2026-10-25 00:00:00+00' };
          const error = new Error('Cross-media vndb/entry_meta exceeded its bounded scan');
          error.name = 'CrossMediaTableScanLimitError';
          Object.assign(error, { resumeBytes: 48, table: 'entry_meta' });
          throw error;
        }
        yield { id: 'v1', revision: 9, lastmod: '2026-10-25 00:00:00+00' };
      },
    };
    await collectSelectedDumpRows(duck, 'vndb', 'entry_meta', {
      limits: { maxRows: 2, maxBytes: 1024 },
      select: (row) => duckRemaining.has(String(row.id ?? '')),
      onRow(row) {
        duckFound.set(String(row.id), Number(row.revision));
        duckRemaining.delete(String(row.id));
      },
      done: () => duckRemaining.size === 0,
      onLimit() {
        throw new Error('duck-typed VNDB entry_meta stopped before continuation finished');
      },
    });
    expect(duckFound).toEqual(new Map([['v1', 9]]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [{ id: 1, type: 2, name: 'STEINS;GATE' }],
    'vndb/vn_titles': [{ id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null }],
    'vndb/vn': [{ id: 'v1', olang: 'ja', alias: null }],
  };
  const stalled: CrossMediaTables = {
    async *rows(provider, table, limits) {
      if (provider === 'vndb' && table === 'entry_meta')
        throw new CrossMediaTableScanLimitError(provider, table, limits?.resumeBytes ?? 0);
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
  const plan = await planCrossMediaSeed(stalled, {
    selection: { bangumi: [1], vndb: ['v1'], includeReleases: false },
  });
  expect(plan.records.vndb).toEqual([]);
  expect(plan.gaps.some((gap) => gap.reason.includes('entry_meta exceeded its bounded scan'))).toBe(true);
});

test('current operator acceptance requires the exact adopted value and citation after reopen', () => {
  const statement = {
    property: { id: 'schema:name' },
    value: { type: 'value', content: 'Licensed title' },
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/233' } }] },
    ],
  };
  const read = (facts: unknown[]) => ({ subject: { statements: { 'schema:name': facts } } });
  expect(() =>
    assertCurrentOperatorFact(read([{ ...statement, id: 'current-id', rank: 'normal' }]), 'schema:name', statement),
  ).not.toThrow();
  expect(() => assertCurrentOperatorFact(read([]), 'schema:name', statement)).toThrow('anonymous current');
  expect(() => assertCurrentOperatorFact(read([{ ...statement, references: [] }]), 'schema:name', statement)).toThrow(
    'provenance',
  );
  expect(() =>
    assertCurrentOperatorFact(
      read([{ ...statement, value: { type: 'value', content: 'Other title' } }]),
      'schema:name',
      statement,
    ),
  ).toThrow('anonymous current');
});

test('walk outputs preserve source documents and sibling drafts and group a shared seed repair', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'imports-walk-output-'));
  try {
    const document = join(repository, 'docs/goals/imports.capabilities.md');
    await mkdir(join(repository, 'docs/goals'), { recursive: true });
    await mkdir(join(repository, '.temp/continuation'), { recursive: true });
    const original =
      '| I05 | Anime | Pending |\n| I11 | Books | Pending |\n\nBooks owner-grant composition uses ordinary grants.\n';
    await writeFile(document, original);
    const sibling = join(repository, '.temp/continuation/sibling.md');
    await writeFile(sibling, 'another owner');
    const rows: WalkRowResult[] = (['I05', 'I11'] as const).map((id) => ({
      id,
      path: id,
      result: 'failing',
      elapsedMs: 41000,
      cause: 'semantic_not_ready POST /v1/subjects:batchWrite',
      evidence: { seed: true },
    }));
    const inventory: WalkInventory = {
      command: 'walk',
      revision: 'source-head',
      startedAt: 't0',
      endedAt: 't1',
      passing: 0,
      total: 2,
      slowestFailing: { id: 'I05', path: 'Anime', elapsedMs: 41000, cause: rows[0]!.cause! },
      rows,
    };
    await writeWalkInventoryArtifacts(inventory, repository);
    expect(await readFile(document, 'utf8')).toBe(original);
    expect(await readFile(sibling, 'utf8')).toBe('another owner');
    const draft = await readFile(join(repository, '.temp/imports-walk/continuation/imports-walk-seed.md'), 'utf8');
    expect(draft).toContain('Affected rows: I05, I11');
    expect(draft).toContain('Elapsed seed work: 41000ms');
    expect(draft).toContain('Semantic cf23');
    expect(draft).toContain('No catalogue current read or browser path was exercised');
    await writeFile(join(repository, '.temp/imports-walk/inventory.json'), JSON.stringify(inventory));
    await receiveWalkInventoryArtifacts(repository);
    expect(await readFile(document, 'utf8')).toContain('Revision `source-head`');
    expect(await readFile(join(repository, '.temp/continuation/imports-walk-seed.md'), 'utf8')).toBe(draft);
    expect(await readFile(sibling, 'utf8')).toBe('another owner');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a settled infrastructure termination seals only its active row and keeps its duration unknown', () => {
  const rows: WalkRowResult[] = FIRST_PUBLIC_IMPORT_ROWS.filter((row) => row.id !== 'I03').map((row) => ({
    ...row,
    result: 'failing',
    elapsedMs: 100,
    cause: 'semantic_not_ready',
    evidence: {},
  }));
  const run = { command: 'retained walk', revision: 'abc', startedAt: '2026-11-07T12:14:28Z' };
  const active = { id: 'I03' as const, startedAt: '2026-11-07T12:16:06Z' };
  const terminal = {
    finishedAt: '2026-11-07T14:08:48Z',
    cause: 'remote run timed out',
    checkId: 'check',
    runElapsedMs: 7204023,
  };
  const inventory = sealInterruptedWalkInventory(run, rows, active, terminal);
  expect(inventory.passing).toBe(0);
  expect(inventory.rows).toHaveLength(12);
  expect(inventory.rows.find((row) => row.id === 'I03')).toMatchObject({
    result: 'failing',
    elapsedMs: null,
    evidence: { interrupted: true, runElapsedMs: 7204023 },
  });
  expect(inventory.rows.find((row) => row.id === 'I01')).toEqual(rows[0]);
  expect(capabilitiesResultCell(inventory.rows[2]!)).toContain('duration unknown');
  expect(() => sealInterruptedWalkInventory(run, rows.slice(1), active, terminal)).toThrow(
    'No returned walk observation for I01',
  );
});
