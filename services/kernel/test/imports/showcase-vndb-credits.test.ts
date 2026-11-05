import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  prepareShowcaseVndbCreditVocabulary,
  publishedShowcaseVndbCreditReferences,
} from '../../../importer/src/showcase-vndb-credits.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { vndbStaffCreditConverterRevision } from '../../../importer/src/vndb-staff-credits.ts';
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
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
  source?: unknown;
};

function selectedVn(voiceAliasId = '10') {
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
    vn_seiyuu: [{ id: 'v1', aid: voiceAliasId, cid: 'c3', note: 'Voice Alias' }],
    staff_alias: [
      { id: 's4', aid: '10', name: 'Writer Alias' },
      { id: 's4', aid: '20', name: 'Artist Alias' },
      ...(voiceAliasId === '30' ? [{ id: 's5', aid: '30', name: 'Corrected Voice Alias' }] : []),
    ],
    staff: [
      { id: 's4', main: '10', prod: null },
      ...(voiceAliasId === '30' ? [{ id: 's5', main: '30', prod: null }] : []),
    ],
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
  let journal: ShowcaseJournal | undefined;
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

    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          return runtime.request(`${url.pathname}${url.search}`);
        },
        { preconnect() {} },
      ),
    });
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    let port = captureShowcaseCommands(runtime.importTransport, journal);
    const plan = await planCrossMediaSeed(selectedVn());
    const statePath = join(directory, 'state.sqlite');
    const destination = { origin: runtime.origin };
    let result = await seedCrossMedia(plan, statePath, port, destination, { mediaDeadlineMs: 0 });

    async function acceptAdopt(
      subjectId: string,
      property: string,
      matches: (candidate: Candidate) => boolean = (candidate) => Boolean(candidate.source),
    ) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.source && matches(item));
      expect(candidate).toBeDefined();
      if (!candidate) throw new Error(`Expected source candidate for ${property} on ${subjectId}`);
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
      return candidate;
    }

    function acknowledgedCreate(externalId: string): string {
      const entry = journal!.acknowledgedCommands().find(
        (acknowledgement) =>
          acknowledgement.command.op === 'create' && acknowledgement.command.source.external_id === externalId,
      );
      expect(entry?.subjectId).toBeTruthy();
      if (!entry?.subjectId) throw new Error(`Expected acknowledged source identity for ${externalId}`);
      return entry.subjectId;
    }

    const schemes = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'schemes' });
    expect(schemes.requirements).toHaveLength(1);
    await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });
    const schemeRequirement = schemes.requirements[0]!;
    const schemeId = acknowledgedCreate(schemeRequirement.source.external_id);
    await acceptAdopt(schemeId, 'schema:url');

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const concepts = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'concepts' });
    const conceptRequirements = concepts.requirements.filter((requirement) => requirement.nativeType === 'skos:Concept');
    expect(conceptRequirements.map((requirement) => requirement.sourceKey)).toEqual([
      'vndb.credit_type:chardesign',
      'vndb.credit_type:scenario',
    ]);
    await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });

    const designRequirement = conceptRequirements.find((requirement) => requirement.sourceKey.endsWith(':chardesign'))!;
    const designId = acknowledgedCreate(designRequirement.source.external_id);
    const authored = {
      source: 'authored-vndb-credit-types',
      record_revision: 'unversioned',
      converter_revision: 'authored@1',
      field_group: 'facts' as const,
    };
    const wrongSchemeResult = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: `wrong-vndb-credit-scheme:${randomUUID()}`,
          source: { ...authored, external_id: 'wrong-vndb-credit-scheme', digest: 'f'.repeat(64) },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Other VNDB roles' } },
        },
      ],
    });
    expect(wrongSchemeResult.results[0]?.status).toBe(201);
    const wrongSchemeId = (wrongSchemeResult.results[0] as { value: { id: string } }).value.id;
    const wrongBinding = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: `wrong-vndb-credit-binding:${randomUUID()}`,
          source: designRequirement.source,
          subject: designId,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: wrongSchemeId },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: designRequirement.sourceUri },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(wrongBinding.results[0]?.status).toBe(201);

    for (const requirement of conceptRequirements) {
      const subjectId = acknowledgedCreate(requirement.source.external_id);
      await acceptAdopt(subjectId, 'schema:url');
      const expectedScheme = requirement.sourceKey.endsWith(':chardesign') ? wrongSchemeId : schemeId;
      await acceptAdopt(subjectId, 'skos:inScheme', (candidate) => candidate.statement.value.content === expectedScheme);
    }

    const vocabularyAcks = journal.acknowledgedCommands().length;
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const reopenedConcepts = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'concepts' });
    expect(journal.acknowledgedCommands()).toHaveLength(vocabularyAcks);
    expect(reopenedConcepts.requirements).toEqual(concepts.requirements);

    let vocabularyPublication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: reopenedConcepts.requirements,
    });
    const publishedReferences = publishedShowcaseVndbCreditReferences(
      vocabularyPublication,
      journal,
      reopenedConcepts.requirements,
    );
    expect(publishedReferences).toBeDefined();
    if (!publishedReferences) throw new Error('Expected current published VNDB credit bindings');
    const references = publishedReferences;
    const scenarioId = references.concepts.find((concept) => concept.code === 'scenario')!.id;
    expect(references).toEqual({
      schemeId,
      concepts: [
        {
          code: 'scenario',
          id: acknowledgedCreate(
            conceptRequirements.find((requirement) => requirement.sourceKey.endsWith(':scenario'))!.source.external_id,
          ),
        },
      ],
    });

    const first = await seedCrossMedia(
      plan,
      statePath,
      port,
      destination,
      {
        mediaDeadlineMs: 0,
        vndbCreditReferences: references,
        readPublicSubject: (id) => publicClient.readSubject(id),
      },
    );
    expect(first.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    const identities = new Map(first.readings.map((row) => [row.externalId, row.subject.subject.id]));
    const workId = identities.get('v1')!;
    const personId = identities.get('s4')!;
    const characterId = identities.get('c3')!;
    expect(workId && personId && characterId).toBeTruthy();

    const pendingPublication = await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: reopenedConcepts.requirements,
    });
    const pendingCredits = pendingPublication.manifest.records
      .find((record) => record.sourceKey === 'v1')!
      .assertions.filter((assertion) => assertion.source.converter_revision === vndbStaffCreditConverterRevision);
    expect(pendingCredits.map((assertion) => assertion.property).sort()).toEqual(['schema:author', 'wdt:P725']);

    const pendingCreditKeys = journal
      .acknowledgedCommands()
      .filter(
        (acknowledgement) =>
          acknowledgement.command.op === 'propose' &&
          acknowledgement.command.source.converter_revision === vndbStaffCreditConverterRevision,
      )
      .map((acknowledgement) => acknowledgement.command.key)
      .sort();
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const replay = await seedCrossMedia(
      plan,
      statePath,
      port,
      destination,
      {
        mediaDeadlineMs: 0,
        vndbCreditReferences: references,
        readPublicSubject: (id) => publicClient.readSubject(id),
      },
    );
    const replayCreditKeys = journal
      .acknowledgedCommands()
      .filter(
        (acknowledgement) =>
          acknowledgement.command.op === 'propose' &&
          acknowledgement.command.source.converter_revision === vndbStaffCreditConverterRevision,
      )
      .map((acknowledgement) => acknowledgement.command.key)
      .sort();
    expect(replayCreditKeys).toEqual(pendingCreditKeys);
    expect(new Map(replay.readings.map((row) => [row.externalId, row.subject.subject.id])).get('v1')).toBe(workId);

    const correctedPlan = await planCrossMediaSeed(selectedVn('30'));
    result = await seedCrossMedia(
      correctedPlan,
      statePath,
      port,
      destination,
      {
        mediaDeadlineMs: 0,
        vndbCreditReferences: references,
        readPublicSubject: (id) => publicClient.readSubject(id),
      },
    );
    expect(result.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    const correctedIdentities = new Map(result.readings.map((row) => [row.externalId, row.subject.subject.id]));
    const correctedVoiceId = correctedIdentities.get('s5')!;
    expect(correctedIdentities.get('v1')).toBe(workId);
    expect(correctedIdentities.get('s4')).toBe(personId);
    expect(correctedIdentities.get('c3')).toBe(characterId);
    expect(correctedVoiceId).toBeTruthy();

    vocabularyPublication = await publishShowcase({
      plan: correctedPlan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: reopenedConcepts.requirements,
    });
    const currentCredits = vocabularyPublication.manifest.records
      .find((record) => record.sourceKey === 'v1')!
      .assertions.filter((assertion) => assertion.source.converter_revision === vndbStaffCreditConverterRevision);
    expect(currentCredits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: 'schema:author',
          statement: expect.objectContaining({ value: { type: 'value', content: personId } }),
        }),
        expect.objectContaining({
          property: 'wdt:P725',
          statement: expect.objectContaining({ value: { type: 'value', content: correctedVoiceId } }),
        }),
      ]),
    );
    expect(
      currentCredits.some(
        (assertion) => assertion.property === 'wdt:P725' && assertion.statement.value.type === 'value' && assertion.statement.value.content === personId,
      ),
    ).toBe(false);
    expect(currentCredits.some((assertion) => assertion.property === 'schema:illustrator')).toBe(false);

    const byQualifier = (candidate: Candidate, property: string, content: unknown) =>
      candidate.statement.qualifiers?.some(
        (qualifier) => qualifier.property.id === property && qualifier.value.content === content,
      ) ?? false;
    const byCitation = (candidate: Candidate, uri: string) =>
      candidate.statement.references?.some((reference) =>
        reference.parts.some((part) => part.property.id === 'schema:url' && part.value.content === uri),
      ) ?? false;
    const authorCandidate = await acceptAdopt(workId, 'schema:author', (candidate) =>
      candidate.statement.value.content === personId &&
      byQualifier(candidate, 'wdt:P3831', scenarioId) &&
      byQualifier(candidate, 'wdt:P1932', 'Writer Alias') &&
      byCitation(candidate, 'https://vndb.org/v1#/vn_staff/v1/10/scenario'),
    );
    const voiceCandidate = await acceptAdopt(workId, 'wdt:P725', (candidate) =>
      candidate.statement.value.content === correctedVoiceId &&
      byQualifier(candidate, 'wdt:P453', characterId) &&
      byQualifier(candidate, 'wdt:P1932', 'Voice Alias') &&
      byCitation(candidate, 'https://vndb.org/v1#/vn_seiyuu/v1/30/c3'),
    );
    expect(authorCandidate.statement.references).toBeDefined();
    expect(voiceCandidate.statement.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: characterId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Voice Alias' } }),
      ]),
    );

    await publishShowcase({
      plan: correctedPlan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: reopenedConcepts.requirements,
    });
    const read = async (id: string) => {
      const response = await publicClient.readSubject(id);
      return response.subject as {
        id: string;
        type: string;
        statements: Record<
          string,
          {
            value: { content: unknown };
            qualifiers?: { property: { id: string }; value: { content: unknown } }[];
            references?: Candidate['statement']['references'];
          }[]
        >;
      };
    };
    const current = await read(workId);
    const author = current.statements['schema:author']?.find((statement) => statement.value.content === personId);
    const voice = current.statements['wdt:P725']?.find((statement) => statement.value.content === correctedVoiceId);
    expect(author).toBeDefined();
    expect(voice).toBeDefined();
    expect(author?.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: scenarioId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Writer Alias' } }),
      ]),
    );
    expect(voice?.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: characterId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Voice Alias' } }),
      ]),
    );
    expect(current.statements['schema:illustrator']).toBeUndefined();
    expect(author?.references?.some((reference) =>
      reference.parts.some((part) => part.value.content === 'https://vndb.org/v1#/vn_staff/v1/10/scenario'),
    )).toBe(true);
    expect(voice?.references?.some((reference) =>
      reference.parts.some((part) => part.value.content === 'https://vndb.org/v1#/vn_seiyuu/v1/30/c3'),
    )).toBe(true);
    expect(await read(personId)).toMatchObject({ id: personId, type: 'schema:Person' });
    expect(await read(correctedVoiceId)).toMatchObject({ id: correctedVoiceId, type: 'schema:Person' });
    expect(await read(characterId)).toMatchObject({ id: characterId, type: 'schema:Character' });
    for (const otherWorkKey of ['v2', 'v3']) {
      const otherWorkId = correctedIdentities.get(otherWorkKey)!;
      const otherWork = await read(otherWorkId);
      expect(otherWork.statements['schema:author']).toBeUndefined();
      expect(otherWork.statements['wdt:P725']).toBeUndefined();
    }

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const reopened = await seedCrossMedia(
      correctedPlan,
      statePath,
      port,
      destination,
      {
        mediaDeadlineMs: 0,
        vndbCreditReferences: references,
        readPublicSubject: (id) => publicClient.readSubject(id),
      },
    );
    const reopenedIdentities = new Map(reopened.readings.map((row) => [row.externalId, row.subject.subject.id]));
    expect(reopenedIdentities.get('v1')).toBe(workId);
    expect(reopenedIdentities.get('s4')).toBe(personId);
    expect(reopenedIdentities.get('s5')).toBe(correctedVoiceId);
    expect(reopenedIdentities.get('c3')).toBe(characterId);
    const reopenedWork = await read(workId);
    expect(reopenedWork.statements['schema:author']).toHaveLength(1);
    expect(reopenedWork.statements['wdt:P725']).toHaveLength(1);
    expect(reopenedWork.statements['schema:illustrator']).toBeUndefined();
  } finally {
    journal?.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
