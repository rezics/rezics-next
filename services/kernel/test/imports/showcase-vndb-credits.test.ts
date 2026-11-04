import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creditTypeConceptUri, creditTypeSchemeUri } from '../../../importer/src/vndb-staff-credits.ts';
import { planCrossMediaSeed, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

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

function selectedVn() {
  const bangumiRows: Record<string, Record<string, unknown>[]> = {
    subject: [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
  };
  const rows: Record<string, Record<string, unknown>[]> = {
    vn: [
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    vn_titles: [
      { id: 'v1', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    entry_meta: [
      { id: 'v1', revision: '7', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '8', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '9', lastmod: '2026-10-25 00:00:00+00' },
    ],
    vn_staff: [
      { id: 'v1', aid: '10', role: 'scenario', note: 'Writer Alias' },
      { id: 'v1', aid: '20', role: 'chardesign', note: 'Artist Alias' },
    ],
    vn_seiyuu: [{ id: 'v1', aid: '10', cid: 'c3', note: 'Voice Alias' }],
    staff_alias: [
      { id: 's4', aid: '10', name: 'Writer Alias' },
      { id: 's4', aid: '20', name: 'Artist Alias' },
    ],
    staff: [{ id: 's4', main: '10', prod: null }],
    chars: [{ id: 'c3', main: null, name: 'Authored character' }],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* (provider === 'vndb' ? rows[table] : bangumiRows[table]) ?? [];
    },
  };
}

test('selected-VN credits reach adopted current facts through exact current bindings and reopen', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credits-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
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
    const created = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: randomUUID(),
          source: { ...authored, external_id: 'credit-scheme', digest: 'a'.repeat(64) },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'VNDB credit types' } },
        },
        {
          op: 'create',
          key: randomUUID(),
          source: { ...authored, external_id: 'wrong-credit-scheme', digest: 'e'.repeat(64) },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Other source roles' } },
        },
        ...['scenario', 'chardesign'].map((code, index) => ({
          op: 'create' as const,
          key: randomUUID(),
          source: { ...authored, external_id: code, digest: String.fromCharCode(98 + index).repeat(64) },
          subject: { type: 'skos:Concept', labels: { en: code } },
        })),
      ],
    });
    expect(created.results.every((result) => result.status === 201)).toBe(true);
    const schemeId = (created.results[0] as { value: { id: string } }).value.id;
    const wrongSchemeId = (created.results[1] as { value: { id: string } }).value.id;
    const scenarioId = (created.results[2] as { value: { id: string } }).value.id;
    const designId = (created.results[3] as { value: { id: string } }).value.id;

    const vocabulary = [
      {
        subject: schemeId,
        externalId: 'credit-scheme',
        digest: 'a'.repeat(64),
        property: 'schema:url',
        content: creditTypeSchemeUri,
      },
      {
        subject: wrongSchemeId,
        externalId: 'wrong-credit-scheme',
        digest: 'e'.repeat(64),
        property: 'schema:url',
        content: 'https://example.test/other-credit-types',
      },
      {
        subject: scenarioId,
        externalId: 'scenario',
        digest: 'b'.repeat(64),
        property: 'schema:url',
        content: creditTypeConceptUri('scenario'),
      },
      {
        subject: scenarioId,
        externalId: 'scenario',
        digest: 'b'.repeat(64),
        property: 'skos:inScheme',
        content: schemeId,
      },
      {
        subject: designId,
        externalId: 'chardesign',
        digest: 'c'.repeat(64),
        property: 'schema:url',
        content: creditTypeConceptUri('chardesign'),
      },
      {
        subject: designId,
        externalId: 'chardesign',
        digest: 'c'.repeat(64),
        property: 'skos:inScheme',
        content: wrongSchemeId,
      },
    ];
    const proposedVocabulary = await runtime.importTransport.batch({
      commands: vocabulary.map((item) => ({
        op: 'propose' as const,
        key: randomUUID(),
        source: { ...authored, external_id: item.externalId, digest: item.digest },
        subject: item.subject,
        statement: {
          property: { id: item.property },
          value: { type: 'value' as const, content: item.content },
          references: [
            { parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: item.content } }] },
          ],
        },
      })),
    });
    expect(proposedVocabulary.results.every((result) => result.status === 201)).toBe(true);

    async function acceptAdopt(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.source) ?? listing.candidates[0]!;
      const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: candidate.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }

    await acceptAdopt(schemeId, 'schema:url');
    await acceptAdopt(wrongSchemeId, 'schema:url');
    await acceptAdopt(scenarioId, 'schema:url');
    await acceptAdopt(scenarioId, 'skos:inScheme');
    await acceptAdopt(designId, 'schema:url');
    await acceptAdopt(designId, 'skos:inScheme');
    const plan = await planCrossMediaSeed(selectedVn());
    const references = {
      schemeId,
      concepts: [
        { code: 'scenario', id: scenarioId },
        { code: 'chardesign', id: designId },
      ],
    };
    const path = join(directory, 'state.sqlite');
    const first = await seedCrossMedia(
      plan,
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      { mediaDeadlineMs: 0, vndbCreditReferences: references },
    );
    expect(first.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    const identities = new Map(first.readings.map((row) => [row.externalId, row.subject.subject.id]));
    const workId = identities.get('v1')!;
    const personId = identities.get('s4')!;
    const characterId = identities.get('c3')!;
    expect(workId && personId && characterId).toBeTruthy();

    const authorCandidates = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:author', context: GLOBAL_CONTEXT, limit: '100' })}`,
    );
    expect(authorCandidates.status).toBe(200);
    const authorSource = (authorCandidates.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    expect(authorSource.statement.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: scenarioId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Writer Alias' } }),
      ]),
    );
    await acceptAdopt(workId, 'schema:author');
    await acceptAdopt(workId, 'wdt:P725');

    const readCurrent = async () => {
      const response = await editor.http(`/v1/subjects/${workId}?context=${GLOBAL_CONTEXT}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          statements: Record<
            string,
            { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
          >;
        };
      };
    };
    let current = await readCurrent();
    expect(current.subject.statements['schema:author']?.[0]?.value.content).toBe(personId);
    expect(current.subject.statements['schema:author']?.[0]?.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: scenarioId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Writer Alias' } }),
      ]),
    );
    expect(current.subject.statements['schema:illustrator']).toBeUndefined();
    expect(current.subject.statements['wdt:P725']?.[0]?.value.content).toBe(personId);
    expect(current.subject.statements['wdt:P725']?.[0]?.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: characterId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Voice Alias' } }),
      ]),
    );

    const reopened = await seedCrossMedia(
      plan,
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      { mediaDeadlineMs: 0, vndbCreditReferences: references },
    );
    expect(reopened.readings.map((row) => row.externalId).sort()).toEqual(
      first.readings.map((row) => row.externalId).sort(),
    );
    current = await readCurrent();
    expect(current.subject.statements['schema:author']).toHaveLength(1);
    expect(current.subject.statements['wdt:P725']).toHaveLength(1);
    expect(current.subject.statements['schema:illustrator']).toBeUndefined();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
