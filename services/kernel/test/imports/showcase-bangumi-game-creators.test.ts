import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement, Source } from '@rezics/definitions/bulk';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  currentBangumiCreatorCreditBindings,
  prepareBangumiCreatorCreditBindings,
  type BangumiCreditVocabularyResolution,
} from '../../../importer/src/showcase-bangumi-credits.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcasePublicationResult,
} from '../../../importer/src/showcase-publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

function valueContent(statement: { value: BatchStatement['value'] } | undefined): unknown {
  return statement?.value.type === 'value' ? statement.value.content : undefined;
}

function cited(statement: BatchStatement | undefined, uri: string): boolean {
  return (
    statement?.references?.some((reference) =>
      reference.parts.some((part) => part.property.id === 'schema:url' && valueContent(part) === uri),
    ) ?? false
  );
}

test('selected Game creator credits use current roles, exact evidence, and stable identities across refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-game-creators-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const tables: CrossMediaTables = {
      async *rows(provider, table) {
        if (provider === 'bangumi' && table === 'subject') {
          yield { id: 101, name: 'STEINS;GATE', type: 4 };
          yield { id: 102, name: 'CLANNAD', type: 2 };
          yield { id: 103, name: 'Fate/stay night', type: 2 };
        }
        if (provider === 'vndb' && table === 'vn_titles') {
          yield { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null };
          yield { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null };
          yield { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null };
        }
        if (provider === 'vndb' && table === 'vn') {
          yield { id: 'v1', olang: 'ja', alias: null };
          yield { id: 'v2', olang: 'ja', alias: null };
          yield { id: 'v3', olang: 'ja', alias: null };
        }
        if (provider === 'vndb' && table === 'entry_meta') {
          yield { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' };
          yield { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' };
          yield { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' };
        }
        if (provider === 'bangumi' && table === 'subject-persons') {
          yield { subject_id: 101, person_id: 11, position: 1001, creditedAs: 'MAGES.' };
          yield { subject_id: 101, person_id: 12, position: 1004, creditedAs: 'Scenario writer' };
          yield { subject_id: 101, person_id: 99, position: 1001, creditedAs: 'Unresolved creator' };
        }
        if (provider === 'bangumi' && table === 'person-characters')
          yield { subject_id: 101, person_id: 12, character_id: 21, summary: 'Game voice row is out of scope.' };
        if (provider === 'bangumi' && table === 'subject-characters')
          yield { subject_id: 101, character_id: 22, type: 1, order: 1 };
        if (provider === 'bangumi' && table === 'person') {
          yield { id: 11, type: 1, name: 'MAGES.' };
          yield { id: 12, type: 1, name: 'Scenario writer' };
        }
      },
    };
    const plan = await planCrossMediaSeed(tables);
    expect(plan.credits.filter((credit) => credit.kind === 'staff' && credit.work === '101')).toHaveLength(3);
    expect(plan.entities.bangumi.some(({ key }) => key === 'character:21' || key === 'character:22')).toBe(false);

    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    let resolution: BangumiCreditVocabularyResolution | undefined;
    async function importAndPublish(prior?: ShowcasePublicationResult) {
      const captured = captureShowcaseCommands(runtime.importTransport, journal);
      const result = await seedCrossMedia(
        plan,
        join(directory, 'import.sqlite'),
        captured,
        { origin: runtime.origin },
        {
          providers: ['bangumi'],
          mediaDeadlineMs: 0,
          readPublicSubject: (id) => publicClient.readSubject(id),
          prepareBangumiCreatorCreditBindings: async ({ result: baseResult, drafts, read }) => {
            resolution = await prepareBangumiCreatorCreditBindings({
              plan,
              result: baseResult,
              drafts,
              port: captured,
              journal,
              review: runtime.importTransport,
              publicClient,
              ...(prior ? { prior } : {}),
              subjectTypes: [2, 4],
              read,
            });
            return resolution;
          },
        },
      );
      const current = await currentBangumiCreatorCreditBindings({
        resolution: resolution!,
        acknowledgements: journal.acknowledgedCommands(),
        read: async (id) => {
          try {
            return await publicClient.readSubject(id);
          } catch {
            return null;
          }
        },
      });
      result.creditRoles = current.roles;
      result.creditVocabularyRequirements = current.requirements;
      const publication = await publishShowcase({
        plan,
        result,
        aliases: crossMediaAliases,
        journal,
        review: runtime.importTransport,
        publicClient,
        vocabularyRequirements: result.creditVocabularyRequirements,
      });
      return { result, publication };
    }

    const first = await importAndPublish();
    expect(first.result.creditGaps).toContainEqual(
      expect.objectContaining({
        reason: 'missing_identity',
        property: 'wdt:P178',
        path: '/subject-persons/101/99/position',
      }),
    );
    const developerRole = first.result.creditRoles!.find((role) => role.code === '1001')!;
    const authorRole = first.result.creditRoles!.find((role) => role.code === '1004')!;
    const workId = first.result.readings.find((reading) => reading.externalId === '101')!.subject.subject!.id!;
    const developerId = first.result.readings.find((reading) => reading.externalId === 'person:11')!.subject.subject!
      .id!;
    const authorId = first.result.readings.find((reading) => reading.externalId === 'person:12')!.subject.subject!.id!;
    const workRead = await publicClient.readSubject(workId);
    const work = workRead.subject as {
      id: string;
      type: string;
      statements: Record<string, readonly BatchStatement[]>;
    };
    const developerCredit = work.statements['wdt:P178']?.find((statement) => valueContent(statement) === developerId);
    const authorCredit = work.statements['schema:author']?.find((statement) => valueContent(statement) === authorId);
    expect(first.publication.published.some((record) => record.subjectId === workId)).toBe(true);
    expect(work).toMatchObject({ id: workId, type: 'schema:VideoGame' });
    expect(valueContent(work.statements['wdt:P5732']?.[0])).toBe('101');
    expect(developerCredit).toBeDefined();
    expect(authorCredit).toBeDefined();
    for (const [credit, role, creditedAs] of [
      [developerCredit, developerRole, 'MAGES.'],
      [authorCredit, authorRole, 'Scenario writer'],
    ] as const) {
      expect(
        credit?.qualifiers?.some(
          (qualifier) => qualifier.property.id === 'wdt:P3831' && valueContent(qualifier) === role.conceptId,
        ),
      ).toBe(true);
      expect(
        credit?.qualifiers?.some(
          (qualifier) => qualifier.property.id === 'wdt:P1932' && valueContent(qualifier) === creditedAs,
        ),
      ).toBe(true);
    }
    expect(cited(developerCredit, 'https://bgm.tv/subject/101#/subject-persons/101/11/position')).toBe(true);
    expect(cited(authorCredit, 'https://bgm.tv/subject/101#/subject-persons/101/12/position')).toBe(true);
    expect(
      work.statements['wdt:P178']?.some((statement) => valueContent(statement) === authorId),
    ).toBe(false);
    const developerRead = await publicClient.readSubject(developerId);
    const authorRead = await publicClient.readSubject(authorId);
    expect(developerRead.subject).toMatchObject({ id: developerId, type: 'schema:Person' });
    expect(authorRead.subject).toMatchObject({ id: authorId, type: 'schema:Person' });
    expect(
      valueContent(
        (developerRead.subject as { statements: Record<string, readonly BatchStatement[]> }).statements['wdt:P6298']?.[0],
      ),
    ).toBe('11');
    expect(
      valueContent(
        (authorRead.subject as { statements: Record<string, readonly BatchStatement[]> }).statements['wdt:P6298']?.[0],
      ),
    ).toBe('12');

    const roleRead = await publicClient.readSubject(authorRole.conceptId);
    const roleStatements = (roleRead.subject as { statements: Record<string, readonly BatchStatement[]> }).statements;
    expect(valueContent(roleStatements['schema:url']?.[0])).toBe(
      'https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/subject_staffs.yml',
    );
    expect(valueContent(roleStatements['schema:sameAs']?.[0])).toBe(authorRole.uri);
    expect(valueContent(roleStatements['skos:inScheme']?.[0])).toBe(authorRole.schemeId);

    const authorRequirement = resolution!.requirements.find((item) => item.sourceKey === 'bangumi.staff:1004')!;
    const wrongSchemeSource: Source = {
      ...authorRequirement.source,
      external_id: 'wrong-game-role-scheme',
      digest: 'f'.repeat(64),
      converter_revision: 'focused-wrong-scheme@1',
    };
    const created = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          source: wrongSchemeSource,
          key: `wrong-game-role-scheme:${randomUUID()}`,
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Wrong Game role scheme' } },
        },
      ],
    });
    const wrongSchemeId = (created.results[0] as { value: { id: string } }).value.id;
    const proposed = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          source: authorRequirement.source,
          subject: authorRole.conceptId,
          key: `wrong-game-role-binding:${randomUUID()}`,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: wrongSchemeId },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: authorRequirement.sourceUri } },
                ],
              },
            ],
          },
        },
      ],
    });
    const candidateId = (proposed.results[0] as { value: { candidate: string } }).value.candidate;
    const candidate = (
      await runtime.importTransport.reviewedCandidates(authorRole.conceptId, {
        property: 'skos:inScheme',
        context: GLOBAL_CONTEXT,
        limit: 100,
      })
    ).candidates.find((item) => item.id === candidateId)!;
    const accept = await runtime.importTransport.acceptReviewedCandidate(
      authorRole.conceptId,
      candidateId,
      { context: GLOBAL_CONTEXT, expected_head: candidate.head ?? null },
      randomUUID(),
    );
    expect(accept.acceptance.candidate).toBe(candidateId);
    const adoption = await runtime.importTransport.reviewedCandidates(authorRole.conceptId, {
      property: 'skos:inScheme',
      context: GLOBAL_CONTEXT,
      limit: 100,
    });
    const adopted = await runtime.importTransport.adoptReviewedCandidates(
      authorRole.conceptId,
      {
        context: GLOBAL_CONTEXT,
        property: 'skos:inScheme',
        mode: 'replace',
        expected_head: adoption.adoption?.head ?? null,
        selection: [{ candidate: candidateId, rank: 'normal' }],
      },
      randomUUID(),
    );
    expect(adopted.adoption.selection).toEqual([{ candidate: candidateId, rank: 'normal' }]);

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const refreshed = await importAndPublish(first.publication);
    expect(refreshed.result.readings.find((reading) => reading.externalId === '101')!.subject.subject!.id).toBe(workId);
    expect(refreshed.result.readings.find((reading) => reading.externalId === 'person:11')!.subject.subject!.id).toBe(
      developerId,
    );
    expect(refreshed.result.readings.find((reading) => reading.externalId === 'person:12')!.subject.subject!.id).toBe(
      authorId,
    );
    expect(refreshed.result.creditRoles?.map((role) => role.code)).toEqual(['1001']);
    expect(refreshed.result.creditGaps).toContainEqual(
      expect.objectContaining({ reason: 'missing_concept', code: '1004', path: '/subject-persons/101/12/position' }),
    );
    const refreshedWork = (await publicClient.readSubject(workId)).subject as {
      statements: Record<string, readonly BatchStatement[]>;
    };
    expect(refreshedWork.statements['wdt:P178']?.some((statement) => valueContent(statement) === developerId)).toBe(
      true,
    );
    // An independently adopted author credit remains current after its role binding changes.
    expect(refreshedWork.statements['schema:author']?.some((statement) => valueContent(statement) === authorId)).toBe(
      true,
    );
    expect(
      refreshedWork.statements['wdt:P178']?.some((statement) => valueContent(statement) === authorId),
    ).toBe(false);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
