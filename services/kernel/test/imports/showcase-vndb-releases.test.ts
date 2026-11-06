import { openApiObserver } from './api-observer.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { BULK_ACTION } from '../../../../specs/imports-identity-driver.ts';
import {
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
} from '../../../importer/src/vndb-release-fidelity.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  runCrossMediaSeedCli,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { seedShowcaseVndbReleases } from '../../../importer/src/showcase-vndb-releases.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

/** Compact COPY-shaped selected family. These rows are not observed public dump evidence. */
function family(released = '20200229'): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/releases': [
      { id: 'r1', released },
      { id: 'r2', released: '99999999' },
      { id: 'r3', released: '20210101' },
    ],
    'vndb/releases_titles': [
      { id: 'r1', lang: 'ja', mtl: 't', title: 'Selected day release', latin: null },
      { id: 'r2', lang: 'ja', mtl: 't', title: 'Selected TBA release', latin: null },
      { id: 'r3', lang: 'ja', mtl: 't', title: 'Unselected owner', latin: null },
    ],
    'vndb/releases_vn': [
      { id: 'r1', vid: 'v1', rtype: 'complete' },
      { id: 'r2', vid: 'v1', rtype: 'bundle' },
      { id: 'r3', vid: 'v99', rtype: 'complete' },
    ],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

async function writeCrossMediaDump(directory: string, platform: string): Promise<{ bangumi: string; vndb: string }> {
  const bangumi = join(directory, 'bangumi');
  const vndb = join(directory, 'vndb');
  await mkdir(join(vndb, 'db'), { recursive: true });
  for (const table of [
    'subject-relations',
    'subject-characters',
    'subject-persons',
    'person-characters',
    'person-relations',
    'character',
    'person',
  ]) {
    await writeFile(join(bangumi, `${table}.jsonlines`), '');
  }
  await writeFile(
    join(bangumi, 'subject.jsonlines'),
    `${JSON.stringify({ id: 1, type: 4, name: 'Selected Work', infobox: '{{Infobox Game\n|平台=PC\n}}' })}\n`,
  );

  const tables: Record<string, { columns: string[]; rows?: Record<string, string | number | null>[] }> = {
    vn_titles: {
      columns: ['id', 'lang', 'official', 'title', 'latin'],
      rows: [{ id: 'v1', lang: 'ja', official: 't', title: 'Selected Work', latin: null }],
    },
    vn: {
      columns: ['id', 'olang', 'alias', 'devstatus'],
      rows: [{ id: 'v1', olang: 'ja', alias: null, devstatus: 1 }],
    },
    entry_meta: {
      columns: ['id', 'revision', 'lastmod'],
      rows: [{ id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' }],
    },
    releases: {
      columns: ['id', 'released', 'olang', 'minage', 'gtin'],
      rows: [{ id: 'r1', released: '20200229', olang: 'ja', minage: 0, gtin: null }],
    },
    releases_titles: {
      columns: ['id', 'lang', 'mtl', 'title', 'latin'],
      rows: [{ id: 'r1', lang: 'ja', mtl: 't', title: 'Selected Release', latin: null }],
    },
    releases_vn: { columns: ['id', 'vid', 'rtype'], rows: [{ id: 'r1', vid: 'v1', rtype: 'complete' }] },
    releases_supersedes: { columns: ['id', 'rid'] },
    releases_platforms: { columns: ['id', 'platform'], rows: [{ id: 'r1', platform }] },
    releases_media: { columns: ['id', 'medium', 'qty'], rows: [{ id: 'r1', medium: 'cd', qty: null }] },
    chars: {
      columns: [
        'id',
        'image',
        'bloodt',
        'cup_size',
        'sex',
        'spoil_sex',
        'gender',
        'spoil_gender',
        'main',
        'main_spoil',
        's_bust',
        's_waist',
        's_hip',
        'birthday',
        'height',
        'weight',
        'age',
        'description',
      ],
    },
    producers_relations: { columns: ['id', 'pid', 'relation'] },
    tags: { columns: ['id', 'cat', 'defaultspoil', 'searchable', 'applicable', 'name', 'alias', 'description'] },
    tags_parents: { columns: ['id', 'parent', 'main'] },
    tags_vn: { columns: ['date', 'tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore', 'lie', 'notes'] },
    vn_extlinks: { columns: ['id', 'link'] },
    extlinks: { columns: ['id', 'site', 'value'] },
  };
  for (const table of [
    'vn_relations',
    'vn_staff',
    'vn_seiyuu',
    'staff_alias',
    'staff',
    'chars_traits',
    'chars_vns',
    'vn_anime',
    'releases_producers',
    'producers',
    'anime',
  ])
    tables[table] ??= { columns: ['id'] };
  for (const [table, specification] of Object.entries(tables)) {
    await writeFile(join(vndb, 'db', `${table}.header`), `${specification.columns.join('\t')}\n`);
    const rows = specification.rows ?? [];
    await writeFile(
      join(vndb, 'db', table),
      rows
        .map((row) =>
          specification.columns.map((column) => (row[column] == null ? '\\N' : String(row[column]))).join('\t'),
        )
        .join('\n') + (rows.length ? '\n' : ''),
    );
  }
  return { bangumi, vndb };
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    qualifiers?: { property: { id: string } }[];
  };
  source?: unknown;
};

test('ordinary selected-family seed publishes current VNDB release dates and states through accept, public read and refresh', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const create = async (key: string, externalId: string, digest: string, type: string, label: string) => {
      const created = await runtime.importTransport.batch({
        commands: [
          {
            op: 'create',
            key,
            source: {
              source: 'authored-vndb-release-states',
              external_id: externalId,
              record_revision: 'unversioned',
              digest,
              converter_revision: 'authored@1',
              field_group: 'facts',
            },
            subject: { type, labels: { en: label } },
          },
        ],
      });
      expect(created.results[0]?.status).toBe(201);
      return (created.results[0] as { value: { id: string } }).value.id;
    };
    const propose = async (
      key: string,
      externalId: string,
      digest: string,
      subject: string,
      property: string,
      content: string,
      citation: string,
    ) => {
      const result = await runtime.importTransport.batch({
        commands: [
          {
            op: 'propose',
            key,
            source: {
              source: 'authored-vndb-release-states',
              external_id: externalId,
              record_revision: 'unversioned',
              digest,
              converter_revision: 'authored@1',
              field_group: 'facts',
            },
            subject,
            statement: {
              property: { id: property },
              value: { type: 'value', content },
              references: [
                { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
              ],
            },
          },
        ],
      });
      expect(result.results[0]?.status).toBe(201);
    };
    async function acceptAdopt(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.source) ?? listing.candidates[0]!;
      const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
        context: globalContext,
        expected_head: candidate.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }
    const path = join(directory, 'state.sqlite');
    const tables = family();
    const plan = await planCrossMediaSeed(tables);
    const extras = { providers: ['vndb'] as const, mediaDeadlineMs: 0 };
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path,
      port: runtime.importTransport,
      destination: { origin: 'https://kernel.import.test' },
      extras,
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.bindings.releaseDigest).toBe(bundledDigest);
    expect(first.facts.releases.has('r3')).toBe(false);
    expect(first.vocabularyGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/releases_vn/r1/v1',
          code: 'complete',
          reason: 'qualifier_not_admitted',
          property: 'wdt:P31',
        }),
      ]),
    );
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const workId = idOf(first.readings.find((row) => row.externalId === 'v1')!);
    const exactId = idOf(first.readings.find((row) => row.externalId === 'r1')!);
    const tbaId = idOf(first.readings.find((row) => row.externalId === 'r2')!);
    expect(workId && exactId && tbaId && exactId !== workId).toBeTruthy();
    expect(first.readings.some((row) => row.externalId === 'r3')).toBe(false);
    await acceptAdopt(exactId!, 'schema:datePublished');
    await acceptAdopt(exactId!, 'schema:exampleOfWork');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          statements: Record<string, { value: { content: unknown }; qualifiers?: { property: { id: string } }[] }[]>;
        };
      };
    };
    const workView = await read(workId!);
    expect(workView.subject.type).toBe('wd:Q689445');
    expect(workView.subject.statements['schema:keywords'] ?? []).toEqual([]);
    const exactView = await read(exactId!);
    expect(exactView.subject.type).toBe('wd:Q20631656');
    expect(exactView.subject.statements['schema:exampleOfWork']?.map((item) => item.value.content)).toEqual([workId]);
    expect(exactView.subject.statements['schema:exampleOfWork']?.[0]?.qualifiers ?? []).toEqual([]);
    expect(exactView.subject.statements['schema:datePublished']?.[0]?.value.content).toEqual(
      expect.objectContaining({ time: '+2020-02-29T00:00:00Z', precision: 11 }),
    );
    const tbaView = await read(tbaId!);
    expect(tbaView.subject.statements['schema:datePublished'] ?? []).toEqual([]);
    expect(tbaView.subject.statements['schema:keywords'] ?? []).toEqual([]);
    const schemeId = await create(
      'authored-vndb-development-status-scheme',
      'scheme',
      'a'.repeat(64),
      'skos:ConceptScheme',
      'Authored VNDB development status',
    );
    const statusId = await create(
      'authored-vndb-development-status-1',
      'in-development',
      'b'.repeat(64),
      'skos:Concept',
      'In development',
    );
    await propose(
      'authored-scheme-url',
      'scheme',
      'a'.repeat(64),
      schemeId,
      'schema:url',
      developmentStatusSchemeUri,
      developmentStatusSchemeUri,
    );
    await propose(
      'authored-status-url',
      'in-development',
      'b'.repeat(64),
      statusId,
      'schema:url',
      developmentStatusConceptUri('1'),
      developmentStatusConceptUri('1'),
    );
    await propose(
      'authored-status-scheme',
      'in-development',
      'b'.repeat(64),
      statusId,
      'skos:inScheme',
      schemeId,
      developmentStatusConceptUri('1'),
    );
    await acceptAdopt(schemeId, 'schema:url');
    await acceptAdopt(statusId, 'schema:url');
    await acceptAdopt(statusId, 'skos:inScheme');
    const groups = [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ];
    const refreshed = await seedShowcaseVndbReleases({
      tables,
      plan,
      path,
      port: runtime.importTransport,
      groups,
      destination: { origin: 'https://kernel.import.test' },
      extras,
    });
    expect(idOf(refreshed.readings.find((row) => row.externalId === 'r1')!)).toBe(exactId);
    await acceptAdopt(workId!, 'schema:keywords');
    expect((await read(workId!)).subject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([
      statusId,
    ]);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await seedShowcaseVndbReleases({
      tables: family('20200401'),
      plan,
      path,
      port: runtime.importTransport,
      groups,
      destination: { origin: 'https://kernel.import.test' },
      extras,
    });
    const fencedDates = await editor.http(
      `/v1/subjects/${exactId}/candidates?${new URLSearchParams({ property: 'schema:datePublished', context: globalContext, limit: '100' })}`,
    );
    const times = (fencedDates.body as { candidates: Candidate[] }).candidates.map(
      (item) => (item.statement.value.content as { time?: string }).time,
    );
    expect(times).not.toContain('+2020-04-01T00:00:00Z');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

test('cross-media CLI retains selected release classifications through later vocabulary reseeding', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'cross-media-release-cli-native-'));
  const authOrigin = 'https://auth.cross-media.test';
  const originalFetch = globalThis.fetch;
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const support = identitySupport(runtime.identity);
    const scopes = [...VNDB_IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt', 'access:grant'];
    const clientId = `cross-media-${randomUUID()}`;
    await runtime.identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
    const signIn = await support.request('/signin', {
      email: 'governance@identity.test',
      password: 'private native identity fixture password',
      client_id: clientId,
      scope: scopes,
    });
    expect(signIn.status).toBe(200);
    const tokenResponse = await support.request(
      '/token',
      {},
      new Headers({
        cookie: signIn.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const bearer = ((await tokenResponse.json()) as { access_token: string }).access_token;
    const grant = await runtime.request(
      '/v1/grants',
      {
        resource: { route: 0, id: globalContext },
        subject: { kind: 'account', id: runtime.identity.governance.accountId },
        actions: [
          'subject:create',
          BULK_ACTION,
          'subject:read',
          'statement:propose',
          'source_fence:read',
          'media:import_from_url',
          'context:accept',
          'context:adopt',
        ],
        valid: '(,)',
      },
      bearer,
    );
    expect(grant.status).toBe(201);

    // Reviewed source-owned environment identity is published independently of the seed.
    const source = {
      source: 'authored-bangumi-game-environment',
      external_id: 'platform:PC',
      record_revision: 'unversioned',
      digest: 'e'.repeat(64),
      converter_revision: 'authored@1',
      field_group: 'facts' as const,
    };
    const created = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: randomUUID(),
          source,
          subject: { type: 'skos:Concept', labels: { en: 'PC' } },
        },
      ],
    });
    expect(created.results[0]?.status).toBe(201);
    const environmentId = (created.results[0] as { value: { id: string } }).value.id;
    const environmentUri = 'https://bgm.tv/info/platform/PC';
    const proposed = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: randomUUID(),
          source,
          subject: environmentId,
          statement: { property: { id: 'schema:url' }, value: { type: 'value', content: environmentUri } },
        },
      ],
    });
    expect(proposed.results[0]?.status).toBe(201);
    const environmentCandidate = (proposed.results[0] as { value: { candidate: string } }).value.candidate;
    expect(
      (
        await runtime.request(
          `/v1/subjects/${environmentId}/candidates/${environmentCandidate}:accept`,
          {
            context: globalContext,
            expected_head: null,
          },
          bearer,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await runtime.request(
          `/v1/subjects/${environmentId}:adopt`,
          {
            context: globalContext,
            property: 'schema:url',
            mode: 'replace',
            expected_head: null,
            selection: [{ candidate: environmentCandidate, rank: 'normal' }],
          },
          bearer,
        )
      ).status,
    ).toBe(200);
    await writeFile(
      join(directory, 'game-environment.json'),
      JSON.stringify([{ kind: 'platform', item: 'PC', conceptId: environmentId, sourceUri: environmentUri }]),
    );

    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const keyPath = join(directory, 'account.jwk');
    await writeFile(
      keyPath,
      JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'ES256', kid: randomUUID() }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, 'release-bindings.json'), '[]');
    const dump = await writeCrossMediaDump(directory, 'win');
    const state = join(directory, 'imports.sqlite');
    const showcase = join(directory, 'showcase.sqlite');
    const resultPath = join(directory, 'result.json');
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === authOrigin && url.pathname === '/signin/key')
        return new Response(null, { headers: { 'set-cookie': 'fixture=session; Secure; HttpOnly' } });
      if (url.origin === authOrigin && url.pathname === '/token')
        return Response.json({ access_token: bearer, token_type: 'Bearer', expires_in: 3600 });
      return runtime.replay(request);
    }) as typeof fetch;

    const run = () =>
      runCrossMediaSeedCli(
        [
          '--bangumi',
          dump.bangumi,
          '--vndb',
          dump.vndb,
          '--state',
          state,
          '--result',
          resultPath,
          '--api',
          runtime.origin,
          '--auth',
          authOrigin,
          '--account-key',
          keyPath,
          '--account',
          runtime.identity.governance.accountId,
          '--client',
          clientId,
          '--showcase-state',
          showcase,
          '--vndb-release-state-bindings',
          join(directory, 'release-bindings.json'),
          '--bangumi-game-environment-bindings',
          join(directory, 'game-environment.json'),
        ],
        { selection: { bangumi: [1], vndb: ['v1'], peoplePerProvider: 1 } },
      );
    await run();

    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      identities: { key: string; kind: string; subjectId: string }[];
      showcase: { manifest: { records: { provider: string; sourceKey: string; subjectId: string | null }[] } };
    };
    const workId = result.identities.find((row) => row.key === 'v1' && row.kind === 'work')?.subjectId;
    const releaseId = result.identities.find((row) => row.key === 'r1' && row.kind === 'release')?.subjectId;
    expect(workId && releaseId && workId !== releaseId).toBeTruthy();
    expect(result.showcase.manifest.records.find((record) => record.sourceKey === 'r1')?.subjectId).toBe(releaseId);
    const readCurrent = async (subjectId: string) => {
      const response = await runtime.replay(
        new Request(`${runtime.origin}/v1/subjects/${subjectId}?context=${globalContext}`),
      );
      expect(response.status).toBe(200);
      return (
        (await response.json()) as {
          subject: {
            type: string;
            statements: Record<
              string,
              {
                value: { content: unknown };
                references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
              }[]
            >;
          };
        }
      ).subject;
    };
    const gameId = result.showcase.manifest.records.find(
      (row) => row.provider === 'bangumi' && row.sourceKey === '1',
    )?.subjectId;
    expect(gameId).toBeTruthy();
    const game = await readCurrent(gameId!);
    expect(game.type).toBe('schema:VideoGame');
    expect(game.statements['schema:gamePlatform']?.map((row) => row.value.content)).toEqual([environmentId]);
    const release = await readCurrent(releaseId!);
    const work = await readCurrent(workId!);
    const values = (subject: typeof release, property: string) =>
      (subject.statements[property] ?? []).map((statement) => statement.value.content);
    expect(release.type).toBe('wd:Q20631656');
    expect(work.type).toBe('wd:Q689445');
    expect(values(release, 'schema:exampleOfWork')).toEqual([workId]);
    expect(values(release, 'schema:inLanguage')).toEqual(['ja']);
    expect(values(release, 'schema:gamePlatform')).toHaveLength(1);
    expect(values(release, 'wdt:P437')).toHaveLength(1);
    const publishedDate = release.statements['schema:datePublished']?.[0];
    expect(publishedDate?.value.content).toEqual(
      expect.objectContaining({ time: '+2020-02-29T00:00:00Z', precision: 11 }),
    );
    expect(
      publishedDate?.references?.[0]?.parts.some(
        (part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/r1',
      ),
    ).toBe(true);
    const platformId = values(release, 'schema:gamePlatform')[0] as string;
    const mediumId = values(release, 'wdt:P437')[0] as string;
    expect(values((await readCurrent(platformId)) as typeof release, 'schema:url')).toEqual([
      'https://vndb.org/releases/platforms/win',
    ]);
    expect(values((await readCurrent(mediumId)) as typeof release, 'schema:url')).toEqual([
      'https://vndb.org/releases/media/cd',
    ]);

    await run();
    const reopened = JSON.parse(await readFile(resultPath, 'utf8')) as typeof result;
    expect(reopened.identities.find((row) => row.key === 'v1' && row.kind === 'work')?.subjectId).toBe(workId);
    expect(reopened.identities.find((row) => row.key === 'r1' && row.kind === 'release')?.subjectId).toBe(releaseId);

    await writeFile(join(dump.vndb, 'db', 'releases_platforms'), 'r1\tmac\n');
    await run();
    const refreshed = JSON.parse(await readFile(resultPath, 'utf8')) as typeof result;
    expect(refreshed.identities.find((row) => row.key === 'v1' && row.kind === 'work')?.subjectId).toBe(workId);
    expect(refreshed.identities.find((row) => row.key === 'r1' && row.kind === 'release')?.subjectId).toBe(releaseId);
    expect(refreshed.showcase.manifest.records.find((record) => record.sourceKey === 'r1')?.subjectId).toBe(releaseId);
    expect((await readCurrent(gameId!)).statements['schema:gamePlatform']?.map((row) => row.value.content)).toEqual([
      environmentId,
    ]);
    const refreshedRelease = await readCurrent(releaseId!);
    expect(values(refreshedRelease, 'schema:exampleOfWork')).toEqual([workId]);
    expect(values(refreshedRelease, 'schema:inLanguage')).toEqual(['ja']);
    const refreshedDate = refreshedRelease.statements['schema:datePublished']?.[0];
    expect(refreshedDate?.value.content).toEqual(
      expect.objectContaining({ time: '+2020-02-29T00:00:00Z', precision: 11 }),
    );
    expect(
      refreshedDate?.references?.[0]?.parts.some(
        (part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/r1',
      ),
    ).toBe(true);
    const refreshedPlatforms = await Promise.all(
      values(refreshedRelease, 'schema:gamePlatform').map(async (id) =>
        values((await readCurrent(id as string)) as typeof release, 'schema:url'),
      ),
    );
    expect(refreshedPlatforms.flat()).toContain('https://vndb.org/releases/platforms/mac');
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
