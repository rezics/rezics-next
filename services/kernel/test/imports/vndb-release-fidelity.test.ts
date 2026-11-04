import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
  importVndbReleaseFidelity,
  readVndbReleaseBindings,
} from '../../../importer/src/vndb-release-fidelity.ts';
import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(directory: string, released = '20200229') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: [
      'id\treleased',
      [`r1\t${released}`, 'r2\t20200300', 'r3\t20200000', 'r4\t99999999', 'r5\t00000000', 'r6\t\\N', 'r7\t20210101'].join('\n'),
    ],
    releases_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      [
        'r1\tja\tt\tAuthored exact release\t\\N',
        'r2\tja\tt\tAuthored month release\t\\N',
        'r3\tja\tt\tAuthored year release\t\\N',
        'r4\tja\tt\tAuthored TBA release\t\\N',
        'r5\tja\tt\tAuthored unknown release\t\\N',
        'r6\tja\tt\tAuthored absent release\t\\N',
        'r7\tja\tt\tAuthored unsupported completeness\t\\N',
      ].join('\n'),
    ],
    releases_vn: [
      'id\tvid\trtype',
      ['r1\tv1\tcomplete', 'r2\tv1\tpartial', 'r3\tv1\tcomplete', 'r4\tv1\tcomplete', 'r5\tv1\tcomplete', 'r6\tv1\tcomplete', 'r7\tv1\tbundle'].join(
        '\n',
      ),
    ],
    releases_supersedes: ['id\trid', 'r1\tr2'],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
  source?: unknown;
};

test('production operator imports authored VNDB release dates, states and work completeness through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-native-'));
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
    const schemeCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'authored-vndb-development-status-scheme',
          source: {
            source: 'authored-vndb-release-states',
            external_id: 'scheme',
            record_revision: 'unversioned',
            digest: 'a'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Authored VNDB development status' } },
        },
      ],
    });
    expect(schemeCreated.results[0]?.status).toBe(201);
    const schemeId = (schemeCreated.results[0] as { value: { id: string } }).value.id;
    const statusCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'authored-vndb-development-status-1',
          source: {
            source: 'authored-vndb-release-states',
            external_id: 'in-development',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: { type: 'skos:Concept', labels: { en: 'In development' } },
        },
      ],
    });
    expect(statusCreated.results[0]?.status).toBe(201);
    const statusId = (statusCreated.results[0] as { value: { id: string } }).value.id;
    const propose = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: 'authored-scheme-url',
          source: {
            source: 'authored-vndb-release-states',
            external_id: 'scheme',
            record_revision: 'unversioned',
            digest: 'a'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: schemeId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: developmentStatusSchemeUri },
            references: [
              { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: developmentStatusSchemeUri } }] },
            ],
          },
        },
        {
          op: 'propose',
          key: 'authored-status-url',
          source: {
            source: 'authored-vndb-release-states',
            external_id: 'in-development',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: statusId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: developmentStatusConceptUri('1') },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: developmentStatusConceptUri('1') } },
                ],
              },
            ],
          },
        },
        {
          op: 'propose',
          key: 'authored-status-scheme',
          source: {
            source: 'authored-vndb-release-states',
            external_id: 'in-development',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: statusId,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: schemeId },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: developmentStatusConceptUri('1') } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(propose.results.every((result) => result.status === 201)).toBe(true);
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
    await acceptAdopt(schemeId, 'schema:url');
    await acceptAdopt(statusId, 'schema:url');
    await acceptAdopt(statusId, 'skos:inScheme');
    const bindings = await readVndbReleaseBindings(runtime.importTransport, [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.id)).toEqual([statusId]);
    const path = join(directory, 'state.sqlite');
    const first = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const work = first.readings.find((row) => row.externalId === 'v1');
    const exact = first.readings.find((row) => row.externalId === 'r1');
    const month = first.readings.find((row) => row.externalId === 'r2');
    const year = first.readings.find((row) => row.externalId === 'r3');
    const tba = first.readings.find((row) => row.externalId === 'r4');
    expect(work && exact && month && year && tba).toBeTruthy();
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const workId = idOf(work!);
    const exactId = idOf(exact!);
    const monthId = idOf(month!);
    const yearId = idOf(year!);
    const tbaId = idOf(tba!);
    expect(workId && exactId && monthId && yearId && tbaId).toBeTruthy();
    expect(exactId).not.toBe(workId);
    await acceptAdopt(workId!, 'schema:keywords');
    await acceptAdopt(exactId!, 'schema:datePublished');
    await acceptAdopt(exactId!, 'schema:exampleOfWork');
    await acceptAdopt(monthId!, 'schema:datePublished');
    await acceptAdopt(yearId!, 'schema:datePublished');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: { type: string; statements: Record<string, { value: { content: unknown } }[]> };
      };
    };
    const workView = await read(workId!);
    expect(workView.subject.type).toBe('wd:Q689445');
    expect(workView.subject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([statusId]);
    const exactView = await read(exactId!);
    expect(exactView.subject.type).toBe('wd:Q20631656');
    expect(exactView.subject.statements['schema:exampleOfWork']?.map((item) => item.value.content)).toEqual([workId]);
    expect(exactView.subject.statements['schema:datePublished']?.[0]?.value.content).toEqual(
      expect.objectContaining({ time: '+2020-02-29T00:00:00Z', precision: 11 }),
    );
    const monthView = await read(monthId!);
    expect(monthView.subject.statements['schema:datePublished']?.[0]?.value.content).toEqual(
      expect.objectContaining({ precision: 10 }),
    );
    const yearView = await read(yearId!);
    expect(yearView.subject.statements['schema:datePublished']?.[0]?.value.content).toEqual(
      expect.objectContaining({ precision: 9 }),
    );
    const tbaView = await read(tbaId!);
    expect(tbaView.subject.statements['schema:datePublished'] ?? []).toEqual([]);
    expect(tbaView.subject.statements['schema:keywords'] ?? []).toEqual([]);
    const again = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(again.readings.map((row) => row.externalId).sort()).toEqual(first.readings.map((row) => row.externalId).sort());
    expect(idOf(again.readings.find((row) => row.externalId === 'r1')!)).toBe(exactId);
    const successor = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '20200301'),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const page = await editor.http(
      `/v1/subjects/${exactId}/candidates?${new URLSearchParams({ property: 'schema:datePublished', context: globalContext, limit: '100' })}`,
    );
    const dates = (page.body as { candidates: Candidate[] }).candidates.map((item) => item.statement.value.content);
    expect(dates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ time: '+2020-02-29T00:00:00Z' }),
        expect.objectContaining({ time: '+2020-03-01T00:00:00Z' }),
      ]),
    );
    const statusUrlPage = await editor.http(
      `/v1/subjects/${statusId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    const statusUrl = (statusUrlPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    const retracted = await editor.http(`/v1/statements/${statusUrl.id}/retract`, {});
    expect(retracted.status).toBe(200);
    const withheldBindings = await readVndbReleaseBindings(runtime.importTransport, [
      {
        taxonomy: developmentStatusTaxonomy,
        uri: developmentStatusSchemeUri,
        schemeId,
        concepts: [{ code: '1', id: statusId }],
      },
    ]);
    expect(withheldBindings.concepts).toEqual([]);
    await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const kindPage = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:keywords', context: globalContext, limit: '100' })}`,
    );
    const kindCandidates = (kindPage.body as { candidates: Candidate[] }).candidates.filter((item) => !item.retracted);
    expect(kindCandidates.filter((item) => item.statement.value.content === statusId).length).toBeLessThanOrEqual(1);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '20200401'),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
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
}, 180_000);
