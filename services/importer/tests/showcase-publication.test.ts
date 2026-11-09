import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import {
  buildShowcaseManifest,
  showcaseDigest,
  showcaseVocabularyExternalId,
  type ShowcaseVocabularyRequirement,
} from '../src/showcase-manifest.ts';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '@rezics/conversion/support';
import {
  captureShowcaseCommands,
  publishShowcase,
  publishShowcaseVocabulary,
  adoptResumeKeys,
  sendDurableAdopt,
  servedCoverVariants,
  servedVariantDecisionCurrent,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { prepareShowcaseTags } from '../src/showcase-tags.ts';
import { formatSeedError, SeedFinalization } from '../src/seed-cli.ts';

import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { seedShowcaseVndbReleases } from '../src/selected-import.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const nativeDataType = (property: string) => bundledRelease.properties[property]!.datatype;

test('selected dump candidates publish exact intent, resume retryable steps, and retain permanent refusals', async () => {
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
  const tagSchemeId = '00000000-0000-4000-8000-000000000041';
  const tagConceptId = '00000000-0000-4000-8000-000000000042';
  const tagSchemeUri = vndbPublicTagScheme('cont');
  const tagConceptUri = vndbPublicTagConceptUri('cont', 'g105');
  subjects.set(tagSchemeId, {
    id: tagSchemeId,
    type: 'skos:ConceptScheme',
    sourceExternalId: 'vocabulary:vndb.tag.cont',
    labels: { en: 'cont' },
    statements: { 'schema:url': [{ value: { type: 'value', content: tagSchemeUri } }] },
  });
  subjects.set(tagConceptId, {
    id: tagConceptId,
    type: 'skos:Concept',
    sourceExternalId: 'vocabulary:vndb.tag.cont:g105',
    labels: { und: 'Reviewed tag' },
    statements: {
      'schema:url': [{ value: { type: 'value', content: tagConceptUri } }],
      'skos:inScheme': [{ value: { type: 'value', content: tagSchemeId } }],
    },
  });
  const bySource = new Map<string, string>();
  const candidates = new Map<
    string,
    { id: string; source: BatchCommand['source'] | null; statement: BatchStatement; head: number | null }
  >();
  const synopsisDocuments = new Map<string, { document: string; digest: string; language: string }>();
  const accepted = new Set<string>();
  const adopted = new Map<string, { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }>();
  const publicReadIds = new Set<string>();
  const publicReads = new Map<string, any>();
  const acceptanceCalls: { candidateId: string; body: unknown; idempotencyKey: string }[] = [];
  let refuseAcceptance = true;
  let acceptanceRefusalStatus = 503;
  let tagSpoiler = 0;
  const unavailableReviewSubjects = new Set<string>();
  let selectedSynopsisOverride: 'changed' | 'missing' | 'unsupported' | 'unavailable' | undefined;
  let omitSelectedSynopsisOperands = false;
  const metadata = sourceRecordMetadataFixture();

  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 101, name: 'STEINS;GATE', type: 2, summary: 'Source synopsis for the first selected work.' };
        yield { id: 102, name: 'CLANNAD', type: 2, summary: 'Source synopsis for the second selected work.' };
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
      if (provider === 'vndb' && table === 'tags')
        yield { id: 'g105', cat: 'cont', defaultspoil: 0, searchable: true, applicable: true };
      if (provider === 'vndb' && table === 'tags_vn')
        yield { tag: 'g105', vid: 'v2', uid: null, vote: 3, spoiler: tagSpoiler, ignore: false, lie: false };
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
      const results = request.commands.map((command) => {
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
      });
      return { results };
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
  const prepareSelectedTags = () =>
    prepareShowcaseTags({
      tables,
      selectedVids: ['v2'],
      port,
      known: {
        schemes: [{ category: 'cont', id: tagSchemeId }],
        concepts: [{ category: 'cont', code: 'g105', id: tagConceptId }],
      },
      fetch: async () =>
        Response.json({
          more: false,
          results: [{ id: 'v2', tags: [{ id: 'g105', rating: 4.5, spoiler: 0, lie: false }] }],
        }),
    });
  try {
    let preparedTags = await prepareSelectedTags();
    const seed = () =>
      seedShowcaseVndbReleases({
        tables,
        plan,
        path: join(directory, 'import.sqlite'),
        port: captureShowcaseCommands(port, journal),
        destination: { origin: 'https://fixture.test' },
        extras: {
          providers: ['bangumi', 'vndb'],
          mediaDeadlineMs: 0,
          vocabularyAdmissions: [preparedTags.vocabularyAdmission],
        },
      });
    let result = await seed();
    const initialResult = result;
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
      async fence() {
        return { fenced: false, securityRevision: null };
      },
      async readReviewedSubject(id) {
        if (unavailableReviewSubjects.has(id)) throw new Error('current subject unavailable');
        return read(id);
      },
      async reviewedCandidates(id, query) {
        expect(query.context).toBe(globalContext);
        const adoption = adopted.get(`${id}\0${query.property}`);
        return {
          candidates: [...candidates.values()]
            .filter(
              (candidate) =>
                (candidate.source?.external_id === subjects.get(id)?.sourceExternalId &&
                  candidate.statement.property.id === query.property) ||
                (candidate.id === unrelatedId && id === workId && query.property === 'schema:name'),
            )
            .map((candidate) => ({
              ...candidate,
              decision: accepted.has(candidate.id) ? 'accepted' : null,
              rank: adoption?.selection.find((selection) => selection.candidate === candidate.id)?.rank ?? null,
            }))
            .concat([{ id: randomUUID(), deleted: true }] as never),
          next: null,
          adoption: adoption ? { head: adoption.head, mode: 'replace' } : null,
        } as never;
      },
      async acceptReviewedCandidate(_id, candidateId, body, idempotencyKey) {
        acceptanceCalls.push({ candidateId, body, idempotencyKey });
        if (refuseAcceptance) {
          const error = new Error('refused') as Error & { status: number };
          error.status = acceptanceRefusalStatus;
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
        const url = new URL(String(input));
        const id = url.pathname.split('/').at(-1)!;
        publicReadIds.add(id);
        const value = read(id);
        const rawRows = value.subject.statements['schema:abstract'] ?? [];
        const currentRows = rawRows.map((row) => {
          const candidate = [...candidates.values()].find((entry) => entry.statement === row);
          if (!candidate) return row;
          const synopsis = (() => {
            const retained = synopsisDocuments.get(candidate.id);
            if (retained) return retained;
            const value = candidate.statement.value;
            if (candidate.statement.property.id !== 'schema:abstract' || value.type !== 'value')
              throw new Error('Selected synopsis fixture must have a document value');
            const content = value.content as { document?: unknown; language?: unknown };
            if (typeof content.language !== 'string' || !content.document)
              throw new Error('Selected synopsis fixture is missing its authored snapshot');
            const current = {
              document: randomUUID(),
              digest: createHash('sha256').update(JSON.stringify(content.document)).digest('hex'),
              language: content.language,
            };
            synopsisDocuments.set(candidate.id, current);
            return current;
          })();
          const refs = Array.isArray(candidate.statement.references)
            ? candidate.statement.references.map((reference, index) => ({
                ...reference,
                hash: `fixture-reference-${index}`,
                parts: reference.parts.map((part) => ({
                  ...part,
                  property: {
                    ...part.property,
                    data_type: nativeDataType(part.property.id),
                  },
                })),
              }))
            : [];
          return {
            ...candidate.statement,
            value: { type: 'value' as const, content: synopsis },
            id: candidate.id,
            rank:
              adopted.get(`${id}\0schema:abstract`)?.selection.find((item) => item.candidate === candidate.id)?.rank ??
              'normal',
            property: { ...candidate.statement.property, data_type: 'document' },
            qualifiers: (candidate.statement.qualifiers ?? []).map((snak) => ({
              ...snak,
              property: {
                ...snak.property,
                data_type: nativeDataType(snak.property.id),
              },
            })),
            references: refs,
          };
        });
        const publicSubject = {
          ...value.subject,
          ...(omitSelectedSynopsisOperands ? {} : { context: globalContext, release: `sha256:${'a'.repeat(64)}` }),
          statements: { ...value.subject.statements, 'schema:abstract': currentRows },
        };
        const publicValue = { ...value, subject: publicSubject };
        if (!url.searchParams.has('selectedSynopsis')) {
          publicReads.set(id, publicValue);
          return Response.json(publicValue);
        }
        let selectedSynopsis: unknown;
        if (selectedSynopsisOverride) selectedSynopsis = { kind: selectedSynopsisOverride };
        else {
          const query = JSON.parse(url.searchParams.get('selectedSynopsis')!) as {
            statement: string;
            document: string;
            digest: string;
            language: string;
          };
          const current = currentRows.find((row) => row.id === query.statement) as Record<string, any> | undefined;
          const content = current?.value?.content;
          if (
            !current ||
            content?.document !== query.document ||
            content?.digest !== query.digest ||
            content?.language !== query.language
          )
            selectedSynopsis = { kind: 'changed' };
          else
            selectedSynopsis = {
              kind: 'matched',
              context: publicSubject.context,
              release: publicSubject.release,
              fact: {
                ...current,
                value: { type: 'somevalue' },
              },
            };
        }
        const responseValue = { ...publicValue, selectedSynopsis };
        publicReads.set(id, responseValue);
        return Response.json(responseValue);
      }) as typeof fetch,
    });
    let tagOptions = {
      tagAssociations: preparedTags.associationBindings,
      tagAssociationRefreshes: preparedTags.associationRefreshes,
      tagWeightObservations: preparedTags.tagWeightObservations,
      tagWeightRefreshes: preparedTags.tagWeightRefreshes,
    };
    // A fresh public reader can see the native Subject before its source identifier is adopted.
    // Publication must recover that exact original create target without rewriting seed identity evidence.
    const firstInput = { ...result, readings: result.readings.filter((reading) => reading.externalId !== '101') };
    const first = await publishShowcase({
      plan,
      result: firstInput,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(first.status).toBe('incomplete');
    expect(first.manifest.records.find((record) => record.sourceKey === '101')?.subjectId).toBe(workId);
    expect(firstInput.readings.some((reading) => reading.externalId === '101')).toBe(false);
    const acknowledged = journal.acknowledgedCommands().filter((entry) => entry.candidateId);
    expect(acknowledged.length).toBeGreaterThan(0);
    expect(accepted.size).toBe(0);
    const synopses = [...candidates.values()].filter(
      (candidate) => candidate.statement.property.id === 'schema:abstract',
    );
    expect(synopses.map((candidate) => candidate.source?.external_id).sort()).toEqual(['101', '102']);
    for (const candidate of synopses) {
      const proposal = acknowledged.find((entry) => entry.candidateId === candidate.id);
      expect(proposal?.command).toMatchObject({
        op: 'propose',
        source: { external_id: candidate.source?.external_id, field_group: 'summary' },
        rights: { license: 'CC-BY-SA-3.0', obligations: ['cc:Attribution', 'cc:ShareAlike'] },
      });
      const subject = [...subjects.values()].find((item) => item.sourceExternalId === candidate.source?.external_id)!;
      expect(subject.statements['schema:abstract']).toBeUndefined();
      expect(adopted.has(`${subject.id}\0schema:abstract`)).toBe(false);
    }
    const membership = acknowledged.find(
      (entry) =>
        entry.command.op === 'propose' &&
        entry.command.statement.property.id === 'schema:genre' &&
        !entry.command.statement.qualifiers?.some((term) => term.property.id === 'rezics:sourceTagWeightMetric'),
    );
    expect(membership?.command.op).toBe('propose');
    if (!membership || membership.command.op !== 'propose') throw new Error('Missing selected tag membership');
    expect(
      membership.command.statement.references?.flatMap((reference) => reference.parts).map((part) => part.value),
    ).toContainEqual({ type: 'value', content: 'https://vndb.org/v2.1#/tags_vn/v2/g105/tag' });
    const membershipCandidateId = membership.candidateId!;
    const interruptedSynopsis = synopses.find((candidate) => candidate.source?.external_id === '101')!;
    const interruptedSynopsisProposal = acknowledged.find((entry) => entry.candidateId === interruptedSynopsis.id)!;
    const lostAckPath = join(directory, 'lost-proposal.sqlite');
    let lostAckJournal = new ShowcaseJournal(lostAckPath);
    const remoteCandidates = new Map<string, string>();
    const deliveredCommands: BatchCommand[][] = [];
    let loseFirstResponse = true;
    const remotePort = {
      ...port,
      async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
        deliveredCommands.push(structuredClone([...request.commands]));
        const results = request.commands.map((command) => {
          if (command.op === 'propose') {
            const candidate = remoteCandidates.get(command.key) ?? randomUUID();
            remoteCandidates.set(command.key, candidate);
            return { key: command.key, status: 201 as const, value: { candidate, revision: 1 } };
          }
          if (command.op === 'create')
            return { key: command.key, status: 201 as const, value: { id: randomUUID(), revision: 1 } };
          return { key: command.key, status: 200 as const, value: { revision: 1 } };
        });
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('simulated lost selected synopsis proposal acknowledgement');
        }
        return { results };
      },
    } as CrossMediaPort;
    try {
      await expect(
        captureShowcaseCommands(remotePort, lostAckJournal).batch({
          commands: [interruptedSynopsisProposal.command],
        }),
      ).rejects.toThrow('simulated lost selected synopsis proposal acknowledgement');
      expect(lostAckJournal.preparedCommands().map((entry) => entry.command)).toContainEqual(
        interruptedSynopsisProposal.command,
      );
      expect(lostAckJournal.acknowledgedCommands()).toEqual([]);
      lostAckJournal.close();
      lostAckJournal = new ShowcaseJournal(lostAckPath);
      const replayResult = await captureShowcaseCommands(remotePort, lostAckJournal).batch({
        commands: [interruptedSynopsisProposal.command],
      });
      expect(deliveredCommands).toEqual([[interruptedSynopsisProposal.command], [interruptedSynopsisProposal.command]]);
      expect(replayResult.results).toEqual([
        {
          key: interruptedSynopsisProposal.command.key,
          status: 201,
          value: { candidate: remoteCandidates.get(interruptedSynopsisProposal.command.key), revision: 1 },
        },
      ]);
      expect(lostAckJournal.acknowledgedCommands()).toContainEqual(
        expect.objectContaining({
          command: interruptedSynopsisProposal.command,
          candidateId: remoteCandidates.get(interruptedSynopsisProposal.command.key),
        }),
      );
    } finally {
      lostAckJournal.close();
    }
    expect(preparedTags.associationBindings).toEqual([
      expect.objectContaining({
        workId: 'v2',
        sourceKey: '/tags_vn/v2/g105/tag',
        tagId: 'g105',
        conceptId: tagConceptId,
        schemeId: tagSchemeId,
      }),
    ]);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    refuseAcceptance = false;
    const tagAcceptanceCallsBeforeReplay = acceptanceCalls.filter(
      (call) => call.candidateId === membershipCandidateId,
    ).length;
    const retainedCommands = journal.acknowledgedCommands();
    const failure = new Error(
      'SQLITE_IOERR private response token=secret https://user:password@fixture.test/?key=secret',
    );
    const failedPhases: string[] = [];
    const journalRead = spyOn(journal, 'acknowledgedCommands').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      await expect(
        publishShowcase({
          plan,
          result,
          aliases: crossMediaAliases,
          journal,
          review,
          publicClient,
          onProgress: (line) => failedPhases.push(line),
        }),
      ).rejects.toBe(failure);
    } finally {
      journalRead.mockRestore();
    }
    expect(failedPhases.at(-1)).toContain('state=failed scope=publication phase=target-current-reads');
    expect(failedPhases.at(-1)).toContain('remaining=target-current-reads,candidate-recovery');
    expect(failedPhases.some((line) => line.includes('state=completed'))).toBe(false);
    expect(formatSeedError(failure)).toStartWith('Cross-media seed failed finalization{scope=publication');
    expect(formatSeedError(failure)).not.toMatch(/secret|password|private response|fixture\.test/u);
    expect(journal.acknowledgedCommands()).toEqual(retainedCommands);
    expect(journal.preparedCommands()).toEqual([]);
    const publicationPhases: string[] = [];
    const replayed = await publishShowcase({
      onProgress: (line) => publicationPhases.push(line),
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(replayed.status).toBe('published');
    expect(publicationPhases).toHaveLength(12);
    expect(publicationPhases.at(-2)).toContain('phase=manifest-finalization remaining=manifest-finalization');
    expect(publicationPhases.at(-1)).toBe(
      'Cross-media seed finalization state=completed scope=publication remaining=none',
    );
    // Equal acceptance bodies for distinct targets must never share a receipt key.
    const candidateKeys = new Map<string, string>();
    for (const call of acceptanceCalls) {
      const target = candidateKeys.get(call.idempotencyKey);
      if (target) expect(call.candidateId).toBe(target);
      candidateKeys.set(call.idempotencyKey, call.candidateId);
    }
    expect(replayed.manifest.digest).toBe(first.manifest.digest);
    expect(accepted).toEqual(new Set(acknowledged.map((entry) => entry.candidateId!)));
    for (const candidate of synopses) {
      const subject = [...subjects.values()].find((item) => item.sourceExternalId === candidate.source?.external_id)!;
      expect(accepted.has(candidate.id)).toBe(true);
      expect(adopted.get(`${subject.id}\0schema:abstract`)?.selection).toEqual([
        { candidate: candidate.id, rank: 'normal' },
      ]);
      expect(subject.statements['schema:abstract']).toEqual([candidate.statement]);
      expect(publicReadIds.has(subject.id)).toBe(true);
      expect(publicReads.get(subject.id)?.subject?.statements?.['schema:abstract']).toEqual([
        expect.objectContaining({
          id: candidate.id,
          rank: 'normal',
          value: { type: 'value', content: synopsisDocuments.get(candidate.id) },
        }),
      ]);
      const publishedSynopsis = replayed.published
        .find((record) => record.provider === 'bangumi' && record.sourceKey === candidate.source?.external_id)
        ?.assertions.find((assertion) => assertion.candidateId === candidate.id);
      expect(publishedSynopsis).toMatchObject({
        candidateId: candidate.id,
        property: 'schema:abstract',
        citations: [`https://bgm.tv/subject/${candidate.source?.external_id}`],
        adoption: { head: 1, candidateId: candidate.id, rank: 'normal' },
        readback: {
          id: candidate.id,
          rank: 'normal',
          property: { id: 'schema:abstract', data_type: 'document' },
          value: { type: 'value', content: synopsisDocuments.get(candidate.id) },
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url', data_type: 'url' },
                  value: { type: 'value', content: `https://bgm.tv/subject/${candidate.source?.external_id}` },
                },
              ],
            },
          ],
        },
      });
    }
    const tagAcceptanceCalls = acceptanceCalls.filter((call) => call.candidateId === membershipCandidateId);
    expect(tagAcceptanceCalls.length - tagAcceptanceCallsBeforeReplay).toBe(1);

    omitSelectedSynopsisOperands = true;
    const absentCurrentSlot = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(absentCurrentSlot.status).toBe('incomplete');
    expect(absentCurrentSlot.omissions).toContainEqual({
      provider: 'bangumi',
      sourceKey: '101',
      code: 'selected-synopsis-not-current',
    });
    expect(
      absentCurrentSlot.published.some((record) => record.provider === 'bangumi' && record.sourceKey === '101'),
    ).toBe(false);
    omitSelectedSynopsisOperands = false;

    for (const kind of ['changed', 'missing', 'unsupported', 'unavailable'] as const) {
      selectedSynopsisOverride = kind;
      const withheld = await publishShowcase({
        plan,
        result,
        aliases: crossMediaAliases,
        journal,
        review,
        publicClient,
        ...tagOptions,
      });
      expect(withheld.status).toBe('incomplete');
      expect(withheld.omissions).toContainEqual({
        provider: 'bangumi',
        sourceKey: '101',
        code: 'selected-synopsis-not-current',
      });
    }
    selectedSynopsisOverride = undefined;
    const recoveredCurrentSynopsis = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(recoveredCurrentSynopsis.status).toBe('published');
    expect(
      recoveredCurrentSynopsis.published.some((record) => record.provider === 'bangumi' && record.sourceKey === '101'),
    ).toBe(true);

    const reopenedSynopsis = synopses.find((candidate) => candidate.source?.external_id === '101')!;
    const reopenedSubject = [...subjects.values()].find(
      (item) => item.sourceExternalId === reopenedSynopsis.source?.external_id,
    )!;
    adopted.set(`${reopenedSubject.id}\0schema:abstract`, { head: 2, selection: [] });
    delete reopenedSubject.statements['schema:abstract'];
    const restored = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(restored.status).toBe('published');
    expect(
      restored.published
        .find((record) => record.provider === 'bangumi' && record.sourceKey === '101')
        ?.assertions.find((assertion) => assertion.candidateId === reopenedSynopsis.id),
    ).toMatchObject({
      candidateId: reopenedSynopsis.id,
      property: 'schema:abstract',
      citations: ['https://bgm.tv/subject/101'],
      adoption: { head: 3, candidateId: reopenedSynopsis.id, rank: 'normal' },
      readback: {
        id: reopenedSynopsis.id,
        rank: 'normal',
        property: { id: 'schema:abstract', data_type: 'document' },
        value: { type: 'value', content: synopsisDocuments.get(reopenedSynopsis.id) },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'https://bgm.tv/subject/101' },
              },
            ],
          },
        ],
      },
    });

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    unavailableReviewSubjects.add(vndbTargetId);
    subjects.get(tagConceptId)!.statements['skos:inScheme'] = [
      { value: { type: 'value', content: '00000000-0000-4000-8000-000000000043' } },
    ];
    const withdrawn = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(withdrawn.status).toBe('incomplete');
    expect(
      withdrawn.published.find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')?.assertions,
    ).not.toContainEqual(expect.objectContaining({ property: 'schema:genre' }));
    expect(
      subjects.get(
        result.readings.find((reading) => reading.source === 'vndb' && reading.externalId === 'v2')!.subject.subject!
          .id!,
      )!.statements['schema:genre'],
    ).toEqual([]);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    unavailableReviewSubjects.delete(vndbTargetId);
    subjects.get(tagConceptId)!.statements['skos:inScheme'] = [{ value: { type: 'value', content: tagSchemeId } }];
    publicReadIds.clear();
    const withheldSource = withdrawn.published.find(
      (record) => record.provider === 'vndb' && record.sourceKey === 'r1',
    );
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:name')).toBe(true);
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:exampleOfWork')).toBe(false);
    const withheldTagWork = withdrawn.published.find(
      (record) => record.provider === 'vndb' && record.sourceKey === 'v2',
    );
    expect(withheldTagWork?.assertions.some((assertion) => assertion.property === 'schema:genre')).toBe(false);
    expect(withdrawn.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v2',
      code: 'vocabulary-binding-missing',
    });
    expect(accepted.has(membershipCandidateId)).toBe(true);
    tagSpoiler = 1;
    preparedTags = await prepareSelectedTags();
    result = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'import.sqlite'),
      port: captureShowcaseCommands(port, journal),
      destination: { origin: 'https://fixture.test' },
      extras: {
        providers: ['bangumi', 'vndb'],
        mediaDeadlineMs: 0,
        vocabularyAdmissions: [preparedTags.vocabularyAdmission],
      },
    });
    tagOptions = {
      tagAssociations: preparedTags.associationBindings,
      tagAssociationRefreshes: preparedTags.associationRefreshes,
      tagWeightObservations: preparedTags.tagWeightObservations,
      tagWeightRefreshes: preparedTags.tagWeightRefreshes,
    };
    publicReadIds.clear();
    const resumed = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(resumed.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v2',
      code: 'vocabulary-binding-missing',
    });
    expect(resumed.status).toBe('incomplete');
    expect(resumed.published.map((record) => record.subjectId).sort()).toEqual([...workIds].sort());
    expect(accepted).toEqual(
      new Set(
        journal
          .acknowledgedCommands()
          .filter((entry) => entry.candidateId)
          .map((entry) => entry.candidateId!),
      ),
    );
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
    const tagWorkId = result.readings.find((reading) => reading.source === 'vndb' && reading.externalId === 'v2')!
      .subject.subject!.id!;
    expect(publicReadIds.has(tagWorkId)).toBe(true);
    const refreshedMembership = journal
      .acknowledgedCommands()
      .find(
        (entry) =>
          entry.command.op === 'propose' &&
          entry.command.statement.property.id === 'schema:genre' &&
          entry.command.statement.qualifiers?.some(
            (term) =>
              term.property.id === 'rezics:spoilerLevel' &&
              term.value.type === 'value' &&
              JSON.stringify(term.value.content) === JSON.stringify({ amount: '+1', unit: '1' }),
          ),
      );
    expect(refreshedMembership?.candidateId).toBeTruthy();
    expect(refreshedMembership?.candidateId).not.toBe(membershipCandidateId);
    const refreshedCommand = refreshedMembership?.command;
    expect(refreshedCommand?.op).toBe('propose');
    if (!refreshedCommand || refreshedCommand.op !== 'propose') throw new Error('Missing refreshed tag proposal');
    expect(subjects.get(tagWorkId)!.statements['schema:genre']).toContainEqual(refreshedCommand.statement);
    expect(subjects.get(tagWorkId)!.statements['schema:genre']).not.toContainEqual(membership.command.statement);
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
    expect(replayed.manifest.digest).toBe(first.manifest.digest);
    expect(resumed.manifest.records[0]?.sourceRevision).toBe('unversioned');
    expect(resumed.published[0]?.readerRoute).toBe(`/subjects/${workId}/steins-gate`);

    // Native canonical Work reads preserve the original adoption owner and supply the current reader address.
    const canonicalId = randomUUID();
    const canonicalRead = (value: ReviewedSubjectRead): ReviewedSubjectRead => ({
      ...value,
      subject: { ...value.subject, id: value.subject.id === workId ? canonicalId : value.subject.id },
    });
    const canonical = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: { ...review, readReviewedSubject: async (id) => canonicalRead(await review.readReviewedSubject(id)) },
      publicClient: {
        readSubject: async (id) => canonicalRead(await publicClient.readSubject(id)),
        readSelectedSynopsis: async (id, query, signal) =>
          canonicalRead(await publicClient.readSelectedSynopsis(id, query, signal)),
      },
      ...tagOptions,
    });
    const canonicalWork = canonical.published.find((record) => record.subjectId === workId);
    expect(canonicalWork?.readerRoute).toBe(`/subjects/${canonicalId}/steins-gate`);
    expect(canonicalWork?.assertions.map((assertion) => assertion.candidateId)).toEqual(
      resumed.published
        .find((record) => record.subjectId === workId)
        ?.assertions.map((assertion) => assertion.candidateId),
    );

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

    const refusedCandidate = synopses.find((candidate) => candidate.source?.external_id === '101')!;
    const refusedAssertion = resumed.manifest.records
      .find((record) => record.provider === 'bangumi' && record.sourceKey === '101')
      ?.assertions.find((assertion) => assertion.candidateId === refusedCandidate.id);
    if (!refusedAssertion) throw new Error('Missing selected synopsis for permanent refusal recovery');
    const refusedAction = `accept:${showcaseDigest({ identity: refusedCandidate.id, digest: refusedAssertion.candidateDigest })}`;
    accepted.delete(refusedCandidate.id);
    journal.refuseAction(refusedAction, 'review-http-403');
    const refusedCallsBefore = acceptanceCalls.filter((call) => call.candidateId === refusedCandidate.id).length;
    const permanentlyRefused = await publishShowcase({
      plan,
      result: initialResult,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(permanentlyRefused.omissions).toContainEqual({
      provider: 'bangumi',
      sourceKey: '101',
      code: 'review-http-403',
    });
    expect(acceptanceCalls.filter((call) => call.candidateId === refusedCandidate.id)).toHaveLength(refusedCallsBefore);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const refusalReopened = await publishShowcase({
      plan,
      result: initialResult,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(refusalReopened.omissions).toContainEqual({
      provider: 'bangumi',
      sourceKey: '101',
      code: 'review-http-403',
    });
    expect(acceptanceCalls.filter((call) => call.candidateId === refusedCandidate.id)).toHaveLength(refusedCallsBefore);
    // Dependency stages must not revisit the whole selected family or its journal on resume.
    const requirements: ShowcaseVocabularyRequirement[] = [];
    for (const sourceKey of ['vndb.stage-one', 'vndb.stage-two']) {
      const sourceUri = `https://vndb.org/${sourceKey}`;
      const source: BatchCommand['source'] = {
        source: crossMediaAliases.vndb,
        external_id: showcaseVocabularyExternalId(sourceKey),
        record_revision: 'unversioned',
        digest: 'a'.repeat(64),
        converter_revision: 'stage-vocabulary@1',
        field_group: 'facts',
      };
      const created = await captureShowcaseCommands(port, journal).batch({
        commands: [
          {
            op: 'create',
            key: `${sourceKey}:create`,
            source,
            subject: { type: 'skos:ConceptScheme', labels: { en: sourceKey } },
          },
        ],
      });
      const receipt = created.results[0]!;
      if (!('value' in receipt)) throw new Error('Vocabulary create failed');
      const subjectId = (receipt.value as { id: string }).id;
      await captureShowcaseCommands(port, journal).batch({
        commands: [
          {
            op: 'propose',
            key: `${sourceKey}:url`,
            source,
            subject: subjectId,
            statement: {
              property: { id: 'schema:url' },
              value: { type: 'value', content: sourceUri },
              references: [
                { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUri } }] },
              ],
            },
          },
        ],
      });
      requirements.push({
        provider: 'vndb',
        ownerKey: 'v1',
        sourceKey,
        source,
        sourceUri,
        nativeType: 'skos:ConceptScheme',
      });
    }
    const stage = (selected: ShowcaseVocabularyRequirement[]) =>
      publishShowcaseVocabulary({
        plan,
        result: initialResult,
        aliases: crossMediaAliases,
        journal,
        review,
        publicClient,
        vocabularyRequirements: selected,
        onProgress() {},
      });
    const journalReads = spyOn(journal, 'acknowledgedCommands');
    const candidateReads = spyOn(review, 'reviewedCandidates');
    try {
      publicReadIds.clear();
      const firstStage = await stage(requirements.slice(0, 1));
      expect(firstStage.status).toBe('published');
      expect(firstStage.manifest.records).toEqual([]);
      expect(firstStage.published.map((row) => row.sourceKey)).toEqual(['vndb.stage-one']);
      const stageId = firstStage.published[0]!.subjectId;
      expect([...publicReadIds]).toEqual([stageId]);
      const calls = candidateReads.mock.calls.length;
      const writes = acceptanceCalls.length;
      candidateReads.mockClear();
      publicReadIds.clear();
      const repeated = await stage(requirements.slice(0, 1));
      expect(repeated.status).toBe('published');
      expect(candidateReads.mock.calls.length).toBeGreaterThan(0);
      expect(candidateReads.mock.calls.length).toBeLessThanOrEqual(calls);
      expect(candidateReads.mock.calls.every(([id]) => id === stageId)).toBe(true);
      expect([...publicReadIds]).toEqual([stageId]);
      expect(acceptanceCalls).toHaveLength(writes);
      expect(journalReads.mock.calls).toEqual([[[requirements[0]!.source]], [[requirements[0]!.source]]]);
      for (const entry of journalReads.mock.results) expect(entry.value).toHaveLength(2);
      const expanded = await stage(requirements);
      expect(expanded.status).toBe('published');
      expect(expanded.published.map((row) => row.sourceKey)).toEqual(requirements.map((row) => row.sourceKey));
      expect(acceptanceCalls).toHaveLength(writes + 1);
      const hidden = await publishShowcaseVocabulary({
        plan,
        result: initialResult,
        aliases: crossMediaAliases,
        journal,
        review,
        publicClient: {
          ...publicClient,
          async readSubject() {
            throw new Error('unavailable');
          },
        },
        vocabularyRequirements: requirements,
        onProgress() {},
      });
      expect(hidden.status).toBe('incomplete');
      expect(hidden.published).toEqual([]);
    } finally {
      journalReads.mockRestore();
      candidateReads.mockRestore();
    }
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('explicit 422 replaces a collided review receipt; unknown delivery keeps the sealed key', () => {
  const journal = new ShowcaseJournal(':memory:');
  try {
    const action = 'accept:target-a';
    const body = { context: globalContext, expected_head: 1 };
    journal.prepareAction(action, body, 'sealed-key');
    expect(journal.prepareAction(action, body, 'caller-key')).toEqual(body);
    expect(journal.action(action)).toMatchObject({
      idempotency_key: 'sealed-key',
      state: 'prepared',
    });

    journal.refuseAction(action, 'review-http-422');
    expect(journal.prepareAction(action, body, 'replacement-key')).toEqual(body);
    expect(journal.action(action)).toMatchObject({
      idempotency_key: 'replacement-key',
      state: 'prepared',
      error_code: null,
    });
    expect(journal.actionDecisions(action)).toEqual([
      {
        decision: 'explicit-422-key',
        refusal: 'review-http-422',
        priorIdempotencyKey: 'sealed-key',
        idempotencyKey: 'replacement-key',
      },
    ]);

    journal.refuseAction(action, 'review-http-409');
    expect(journal.prepareAction(action, body, 'ignored-key')).toEqual(body);
    expect(journal.action(action)).toMatchObject({
      idempotency_key: 'replacement-key',
      state: 'refused',
      error_code: 'review-http-409',
    });
    expect(journal.actionDecisions(action)).toHaveLength(1);
    expect(journal.prepareAction(action, { ...body, expected_head: 2 }, 'changed-key')).toEqual({
      ...body,
      expected_head: 2,
    });
    expect(journal.actionDecisions(action).at(-1)).toEqual({
      decision: 'changed-body',
      refusal: 'review-http-409',
      priorIdempotencyKey: 'replacement-key',
      idempotencyKey: 'changed-key',
    });
  } finally {
    journal.close();
  }
});

test('a served cover is named by its public summary in normalized order, and each decision must match its own type', () => {
  const mediaId = randomUUID();
  const read = (cover: unknown) => ({ subject: { id: randomUUID() }, summary: { cover } }) as ReviewedSubjectRead;
  const unordered = [
    { format: 'webp', width: 640 },
    { format: 'webp', width: 320 },
    { format: 'avif', width: 320 },
  ];
  expect(
    servedCoverVariants(read({ media: mediaId, width: 1200, height: 1800, variants: unordered }), mediaId),
  ).toEqual([
    { format: 'avif', width: 320 },
    { format: 'webp', width: 320 },
    { format: 'webp', width: 640 },
  ]);
  expect(servedCoverVariants(read(null), mediaId)).toBeUndefined();
  expect(servedCoverVariants({ subject: { id: randomUUID() } } as ReviewedSubjectRead, mediaId)).toBeUndefined();
  expect(servedCoverVariants(read({ media: randomUUID(), variants: unordered }), mediaId)).toBeUndefined();
  expect(servedCoverVariants(read({ media: mediaId, variants: [] }), mediaId)).toBeUndefined();
  expect(
    servedCoverVariants(read({ media: mediaId, variants: [{ format: 'jpeg', width: 320 }] }), mediaId),
  ).toBeUndefined();
  const decision = {
    allowed: true,
    key: 'media/served-avif-320',
    sha256: 'a'.repeat(64),
    mediaType: 'image/avif',
    byteCount: 1024,
    publicCache: false,
    cacheControl: 'private, no-cache',
  } as const;
  expect(servedVariantDecisionCurrent(decision, { format: 'avif', width: 320 })).toBe(true);
  expect(servedVariantDecisionCurrent(decision, { format: 'webp', width: 320 })).toBe(false);
});

test('stale adoption heads keep their sealed body and resume on a fresh journal generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-adopt-stale-head-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const subjectId = randomUUID();
  const candidate = randomUUID();
  const intent = 'manifest-digest';
  const planned = {
    context: globalContext,
    property: 'schema:abstract',
    mode: 'replace' as const,
    expected_head: 1,
    selection: [{ candidate, rank: 'normal' as const }],
  };
  const calls: {
    body: { expected_head: number | null; selection: { candidate: string; rank: string }[] };
    key: string;
  }[] = [];
  let stale = true;
  const review = {
    async adoptReviewedCandidates(
      _id: string,
      body: { expected_head: number | null; selection: { candidate: string; rank: string }[] },
      key: string,
    ) {
      calls.push({ body, key });
      if (stale) {
        stale = false;
        throw Object.assign(new Error('adoption head changed'), { status: 412 });
      }
      return { adoption: { head: 2, selection: body.selection } };
    },
  } as Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>;
  try {
    const first = await sendDurableAdopt({
      journal,
      review,
      subjectId,
      intent,
      planned,
      current: { selection: [] },
    });
    expect(first).toEqual({ status: 'interrupted', code: 'review-http-412' });
    const keys = adoptResumeKeys(journal, subjectId, planned.property, intent, planned);
    expect(keys.map((key) => journal.action(key)?.state)).toContain('refused');

    const resumed = await sendDurableAdopt({
      journal,
      review,
      subjectId,
      intent,
      planned: { ...planned, expected_head: 2 },
      current: { selection: [] },
    });
    expect(resumed).toEqual({
      status: 'complete',
      snapshot: { head: 2, selection: planned.selection },
    });
    expect(calls.map(({ body }) => body.expected_head)).toEqual([1, 2]);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable adopt resumes previous keys and later prepared actions before matching acknowledgements, then continues past 32 generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-adopt-lifetime-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const subjectId = randomUUID();
  const candidate = randomUUID();
  const other = randomUUID();
  const intent = 'manifest-digest';
  const planned = {
    context: globalContext,
    property: 'schema:abstract',
    mode: 'replace' as const,
    expected_head: 1,
    selection: [{ candidate, rank: 'normal' as const }],
  };
  const otherBody = { ...planned, selection: [{ candidate: other, rank: 'preferred' as const }] };
  const adoptKey = (digest: string) => `adopt:${showcaseDigest({ identity: `${subjectId}:schema:abstract`, digest })}`;
  const calls: { body: unknown; key: string }[] = [];
  const review = {
    async adoptReviewedCandidates(
      _id: string,
      body: { selection: { candidate: string; rank: string }[] },
      key: string,
    ) {
      calls.push({ body, key });
      return { adoption: { head: calls.length, selection: body.selection } };
    },
  } as Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>;
  try {
    const laterKey = adoptKey(showcaseDigest({ intent, generation: 1 }));
    journal.prepareAction(laterKey, planned, showcaseDigest({ action: laterKey, body: planned }));
    const gen0 = adoptKey(showcaseDigest({ intent, generation: 0 }));
    journal.prepareAction(gen0, planned, showcaseDigest({ action: gen0, body: planned }));
    journal.acknowledgeAction(gen0);
    const historical = await sendDurableAdopt({
      journal,
      review,
      subjectId,
      intent,
      planned,
      current: { selection: planned.selection },
    });
    expect(historical.status).toBe('complete');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(journal.action(laterKey)!.idempotency_key);

    const previousJournal = new ShowcaseJournal(join(directory, 'previous.sqlite'));
    const previousKey = adoptKey(showcaseDigest({ intent, body: planned }));
    previousJournal.prepareAction(previousKey, planned, 'previous-key');
    const previousCalls: string[] = [];
    const previous = await sendDurableAdopt({
      journal: previousJournal,
      review: {
        async adoptReviewedCandidates(_id, _body, key) {
          previousCalls.push(key);
          return { adoption: { head: 1, selection: planned.selection } };
        },
      } as Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>,
      subjectId,
      intent,
      planned,
      current: { selection: planned.selection },
    });
    expect(previous.status).toBe('complete');
    expect(previousCalls).toEqual(['previous-key']);
    previousJournal.close();

    const emptyJournal = new ShowcaseJournal(join(directory, 'empty.sqlite'));
    const emptyPlanned = { ...planned, selection: [] as typeof planned.selection };
    const skipped = await sendDurableAdopt({
      journal: emptyJournal,
      review,
      subjectId,
      intent,
      planned: emptyPlanned,
      current: { selection: [] },
    });
    expect(skipped.status).toBe('complete');
    expect(calls).toHaveLength(1);
    const emptyKey = adoptKey(showcaseDigest({ intent }));
    emptyJournal.prepareAction(emptyKey, emptyPlanned, 'empty-pending');
    const emptied = await sendDurableAdopt({
      journal: emptyJournal,
      review,
      subjectId,
      intent,
      planned: emptyPlanned,
      current: { selection: [] },
    });
    expect(emptied.status).toBe('complete');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe('empty-pending');
    emptyJournal.close();

    const refreshed = await sendDurableAdopt({
      journal,
      review,
      subjectId,
      intent,
      planned,
      current: { selection: planned.selection },
    });
    expect(refreshed.status).toBe('complete');
    expect(calls).toHaveLength(2);

    const boundJournal = new ShowcaseJournal(join(directory, 'bound.sqlite'));
    for (let generation = 0; generation < 32; generation += 1) {
      const action = adoptKey(showcaseDigest({ intent, generation }));
      boundJournal.prepareAction(action, otherBody, `bound-${generation}`);
      boundJournal.acknowledgeAction(action);
    }
    const bound = await sendDurableAdopt({
      journal: boundJournal,
      review,
      subjectId,
      intent,
      planned,
      current: null,
    });
    expect(bound.status).toBe('complete');
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toEqual(planned);
    boundJournal.close();

    const unknownPath = join(directory, 'unknown.sqlite');
    const unknownJournal = new ShowcaseJournal(unknownPath);
    for (let generation = 0; generation < 32; generation += 1) {
      const action = adoptKey(showcaseDigest({ intent, generation }));
      unknownJournal.prepareAction(action, otherBody, `unknown-${generation}`);
      unknownJournal.acknowledgeAction(action);
    }
    const unknownCalls: { body: unknown; key: string }[] = [];
    let lose = true;
    const unknownReview = {
      async adoptReviewedCandidates(
        _id: string,
        body: { selection: { candidate: string; rank: string }[] },
        key: string,
      ) {
        unknownCalls.push({ body, key });
        if (lose) {
          lose = false;
          throw new Error('Lost committed adoption');
        }
        return { adoption: { head: unknownCalls.length + 10, selection: body.selection } };
      },
    } as Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>;
    const lost = await sendDurableAdopt({
      journal: unknownJournal,
      review: unknownReview,
      subjectId,
      intent,
      planned,
      current: null,
    });
    expect(lost.status).toBe('interrupted');
    expect(unknownCalls).toHaveLength(1);
    const sealedKey = unknownCalls[0]!.key;
    const sealedBody = unknownCalls[0]!.body;
    unknownJournal.close();

    const reopened = new ShowcaseJournal(unknownPath);
    const starveBody = { ...planned, property: 'schema:keywords', selection: [] as typeof planned.selection };
    for (let index = 0; index < 64; index += 1)
      reopened.prepareAction(`adopt:${index.toString(16).padStart(64, '0')}`, starveBody, `starve-${index}`);
    const recovered = await sendDurableAdopt({
      journal: reopened,
      review: unknownReview,
      subjectId,
      intent,
      planned: { ...planned, expected_head: 99 },
      current: { selection: otherBody.selection },
    });
    expect(recovered.status).toBe('complete');
    expect(unknownCalls).toHaveLength(2);
    expect(unknownCalls[1]?.key).toBe(sealedKey);
    expect(unknownCalls[1]?.body).toEqual(sealedBody);
    reopened.close();
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable adopt recovers identity-bound generation 32 after close, a later recorded window, and another property prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-adopt-unknown-32-'));
  const path = join(directory, 'showcase.sqlite');
  const subjectId = randomUUID();
  const candidate = randomUUID();
  const other = randomUUID();
  const intent = 'manifest-digest';
  const planned = {
    context: globalContext,
    property: 'schema:abstract',
    mode: 'replace' as const,
    expected_head: 1,
    selection: [{ candidate, rank: 'normal' as const }],
  };
  const otherBody = { ...planned, selection: [{ candidate: other, rank: 'preferred' as const }] };
  const identity = `${subjectId}:schema:abstract:${intent}`;
  const adoptKey = (digest: string) => `adopt:${showcaseDigest({ identity: `${subjectId}:schema:abstract`, digest })}`;
  const sealedKey = 'unknown-32';
  let journal = new ShowcaseJournal(path);
  const calls: { body: unknown; key: string }[] = [];
  const review = {
    async adoptReviewedCandidates(
      _id: string,
      body: { selection: { candidate: string; rank: string }[] },
      key: string,
    ) {
      calls.push({ body, key });
      return { adoption: { head: calls.length + 20, selection: body.selection } };
    },
  } as Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>;
  try {
    for (let generation = 0; generation < 32; generation += 1) {
      const action = adoptKey(showcaseDigest({ intent, generation }));
      journal.prepareAction(action, otherBody, `acked-${generation}`);
      journal.acknowledgeAction(action);
    }
    const generation32 = adoptKey(showcaseDigest({ intent, generation: 32 }));
    journal.prepareAction(generation32, planned, sealedKey);
    journal.recordPendingAdopt(identity, generation32);
    journal.advanceAdoptGeneration(identity, 70);
    journal.close();

    journal = new ShowcaseJournal(path);
    const starveBody = { ...planned, property: 'schema:keywords', selection: [] as typeof planned.selection };
    for (let index = 0; index < 64; index += 1)
      journal.prepareAction(`adopt:${index.toString(16).padStart(64, '0')}`, starveBody, `starve-${index}`);
    const recovered = await sendDurableAdopt({
      journal,
      review,
      subjectId,
      intent,
      planned: { ...planned, expected_head: 99 },
      current: { selection: otherBody.selection },
    });
    expect(recovered.status).toBe('complete');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(sealedKey);
    expect(calls[0]?.body).toEqual(planned);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('result-write failure retains its original error and reports only fixed remaining phases', () => {
  const lines: string[] = [];
  const progress = new SeedFinalization('seed', (line) => lines.push(line));
  const failure = new Error('ENOSPC /private/secret-result.json');
  progress.enter('result-write');
  progress.failed(failure);
  expect(lines).toEqual([
    'Cross-media seed finalization state=started scope=seed phase=result-write remaining=result-write',
    'Cross-media seed finalization state=failed scope=seed phase=result-write remaining=result-write',
  ]);
  expect(formatSeedError(failure)).toBe(
    'Cross-media seed failed finalization{scope=seed phase=result-write remaining=result-write}',
  );
  expect(formatSeedError(new Error('phase=result-write secret'))).toBe('Cross-media seed failed');
});
