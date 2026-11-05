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
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import { buildShowcaseManifest, showcaseDigest } from '../src/showcase-manifest.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { seedShowcaseVndbReleases } from '../src/showcase-vndb-releases.ts';
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
  const publicReadIds = new Set<string>();
  let refuseAcceptance = true;
  const unavailableReviewSubjects = new Set<string>();
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
      if (provider === 'vndb' && table === 'releases_vn') yield { id: 'r1', vid: 'v1', rtype: 'complete' };
      if (provider === 'vndb' && table === 'releases') yield { id: 'r1', released: null, olang: 'ja' };
      if (provider === 'vndb' && table === 'releases_titles')
        yield { id: 'r1', lang: 'ja', mtl: 'f', title: 'STEINS;GATE Release', latin: null };
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
    if (/^[vr][1-9][0-9]*$/u.test(subject.sourceExternalId)) {
      const property = 'wdt:P3180';
      const identity = [...candidates.values()].find(
        (candidate) =>
          candidate.source?.external_id === subject.sourceExternalId && candidate.statement.property.id === property,
      );
      return {
        subject: {
          ...subject,
          statements: {
            ...subject.statements,
            ...(identity ? { [property]: [identity.statement] } : {}),
          },
        },
      } as unknown as ReviewedSubjectRead;
    }
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
    const result = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'import.sqlite'),
      port: captureShowcaseCommands(port, journal),
      destination: { origin: 'https://fixture.test' },
      extras: { providers: ['bangumi', 'vndb'], mediaDeadlineMs: 0 },
    });
    expect(result.gaps).toEqual([]);
    expect(result.unresolved).toEqual([]);
    const workIds = result.readings.map((reading) => reading.subject.subject!.id!);
    const workId = workIds[0]!;
    const vndbSourceId = result.readings.find((reading) => reading.source === 'vndb' && reading.externalId === 'r1')!
      .subject.subject!.id!;
    const vndbTargetId = result.readings.find((reading) => reading.source === 'vndb' && reading.externalId === 'v1')!
      .subject.subject!.id!;
    const name = [...candidates.values()].find((candidate) => candidate.statement.property.id === 'schema:name')!;
    const unrelatedId = randomUUID();
    candidates.set(unrelatedId, {
      id: unrelatedId,
      source: null,
      statement: { ...name.statement, value: { type: 'value', content: { language: 'en', text: 'Unrelated title' } } },
      head: null,
    });

    const review: ShowcaseReviewPort = {
      async readReviewedSubject(id) {
        if (unavailableReviewSubjects.has(id)) throw new Error('current subject unavailable');
        return read(id);
      },
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
        publicReadIds.add(id);
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
    unavailableReviewSubjects.add(vndbTargetId);
    const withheld = await publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient });
    expect(withheld.status).toBe('incomplete');
    const withheldSource = withheld.published.find((record) => record.provider === 'vndb' && record.sourceKey === 'r1');
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:name')).toBe(true);
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:exampleOfWork')).toBe(false);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    unavailableReviewSubjects.delete(vndbTargetId);
    publicReadIds.clear();
    const resumed = await publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient });
    expect(resumed.omissions).toEqual([]);
    expect(resumed.status).toBe('published');
    expect(resumed.published.map((record) => record.subjectId).sort()).toEqual([...workIds].sort());
    expect(accepted).toEqual(new Set(acknowledged.map((entry) => entry.candidateId!)));
    const relation = resumed.published
      .find((record) => record.provider === 'vndb' && record.sourceKey === 'r1')
      ?.assertions.find((assertion) => assertion.property === 'schema:exampleOfWork');
    expect(relation).toMatchObject({
      citations: ['https://vndb.org/r1'],
      target: { sourceKey: 'v1', subjectId: vndbTargetId, nativeType: 'wd:Q689445' },
    });
    expect(candidates.get(relation!.candidateId)!.statement).toMatchObject({
      property: { id: 'schema:exampleOfWork' },
      value: { type: 'value', content: vndbTargetId },
    });
    expect(subjects.get(vndbSourceId)!.statements['schema:exampleOfWork']).toEqual([
      candidates.get(relation!.candidateId)!.statement,
    ]);
    expect(resumed.published.some((record) => record.subjectId === vndbTargetId)).toBe(true);
    expect(publicReadIds.has(vndbSourceId)).toBe(true);
    expect(publicReadIds.has(vndbTargetId)).toBe(true);
    const manifestRelation = resumed.manifest.records
      .find((record) => record.provider === 'vndb' && record.sourceKey === 'r1')
      ?.assertions.find((assertion) => assertion.property === 'schema:exampleOfWork');
    expect(manifestRelation?.source).toMatchObject({
      source: crossMediaAliases.vndb,
      external_id: 'r1',
      record_revision: 'unversioned',
      converter_revision: 'cross-media-entities@1',
      field_group: 'facts',
    });
    expect(adopted.get(`${workId}\0schema:name`)?.selection.some((item) => item.candidate === unrelatedId)).toBe(false);
    expect(subjects.get(workId)!.statements['schema:name']).toHaveLength(1);
    expect(subjects.get(workId)!.statements['schema:name']?.[0]).toEqual(name.statement);
    expect(first.manifest.digest).toBe(resumed.manifest.digest);
    expect(resumed.manifest.records[0]?.sourceRevision).toBe('unversioned');
    expect(resumed.published[0]?.readerRoute).toBe(`/subjects/${workId}/steins-gate`);

    const finalAcknowledgements = journal.acknowledgedCommands();
    const relationAck = finalAcknowledgements.find(
      (entry) => entry.command.op === 'propose' && entry.command.statement.property.id === 'schema:exampleOfWork',
    )!;
    if (relationAck.command.op !== 'propose') throw new Error('Expected the selected relation proposal');
    const hasRelation = (manifest: ReturnType<typeof buildShowcaseManifest>) =>
      manifest.records.some((record) =>
        record.assertions.some((assertion) => assertion.property === 'schema:exampleOfWork'),
      );
    expect(
      hasRelation(
        buildShowcaseManifest({
          plan,
          readings: result.readings,
          acknowledgements: finalAcknowledgements.filter((entry) => entry.command.key !== relationAck.command.key),
          aliases: crossMediaAliases,
        }),
      ),
    ).toBe(false);
    const buildWith = (changed: typeof relationAck) =>
      buildShowcaseManifest({
        plan,
        readings: result.readings,
        acknowledgements: [
          ...finalAcknowledgements.filter((entry) => entry.command.key !== relationAck.command.key),
          changed,
        ],
        aliases: crossMediaAliases,
      });
    const staleSourceAck = {
      ...relationAck,
      command: { ...relationAck.command, source: { ...relationAck.command.source, digest: '0'.repeat(64) } },
    };
    expect(hasRelation(buildWith(staleSourceAck))).toBe(false);
    const foreignCommand = { ...relationAck.command, key: `${relationAck.command.key}-foreign` };
    expect(
      hasRelation(
        buildWith({ ...relationAck, command: foreignCommand, commandDigest: showcaseDigest(foreignCommand) }),
      ),
    ).toBe(false);
    const mismatchedEndpointCommand = {
      ...relationAck.command,
      statement: {
        ...relationAck.command.statement,
        value: { type: 'value' as const, content: vndbSourceId },
      },
    };
    const mismatchedEndpointAck = {
      ...relationAck,
      command: mismatchedEndpointCommand,
      commandDigest: showcaseDigest(mismatchedEndpointCommand),
    };
    const mismatchedManifest = buildWith(mismatchedEndpointAck);
    expect(hasRelation(mismatchedManifest)).toBe(false);
    expect(mismatchedManifest.omissions.some((omission) => omission.code === 'graph-endpoint-mismatch')).toBe(true);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
