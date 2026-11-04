import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
} from '../../../importer/src/vndb-release-fidelity.ts';
import { crossMediaAliases, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { seedShowcaseVndbReleases } from '../../../importer/src/showcase-vndb-releases.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
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
    const first = await seedShowcaseVndbReleases({
      tables: family(),
      path,
      port: runtime.importTransport,
      groups: [],
      destination: { origin: 'https://kernel.import.test' },
      extras: { providers: ['vndb'], mediaDeadlineMs: 0, recordConcurrency: 1 },
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
      tables: family(),
      path,
      port: runtime.importTransport,
      groups,
      destination: { origin: 'https://kernel.import.test' },
      extras: { providers: ['vndb'], mediaDeadlineMs: 0, recordConcurrency: 1 },
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
      path,
      port: runtime.importTransport,
      groups,
      destination: { origin: 'https://kernel.import.test' },
      extras: { providers: ['vndb'], mediaDeadlineMs: 0, recordConcurrency: 1 },
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
