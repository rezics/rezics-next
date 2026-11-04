import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import {
  currentBangumiCreatorCreditBindings,
  prepareBangumiCreatorCreditBindings,
  type BangumiCreditVocabularyResolution,
} from '../src/showcase-bangumi-credits.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

function valueContent(statement: { value: BatchStatement['value'] } | undefined): unknown {
  return statement?.value.type === 'value' ? statement.value.content : undefined;
}

test('selected anime staff and cast use the default acknowledged role adapter and withhold one unresolved association', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-credits-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const subjects = new Map<
    string,
    {
      id: string;
      type: string;
      sourceExternalId: string;
      labels: Record<string, string>;
      statements: Record<string, unknown[]>;
    }
  >();
  const sources = new Map<string, string>();
  const receipts = new Map<string, { body: string; result: BatchWriteResult['results'][number] }>();
  const candidates = new Map<
    string,
    { id: string; source: BatchCommand['source']; statement: BatchStatement; head: number | null }
  >();
  const accepted = new Set<string>();
  const adopted = new Map<string, { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }>();
  const metadata = sourceRecordMetadataFixture();
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
        yield {
          subject_id: 101,
          person_id: 12,
          character_id: 21,
          summary: 'Association commentary is not a credit name.',
        };
      if (provider === 'bangumi' && table === 'person') {
        yield { id: 11, type: 1, name: 'Director' };
        yield { id: 12, type: 1, name: 'Voice performer' };
      }
      if (provider === 'bangumi' && table === 'character') yield { id: 21, name: 'Ari' };
    },
  };
  const read = (id: string): ReviewedSubjectRead => {
    const subject = subjects.get(id);
    if (!subject) throw new Error('Missing fixture subject');
    const identity = /^(?:(person|character):)?([0-9]+)$/u.exec(subject.sourceExternalId);
    const property =
      identity?.[1] === 'person'
        ? 'wdt:P6298'
        : identity?.[1] === 'character'
          ? 'wdt:P6296'
          : identity
            ? 'wdt:P5732'
            : undefined;
    const statements = property
      ? {
          ...subject.statements,
          [property]: [
            {
              property: { id: property },
              value: { type: 'value', content: identity![2] },
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value', content: bangumiRecordUrl(subject.sourceExternalId) },
                    },
                  ],
                },
              ],
            },
          ],
        }
      : subject.statements;
    return { subject: { ...subject, statements } } as unknown as ReviewedSubjectRead;
  };
  const basePort = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id: string) {
      return read(id);
    },
    async batch(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          const body = JSON.stringify(command);
          const old = receipts.get(command.key);
          if (old) {
            expect(body).toBe(old.body);
            return structuredClone(old.result);
          }
          let result: BatchWriteResult['results'][number];
          if (command.op === 'create') {
            const sourceKey = `${command.source.source}\0${command.source.external_id}`;
            const id = sources.get(sourceKey) ?? randomUUID();
            sources.set(sourceKey, id);
            subjects.set(id, {
              id,
              type: command.subject.type,
              sourceExternalId: command.source.external_id,
              labels: command.subject.labels,
              statements: {},
            });
            result = { key: command.key, status: 201, value: { id, revision: 1 } };
          } else if (command.op === 'propose') {
            const id = randomUUID();
            candidates.set(id, { id, source: command.source, statement: command.statement, head: null });
            result = { key: command.key, status: 201, value: { candidate: id, revision: 1 } };
          } else result = { key: command.key, status: 200, value: { revision: 1 } };
          receipts.set(command.key, { body, result });
          return structuredClone(result);
        }),
      };
    },
  } as unknown as CrossMediaPort;
  const port = captureShowcaseCommands(basePort, journal);
  const review: ShowcaseReviewPort = {
    readReviewedSubject: async (id) => read(id),
    async reviewedCandidates(id, query) {
      expect(query.context).toBe(globalContext);
      return {
        candidates: [...candidates.values()].filter(
          (candidate) =>
            candidate.source.external_id === subjects.get(id)?.sourceExternalId &&
            candidate.statement.property.id === query.property,
        ),
        next: null,
        adoption: adopted.get(`${id}\0${query.property}`) ?? null,
      } as never;
    },
    async acceptReviewedCandidate(_id, candidateId) {
      accepted.add(candidateId);
      return {
        acceptance: { context: globalContext, candidate: candidateId, decision: 'accept', head: 1 },
        revision: 1,
      } as never;
    },
    async adoptReviewedCandidates(id, body) {
      const action = body as {
        property: string;
        selection: { candidate: string; rank: 'normal' | 'preferred' }[];
      };
      const key = `${id}\0${action.property}`;
      const next = { head: (adopted.get(key)?.head ?? 0) + 1, selection: action.selection };
      adopted.set(key, next);
      subjects.get(id)!.statements[action.property] = action.selection.map(
        ({ candidate }) => candidates.get(candidate)!.statement,
      );
      return {
        adoption: { context: globalContext, property: action.property, mode: 'replace', ...next },
        revision: 1,
      } as never;
    },
  };
  const publicClient = createPublicBulkClient({
    origin: 'https://fixture.test',
    fetch: (async (input) => {
      const id = new URL(String(input)).pathname.split('/').at(-1)!;
      return Response.json(read(id));
    }) as typeof fetch,
  });
  let resolution: BangumiCreditVocabularyResolution | undefined;
  try {
    const plan = await planCrossMediaSeed(tables);
    const result = await seedCrossMedia(
      plan,
      join(directory, 'import.sqlite'),
      port,
      { origin: 'https://fixture.test' },
      {
        providers: ['bangumi'],
        readPublicSubject: (id) => publicClient.readSubject(id),
        prepareBangumiCreatorCreditBindings: async ({ result: baseResult, drafts }) => {
          resolution = await prepareBangumiCreatorCreditBindings({
            plan,
            result: baseResult,
            drafts,
            port,
            journal,
            review,
            publicClient,
            read: async (id) => publicClient.readSubject(id),
          });
          return resolution;
        },
      },
    );
    const currentRoles = await currentBangumiCreatorCreditBindings({
      resolution: resolution!,
      acknowledgements: journal.acknowledgedCommands(),
      read: async (id) => {
        return await publicClient.readSubject(id);
      },
    });
    result.creditRoles = currentRoles.roles;
    result.creditVocabularyRequirements = currentRoles.requirements;
    result.status = result.creditGaps.length ? 'imported-with-gaps' : result.status;
    const publication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: result.creditVocabularyRequirements,
    });
    const workId = result.readings.find((reading) => reading.externalId === '101')!.subject.subject!.id!;
    const work = (await publicClient.readSubject(workId)).subject as {
      statements: Record<string, readonly BatchStatement[]>;
    };
    const staff = work.statements['schema:director']?.find(
      (statement) =>
        valueContent(statement) ===
        result.readings.find((reading) => reading.externalId === 'person:11')!.subject.subject!.id,
    );
    const voice = work.statements['wdt:P725']?.find(
      (statement) =>
        valueContent(statement) ===
        result.readings.find((reading) => reading.externalId === 'person:12')!.subject.subject!.id,
    );
    expect(publication.status).toBe('incomplete');
    expect(accepted.size).toBeGreaterThan(0);
    expect(result.creditRoles).toHaveLength(1);
    expect(publication.omissions).not.toContainEqual(
      expect.objectContaining({ sourceKey: '101', code: 'source-uri-not-current' }),
    );
    expect(staff).toBeDefined();
    expect(voice).toBeDefined();
    expect(
      staff?.qualifiers?.some(
        (qualifier) =>
          qualifier.property.id === 'wdt:P3831' && valueContent(qualifier) === result.creditRoles![0]!.conceptId,
      ),
    ).toBe(true);
    expect(
      staff?.qualifiers?.some(
        (qualifier) => qualifier.property.id === 'wdt:P1932' && valueContent(qualifier) === 'Chief Director',
      ),
    ).toBe(true);
    expect(
      staff?.references
        ?.flatMap((reference) => reference.parts)
        .some((part) => valueContent(part) === 'https://bgm.tv/subject/101#/subject-persons/101/11/position'),
    ).toBe(true);
    expect(
      voice?.qualifiers?.some(
        (qualifier) =>
          qualifier.property.id === 'wdt:P453' &&
          valueContent(qualifier) ===
            result.readings.find((reading) => reading.externalId === 'character:21')!.subject.subject!.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(voice)).not.toContain('Association commentary');
    expect(result.creditGaps).toContainEqual(
      expect.objectContaining({
        reason: 'missing_identity',
        property: 'schema:director',
        path: '/subject-persons/101/99/position',
      }),
    );
    const role = result.creditRoles![0]!;
    const concept = (await publicClient.readSubject(role.conceptId)).subject as {
      statements: Record<string, readonly BatchStatement[]>;
    };
    expect(valueContent(concept.statements['schema:sameAs']?.[0])).toBe(role.uri);
    expect(valueContent(concept.statements['skos:inScheme']?.[0])).toBe(role.schemeId);
    expect(accepted.size).toBeGreaterThan(0);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
