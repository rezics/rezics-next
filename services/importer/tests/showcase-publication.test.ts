import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
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
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

test('selected dump candidates publish only by exact intent and resume a refused step from the durable journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-publication-'));
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
  const bySource = new Map<string, string>();
  const candidates = new Map<
    string,
    { id: string; source: BatchCommand['source'] | null; statement: BatchStatement; head: number | null }
  >();
  const accepted = new Set<string>();
  const adopted = new Map<string, { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }>();
  let refuseAcceptance = true;
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
    },
  };
  const plan = await planCrossMediaSeed(tables);
  expect(plan.records.bangumi.map((record) => record.key)).toEqual(['101', '102', '103']);

  const read = (id: string) => {
    const subject = subjects.get(id);
    if (!subject) throw new Error('Missing fake subject');
    const identity = /^(?:(person|character):)?([0-9]+)$/u.exec(subject.sourceExternalId);
    if (!identity) return { subject } as unknown as ReviewedSubjectRead;
    const property = identity[1] === 'person' ? 'wdt:P6298' : identity[1] === 'character' ? 'wdt:P6296' : 'wdt:P5732';
    return {
      subject: {
        ...subject,
        statements: {
          ...subject.statements,
          [property]: [
            {
              property: { id: property },
              value: { type: 'value', content: identity[2] },
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
        },
      },
    } as unknown as ReviewedSubjectRead;
  };
  const port = {
    async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const sourceKey = `${command.source.source}\0${command.source.external_id}`;
            const id = bySource.get(sourceKey) ?? randomUUID();
            bySource.set(sourceKey, id);
            subjects.set(id, {
              id,
              type: command.subject.type,
              sourceExternalId: command.source.external_id,
              labels: command.subject.labels,
              statements: {},
            });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const id = randomUUID();
            candidates.set(id, { id, source: command.source, statement: command.statement, head: null });
            return { key: command.key, status: 201 as const, value: { candidate: id, revision: 1 } };
          }
          return { key: command.key, status: 200 as const, value: { revision: 1 } };
        }),
      };
    },
    async readReviewedSubject(id: string) {
      return read(id);
    },
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async writeSourceStatistic() {
      return {};
    },
    async clearSourceStatistic() {
      return {};
    },
  } as unknown as CrossMediaPort;

  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const result = await seedCrossMedia(
      plan,
      join(directory, 'import.sqlite'),
      captureShowcaseCommands(port, journal),
      { origin: 'https://fixture.test' },
      { providers: ['bangumi', 'vndb'], mediaDeadlineMs: 0 },
    );
    const workIds = result.readings.map((reading) => reading.subject.subject!.id!);
    const workId = workIds[0]!;
    const name = [...candidates.values()].find((candidate) => candidate.statement.property.id === 'schema:name')!;
    const unrelatedId = randomUUID();
    candidates.set(unrelatedId, {
      id: unrelatedId,
      source: null,
      statement: { ...name.statement, value: { type: 'value', content: { language: 'en', text: 'Unrelated title' } } },
      head: null,
    });

    const review: ShowcaseReviewPort = {
      readReviewedSubject: async (id) => read(id),
      async reviewedCandidates(id, query) {
        expect(query.context).toBe(globalContext);
        return {
          candidates: [...candidates.values()].filter(
            (candidate) =>
              (candidate.source?.external_id === subjects.get(id)?.sourceExternalId &&
                candidate.statement.property.id === query.property) ||
              (candidate.id === unrelatedId && id === workId && query.property === 'schema:name'),
          ),
          next: null,
          adoption: adopted.get(`${id}\0${query.property}`) ?? null,
        } as never;
      },
      async acceptReviewedCandidate(_id, candidateId, body) {
        if (refuseAcceptance) {
          const error = new Error('refused') as Error & { status: number };
          error.status = 403;
          throw error;
        }
        accepted.add(candidateId);
        return {
          acceptance: { context: body.context, candidate: candidateId, decision: 'accept', head: 1 },
          revision: 1,
        };
      },
      async adoptReviewedCandidates(id, body) {
        const action = body as {
          context: string;
          property: string;
          mode: 'inherit' | 'replace' | 'suppress';
          selection: { candidate: string; rank: 'normal' | 'preferred' }[];
        };
        const key = `${id}\0${action.property}`;
        const next = { head: (adopted.get(key)?.head ?? 0) + 1, selection: action.selection };
        adopted.set(key, next);
        subjects.get(id)!.statements[action.property] = action.selection.map(
          ({ candidate }) => candidates.get(candidate)!.statement,
        );
        return {
          adoption: {
            context: action.context,
            property: action.property,
            mode: action.mode,
            selection: action.selection,
            head: next.head,
          },
          revision: 1,
        };
      },
    };
    const publicClient = createPublicBulkClient({
      origin: 'https://fixture.test',
      fetch: (async (input) => {
        const id = new URL(String(input)).pathname.split('/').at(-1)!;
        return Response.json(read(id));
      }) as typeof fetch,
    });
    const first = await publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient });
    expect(first.status).toBe('incomplete');
    const acknowledged = journal.acknowledgedCommands().filter((entry) => entry.candidateId);
    expect(acknowledged.length).toBeGreaterThan(0);
    expect(accepted.size).toBe(0);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    refuseAcceptance = false;
    const resumed = await publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient });
    expect(resumed.omissions).toEqual([]);
    expect(resumed.status).toBe('published');
    expect(resumed.published.map((record) => record.subjectId).sort()).toEqual([...workIds].sort());
    expect(accepted).toEqual(new Set(acknowledged.map((entry) => entry.candidateId!)));
    expect(adopted.get(`${workId}\0schema:name`)?.selection.some((item) => item.candidate === unrelatedId)).toBe(false);
    expect(subjects.get(workId)!.statements['schema:name']).toHaveLength(1);
    expect(subjects.get(workId)!.statements['schema:name']?.[0]).toEqual(name.statement);
    expect(first.manifest.digest).toBe(resumed.manifest.digest);
    expect(resumed.manifest.records[0]?.sourceRevision).toBe('unversioned');
    expect(resumed.published[0]?.readerRoute).toBe(`/subjects/${workId}/steins-gate`);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
