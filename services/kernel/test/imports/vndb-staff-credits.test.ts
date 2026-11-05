import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  importVndbStaffCredits,
  readCreditTypeBindings,
} from '../../../importer/src/vndb-staff-credits.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

function tables(overrides: Record<string, Record<string, unknown>[]> = {}) {
  const rows: Record<string, Record<string, unknown>[]> = {
    vn: [{ id: 'v1', olang: 'en', alias: null }],
    vn_titles: [{ id: 'v1', lang: 'en', official: true, title: 'Authored visual novel', latin: null }],
    entry_meta: [{ id: 'v1', revision: '7', lastmod: '2026-10-25 00:00:00+00' }],
    vn_staff: [
      { id: 'v1', aid: '10', role: 'scenario', note: 'Common route, After Story routes' },
      { id: 'v1', aid: '20', role: 'chardesign', note: 'Original character designs' },
    ],
    vn_seiyuu: [{ id: 'v1', aid: '10', cid: 'c3', note: 'Voice Alias' }],
    staff_alias: [
      { id: 's4', aid: '10', name: 'Writer Alias' },
      { id: 's4', aid: '20', name: 'Artist Alias' },
    ],
    staff: [{ id: 's4', main: '10', prod: null }],
    chars: [{ id: 'c3', main: null, name: 'Authored character' }],
    ...overrides,
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider === 'vndb') yield* rows[table] ?? [];
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
    qualifiers?: { property: { id: string }; value: { content: unknown } }[];
  };
  source?: unknown;
};

test('production operator imports two VNDB staff aliases through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-staff-credits-native-'));
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
    const authored = {
      source: 'authored-vndb-credit-types',
      record_revision: 'unversioned',
      converter_revision: 'authored@1',
      field_group: 'facts' as const,
    };
    const schemeCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'authored-credit-type-scheme',
          source: { ...authored, external_id: 'scheme', digest: 'a'.repeat(64) },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Authored VNDB credit types' } },
        },
      ],
    });
    expect(schemeCreated.results[0]?.status).toBe(201);
    const schemeId = (schemeCreated.results[0] as { value: { id: string } }).value.id;
    const createdConcepts = await runtime.importTransport.batch({
      commands: ['scenario', 'chardesign', 'director'].map((code, index) => ({
        op: 'create' as const,
        key: `authored-credit-type-${code}`,
        source: { ...authored, external_id: code, digest: String.fromCharCode(98 + index).repeat(64) },
        subject: { type: 'skos:Concept', labels: { en: code } },
      })),
    });
    expect(createdConcepts.results.every((result) => result.status === 201)).toBe(true);
    const scenarioId = (createdConcepts.results[0] as { value: { id: string } }).value.id;
    const designId = (createdConcepts.results[1] as { value: { id: string } }).value.id;
    const directorId = (createdConcepts.results[2] as { value: { id: string } }).value.id;
    const conceptFacts: { code: string; id: string; digest: string }[] = [
      { code: 'scenario', id: scenarioId, digest: 'b'.repeat(64) },
      { code: 'chardesign', id: designId, digest: 'c'.repeat(64) },
      { code: 'director', id: directorId, digest: 'd'.repeat(64) },
    ];
    const propose = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: 'authored-scheme-url',
          source: { ...authored, external_id: 'scheme', digest: 'a'.repeat(64) },
          subject: schemeId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: creditTypeSchemeUri },
            references: [
              { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: creditTypeSchemeUri } }] },
            ],
          },
        },
        ...conceptFacts.flatMap((item) => [
          {
            op: 'propose' as const,
            key: `authored-${item.code}-url`,
            source: { ...authored, external_id: item.code, digest: item.digest },
            subject: item.id,
            statement: {
              property: { id: 'schema:url' },
              value: { type: 'value' as const, content: creditTypeConceptUri(item.code) },
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value' as const, content: creditTypeConceptUri(item.code) },
                    },
                  ],
                },
              ],
            },
          },
          {
            op: 'propose' as const,
            key: `authored-${item.code}-scheme`,
            source: { ...authored, external_id: item.code, digest: item.digest },
            subject: item.id,
            statement: {
              property: { id: 'skos:inScheme' },
              value: { type: 'value' as const, content: schemeId },
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value' as const, content: creditTypeConceptUri(item.code) },
                    },
                  ],
                },
              ],
            },
          },
        ]),
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
    for (const id of [scenarioId, designId, directorId]) {
      await acceptAdopt(id, 'schema:url');
      await acceptAdopt(id, 'skos:inScheme');
    }
    const bindings = await readCreditTypeBindings(runtime.importTransport, {
      schemeId,
      concepts: [
        { code: 'scenario', id: scenarioId },
        { code: 'chardesign', id: designId },
        { code: 'director', id: directorId },
      ],
    });
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.code).sort()).toEqual(['chardesign', 'director', 'scenario']);
    const path = join(directory, 'state.sqlite');
    const first = await importVndbStaffCredits({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const work = first.readings.find((row) => row.externalId === 'v1');
    const staff = first.readings.find((row) => row.externalId === 's4');
    const character = first.readings.find((row) => row.externalId === 'c3');
    expect(work && staff && character).toBeTruthy();
    const subjectId = (row: NonNullable<typeof work>) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const workId = subjectId(work!);
    const staffId = subjectId(staff!);
    const characterId = subjectId(character!);
    expect(workId && staffId && characterId).toBeTruthy();
    expect(staffId).not.toBe(workId);
    for (const property of ['schema:author', 'schema:illustrator', 'wdt:P725']) await acceptAdopt(workId!, property);
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          statements: Record<
            string,
            { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
          >;
        };
      };
    };
    const current = await read(workId!);
    expect(current.subject.type).toBe('wd:Q689445');
    expect(current.subject.statements['schema:author']?.map((item) => item.value.content)).toEqual([staffId]);
    expect(current.subject.statements['schema:illustrator']?.map((item) => item.value.content)).toEqual([staffId]);
    expect(current.subject.statements['wdt:P725']?.map((item) => item.value.content)).toEqual([staffId]);
    const roleOf = (property: string, conceptId: string) =>
      current.subject.statements[property]?.some((item) =>
        item.qualifiers?.some(
          (qualifier) => qualifier.property.id === 'wdt:P3831' && qualifier.value.content === conceptId,
        ),
      );
    expect(roleOf('schema:author', scenarioId)).toBe(true);
    expect(roleOf('schema:illustrator', designId)).toBe(true);
    expect(
      current.subject.statements['schema:author']?.some((item) =>
        item.qualifiers?.some(
          (qualifier) => qualifier.property.id === 'wdt:P1932' && qualifier.value.content === 'Writer Alias',
        ),
      ),
    ).toBe(true);
    expect(
      current.subject.statements['wdt:P725']?.some((item) =>
        item.qualifiers?.some(
          (qualifier) => qualifier.property.id === 'wdt:P453' && qualifier.value.content === characterId,
        ),
      ),
    ).toBe(true);
    const staffView = await read(staffId!);
    expect(staffView.subject.type).toBe('schema:Person');
    const again = await importVndbStaffCredits({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(again.readings.map((row) => row.externalId).sort()).toEqual(
      first.readings.map((row) => row.externalId).sort(),
    );
    const changed = await importVndbStaffCredits({
      tables: tables({
        vn_staff: [
          { id: 'v1', aid: '10', role: 'director', note: 'Writer Alias' },
          { id: 'v1', aid: '20', role: 'chardesign', note: 'Original character designs' },
        ],
      }),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(changed.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const directors = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:director', context: globalContext, limit: '100' })}`,
    );
    expect(
      (directors.body as { candidates: Candidate[] }).candidates.some(
        (item) =>
          item.statement.value.content === staffId &&
          item.statement.qualifiers?.some(
            (qualifier) => qualifier.property.id === 'wdt:P3831' && qualifier.value.content === directorId,
          ),
      ),
    ).toBe(true);
    const scenarioUrlPage = await editor.http(
      `/v1/subjects/${scenarioId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    const scenarioUrl = (scenarioUrlPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    const retracted = await editor.http(`/v1/statements/${scenarioUrl.id}/retract`, {});
    expect(retracted.status).toBe(200);
    const withheldBindings = await readCreditTypeBindings(runtime.importTransport, {
      schemeId,
      concepts: [
        { code: 'scenario', id: scenarioId },
        { code: 'chardesign', id: designId },
        { code: 'director', id: directorId },
      ],
    });
    expect(withheldBindings.concepts.map((item) => item.code).sort()).toEqual(['chardesign', 'director']);
    await importVndbStaffCredits({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const authorPage = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:author', context: globalContext, limit: '100' })}`,
    );
    const authors = (authorPage.body as { candidates: Candidate[] }).candidates.filter((item) => !item.retracted);
    expect(
      authors.every(
        (item) => item.statement.qualifiers?.some((qualifier) => qualifier.property.id === 'wdt:P3831') || !item.source,
      ),
    ).toBe(true);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'v1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbStaffCredits({
      tables: tables({
        vn_staff: [
          { id: 'v1', aid: '10', role: 'scenario', note: 'Restored spelling after fence.' },
          { id: 'v1', aid: '20', role: 'chardesign', note: 'Original character designs' },
        ],
      }),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const restored = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:author', context: globalContext, limit: '100' })}`,
    );
    const spellings = (restored.body as { candidates: Candidate[] }).candidates.flatMap(
      (item) =>
        item.statement.qualifiers
          ?.filter((qualifier) => qualifier.property.id === 'wdt:P1932')
          .map((qualifier) => qualifier.value.content) ?? [],
    );
    expect(spellings).not.toContain('Restored spelling after fence.');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
