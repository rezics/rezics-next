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

const globalContext = GLOBAL_CONTEXT;

function valueContent(statement: { value: BatchStatement['value'] } | undefined): unknown {
  return statement?.value.type === 'value' ? statement.value.content : undefined;
}

test('default anime staff and voice publication adopts exact cited endpoints and keeps identities across refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-credits-native-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const tables: CrossMediaTables = {
      async *rows(provider, table) {
        if (provider === 'bangumi' && table === 'subject') {
          yield { id: 101, name: 'STEINS;GATE', type: 2 };
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
          yield { subject_id: 101, person_id: 11, position: 2, creditedAs: 'Chief Director' };
          yield { subject_id: 101, person_id: 99, position: 2 };
        }
        if (provider === 'bangumi' && table === 'person-characters')
          yield { subject_id: 101, person_id: 12, character_id: 21, summary: 'Association commentary.' };
        if (provider === 'bangumi' && table === 'person') {
          yield { id: 11, type: 1, name: 'Director' };
          yield { id: 12, type: 1, name: 'Voice performer' };
        }
        if (provider === 'bangumi' && table === 'character') yield { id: 21, name: 'Ari' };
      },
    };
    const plan = await planCrossMediaSeed(tables);
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
      expect.objectContaining({ reason: 'missing_identity', property: 'schema:director', path: '/subject-persons/101/99/position' }),
    );
    const role = first.result.creditRoles![0]!;
    const workId = first.result.readings.find((reading) => reading.externalId === '101')!.subject.subject!.id!;
    const directorId = first.result.readings.find((reading) => reading.externalId === 'person:11')!.subject.subject!.id!;
    const performerId = first.result.readings.find((reading) => reading.externalId === 'person:12')!.subject.subject!.id!;
    const characterId = first.result.readings.find((reading) => reading.externalId === 'character:21')!.subject.subject!.id!;
    const workRead = await publicClient.readSubject(workId);
    const workSubject = workRead.subject as { id: string; type: string; statements: Record<string, readonly BatchStatement[]> };
    const work = workSubject;
    const staff = work.statements['schema:director']?.find((statement) => valueContent(statement) === directorId);
    const voice = work.statements['wdt:P725']?.find((statement) => valueContent(statement) === performerId);
    expect(first.publication.published.some((record) => record.subjectId === workId)).toBe(true);
    expect(work.id).toBe(workId);
    expect(work.type).toBe('schema:TVSeries');
    expect(valueContent(work.statements['wdt:P5732']?.[0])).toBe('101');
    expect(staff?.qualifiers?.some((qualifier) => qualifier.property.id === 'wdt:P3831' && valueContent(qualifier) === role.conceptId)).toBe(true);
    expect(staff?.qualifiers?.some((qualifier) => qualifier.property.id === 'wdt:P1932' && valueContent(qualifier) === 'Chief Director')).toBe(true);
    expect(staff?.references?.flatMap((reference) => reference.parts).some((part) => valueContent(part) === 'https://bgm.tv/subject/101#/subject-persons/101/11/position')).toBe(true);
    expect(voice?.qualifiers?.some((qualifier) => qualifier.property.id === 'wdt:P453' && valueContent(qualifier) === characterId)).toBe(true);
    expect(JSON.stringify(voice)).not.toContain('Association commentary');
    const performerRead = await publicClient.readSubject(performerId);
    const characterRead = await publicClient.readSubject(characterId);
    const performer = performerRead.subject as { id: string; type: string; statements: Record<string, readonly BatchStatement[]> };
    const character = characterRead.subject as { id: string; type: string; statements: Record<string, readonly BatchStatement[]> };
    expect(performer).toMatchObject({ id: performerId, type: 'schema:Person' });
    expect(valueContent(performer.statements['wdt:P6298']?.[0])).toBe('12');
    expect(character).toMatchObject({ id: characterId, type: 'wd:Q95074' });
    expect(valueContent(character.statements['wdt:P6296']?.[0])).toBe('21');
    const roleRead = await publicClient.readSubject(role.conceptId);
    const roleStatements = (roleRead.subject as { statements: Record<string, readonly BatchStatement[]> }).statements;
    expect(valueContent(roleStatements['schema:url']?.[0])).toBe('https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/subject_staffs.yml');
    expect(valueContent(roleStatements['schema:sameAs']?.[0])).toBe(role.uri);
    expect(valueContent(roleStatements['skos:inScheme']?.[0])).toBe(role.schemeId);

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const refreshed = await importAndPublish(first.publication);
    expect(refreshed.result.readings.find((reading) => reading.externalId === '101')!.subject.subject!.id).toBe(workId);
    expect(refreshed.result.readings.find((reading) => reading.externalId === 'person:11')!.subject.subject!.id).toBe(directorId);
    expect(refreshed.result.readings.find((reading) => reading.externalId === 'person:12')!.subject.subject!.id).toBe(performerId);
    expect(refreshed.result.readings.find((reading) => reading.externalId === 'character:21')!.subject.subject!.id).toBe(characterId);
    expect(refreshed.result.creditRoles?.[0]).toMatchObject({ conceptId: role.conceptId, schemeId: role.schemeId });

    const roleRequirement = resolution!.requirements.find((item) => item.sourceKey === `bangumi.staff:${role.code}`)!;
    const wrongSchemeSource: Source = {
      ...roleRequirement.source,
      external_id: 'wrong-role-scheme',
      digest: 'f'.repeat(64),
      converter_revision: 'focused-wrong-scheme@1',
    };
    const created = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          source: wrongSchemeSource,
          key: `wrong-role-scheme:${randomUUID()}`,
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Wrong role scheme' } },
        },
      ],
    });
    const wrongSchemeId = (created.results[0] as { value: { id: string } }).value.id;
    const wrongScheme = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          source: roleRequirement.source,
          subject: role.conceptId,
          key: `wrong-role-binding:${randomUUID()}`,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: wrongSchemeId },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: roleRequirement.sourceUri } }] }],
          },
        },
      ],
    });
    const candidateId = (wrongScheme.results[0] as { value: { candidate: string } }).value.candidate;
    const candidate = (await runtime.importTransport.reviewedCandidates(role.conceptId, {
      property: 'skos:inScheme',
      context: globalContext,
      limit: 100,
    })).candidates.find((item) => item.id === candidateId)!;
    const accept = await runtime.importTransport.acceptReviewedCandidate(
      role.conceptId,
      candidateId,
      { context: globalContext, expected_head: candidate.head ?? null },
      randomUUID(),
    );
    expect(accept.acceptance.candidate).toBe(candidateId);
    const adoption = await runtime.importTransport.reviewedCandidates(role.conceptId, {
      property: 'skos:inScheme',
      context: globalContext,
      limit: 100,
    });
    const adoptedWrongScheme = await runtime.importTransport.adoptReviewedCandidates(
      role.conceptId,
      {
        context: globalContext,
        property: 'skos:inScheme',
        mode: 'replace',
        expected_head: adoption.adoption?.head ?? null,
        selection: [{ candidate: candidateId, rank: 'normal' }],
      },
      randomUUID(),
    );
    expect(adoptedWrongScheme.adoption.selection).toEqual([{ candidate: candidateId, rank: 'normal' }]);
    const acknowledgedBeforeReplay = journal.acknowledgedCommands().length;
    const replay = await prepareBangumiCreatorCreditBindings({
      plan,
      result: refreshed.result,
      drafts: plan.credits,
      port: captureShowcaseCommands(runtime.importTransport, journal),
      journal,
      review: runtime.importTransport,
      publicClient,
      prior: refreshed.publication,
      read: async (id) => {
        try {
          return await publicClient.readSubject(id);
        } catch {
          return null;
        }
      },
    });
    expect(replay.roles).toEqual([]);
    expect(journal.acknowledgedCommands()).toHaveLength(acknowledgedBeforeReplay);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
