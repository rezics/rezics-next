import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import { showcaseLimits } from '../src/showcase-contract.ts';
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
import { sourceDigest, vndbPublicTagConceptUri, vndbPublicTagScheme } from '@rezics/conversion/support';
import {
  captureShowcaseCommands,
  publishShowcase,
  replayMissingSelectedProposalCommands,
  resolveLegacyCandidates,
  publishShowcaseVocabulary,
  adoptResumeKeys,
  sendDurableAdopt,
  servedCoverVariants,
  servedVariantDecisionCurrent,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { prepareShowcaseTagParentPublications, prepareShowcaseTags } from '../src/showcase-tags.ts';
import { finalizeSeedResult, formatSeedArtifactHandoff, formatSeedError, SeedFinalization } from '../src/seed-cli.ts';

import { seedVndbPublicationFixture } from './showcase-vndb-publication-fixture.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { seedShowcaseVndbReleases } from '../src/selected-import.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const nativeDataType = (property: string) => bundledRelease.properties[property]!.datatype;
const nativeValueStatement = (
  property: string,
  content: unknown,
  rank: 'normal' | 'preferred' | 'deprecated' = 'normal',
) => ({
  rank,
  property: { id: property },
  value: { type: 'value', content },
});

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
  const graphParentId = randomUUID();
  const graphParentUri = vndbPublicTagConceptUri('cont', 'g106');
  const graphParentBinding = {
    child: 'g105',
    parent: 'g106',
    main: false,
    category: 'cont' as const,
    path: '/tags_parents/g105/g106',
    childId: tagConceptId,
    parentId: graphParentId,
    schemeId: tagSchemeId,
    childUri: tagConceptUri,
    parentUri: graphParentUri,
    schemeUri: tagSchemeUri,
    releaseDigest: bundledDigest,
  };
  const graphParentRefresh = {
    category: 'cont' as const,
    tagId: 'g105',
    childId: tagConceptId,
    schemeId: tagSchemeId,
    childUri: tagConceptUri,
    schemeUri: tagSchemeUri,
    releaseDigest: bundledDigest,
  };
  subjects.set(tagSchemeId, {
    id: tagSchemeId,
    type: 'skos:ConceptScheme',
    sourceExternalId: 'vocabulary:vndb.tag.cont',
    labels: { en: 'cont' },
    statements: { 'schema:url': [nativeValueStatement('schema:url', tagSchemeUri)] },
  });
  subjects.set(tagConceptId, {
    id: tagConceptId,
    type: 'skos:Concept',
    sourceExternalId: 'vocabulary:vndb.tag.cont:g105',
    labels: { und: 'Reviewed tag' },
    statements: {
      'schema:url': [nativeValueStatement('schema:url', tagConceptUri)],
      'skos:inScheme': [nativeValueStatement('skos:inScheme', tagSchemeId)],
    },
  });
  subjects.set(graphParentId, {
    id: graphParentId,
    type: 'skos:Concept',
    sourceExternalId: 'vocabulary:vndb.tag.cont:g106',
    labels: { und: 'Related tag' },
    statements: {
      'schema:url': [nativeValueStatement('schema:url', graphParentUri)],
      'skos:inScheme': [nativeValueStatement('skos:inScheme', tagSchemeId)],
    },
  });
  const bySource = new Map<string, string>();
  const candidateByKey = new Map<string, string>();
  const candidates = new Map<
    string,
    { id: string; source: BatchCommand['source'] | null; statement: BatchStatement; head: number | null }
  >();
  const synopsisDocuments = new Map<string, { document: string; digest: string; language: string }>();
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  type NativeRank = 'normal' | 'preferred' | 'deprecated';
  type AdoptionSelection = { candidate: string; rank: NativeRank }[];
  type AdoptionBody = {
    context: string;
    property: string;
    mode: 'inherit' | 'replace' | 'suppress';
    expected_head: number | null;
    selection: AdoptionSelection;
  };
  const adopted = new Map<string, { head: number; selection: AdoptionSelection }>();
  const adoptionWrites: { subjectId: string; body: AdoptionBody }[] = [];
  const seededAcceptedCandidates = new Set<string>();
  const retainedAbstractCandidates = new Set<string>();
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
    const nativeRow = (property: string, value: unknown) => {
      const row = value as Record<string, unknown>;
      const candidate = [...candidates.values()].find((entry) => entry.statement === value);
      const selectedRank = candidate
        ? adopted.get(`${id}\0${property}`)?.selection.find((entry) => entry.candidate === candidate.id)?.rank
        : undefined;
      return {
        ...row,
        id: candidate?.id ?? row.id,
        rank: selectedRank ?? row.rank ?? 'normal',
        property: row.property ?? { id: property },
      };
    };
    const statements = Object.fromEntries(
      Object.entries(subject.statements).map(([property, rows]) => [
        property,
        rows.map((row) => nativeRow(property, row)).filter((row) => typeof row.id !== 'string' || !rejected.has(row.id)),
      ]),
    );
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
            ...statements,
            ...(identity ? { [property]: [nativeRow(property, identity.statement)] } : {}),
          },
        },
      } as unknown as ReviewedSubjectRead;
    }
    const identity = /^(?:(person|character):)?([0-9]+)$/u.exec(subject.sourceExternalId);
    if (!identity) return { subject: { ...subject, statements } } as unknown as ReviewedSubjectRead;
    const property = identity[1] === 'person' ? 'wdt:P6298' : identity[1] === 'character' ? 'wdt:P6296' : 'wdt:P5732';
    return {
      subject: {
        ...subject,
        statements: {
          ...statements,
          [property]: [
            {
              rank: 'normal',
              property: { id: property },
              id: [...candidates.values()].find(
                (candidate) =>
                  candidate.statement.property.id === property &&
                  candidate.source?.external_id === subject.sourceExternalId,
              )?.id,
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
          const id = candidateByKey.get(command.key) ?? randomUUID();
          candidateByKey.set(command.key, id);
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
    const parentPublication = await prepareShowcaseTagParentPublications({
      evidence: [graphParentBinding],
      port: captureShowcaseCommands(port, journal),
      journal,
    });
    expect(parentPublication.gaps).toEqual([]);
    expect(parentPublication.acknowledgements).toHaveLength(1);
    const graphParentCandidateId = parentPublication.acknowledgements[0]!.candidateId!;
    const graphParentCandidate = candidates.get(graphParentCandidateId)!;
    const staleAcceptanceHeads = new Map<string, number>([[graphParentCandidateId, 409]]);
    const graphUnrelatedId = randomUUID();
    const graphUnrelatedParentId = randomUUID();
    const graphParentStatement = graphParentCandidate.statement;
    if (graphParentStatement.value.type !== 'value') throw new Error('Graph parent fixture requires a value');
    const graphUnrelatedStatement: BatchStatement = {
      ...graphParentStatement,
      value: { ...graphParentStatement.value, content: graphUnrelatedParentId },
    };
    subjects.set(graphUnrelatedParentId, {
      id: graphUnrelatedParentId,
      type: 'skos:Concept',
      sourceExternalId: 'manual:unrelated-parent',
      labels: { en: 'Unrelated parent' },
      statements: {
        'schema:url': [nativeValueStatement('schema:url', 'https://fixture.test/unrelated-parent')],
        'skos:inScheme': [nativeValueStatement('skos:inScheme', tagSchemeId)],
      },
    });
    candidates.set(graphUnrelatedId, {
      id: graphUnrelatedId,
      source: null,
      statement: graphUnrelatedStatement,
      head: null,
    });
    rejected.add(graphUnrelatedId);
    seededAcceptedCandidates.add(graphParentCandidateId);
    const retainedGraphSelection: AdoptionSelection = (['normal', 'preferred'] as const).map((rank) => {
      const id = randomUUID();
      candidates.set(id, {
        id,
        source: null,
        statement: {
          ...graphUnrelatedStatement,
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: `https://fixture.test/parent/${rank}` },
                },
              ],
            },
          ],
        },
        head: null,
      });
      accepted.add(id);
      seededAcceptedCandidates.add(id);
      return { candidate: id, rank };
    });
    adopted.set(`${tagConceptId}\0skos:broader`, {
      head: 2,
      selection: retainedGraphSelection,
    });
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
                (candidate.id === unrelatedId && id === workId && query.property === 'schema:name') ||
                (retainedAbstractCandidates.has(candidate.id) &&
                  id === workId &&
                  query.property === 'schema:abstract') ||
                ((candidate.id === graphUnrelatedId ||
                  retainedGraphSelection.some((item) => item.candidate === candidate.id)) &&
                  id === tagConceptId &&
                  query.property === 'skos:broader') ||
                (candidate.source?.external_id === graphParentBinding.path &&
                  id === tagConceptId &&
                  query.property === 'skos:broader'),
            )
            .map((candidate) => ({
              ...candidate,
              decision: rejected.has(candidate.id) ? 'rejected' : accepted.has(candidate.id) ? 'accepted' : null,
              rank: rejected.has(candidate.id)
                ? 'deprecated'
                : (adoption?.selection.find((selection) => selection.candidate === candidate.id)?.rank ?? null),
            }))
            .concat([{ id: randomUUID(), deleted: true }] as never),
          next: null,
          adoption: adoption ? { head: adoption.head, mode: 'replace' } : null,
        } as never;
      },
      async acceptReviewedCandidate(_id, candidateId, body, idempotencyKey) {
        acceptanceCalls.push({ candidateId, body, idempotencyKey });
        const staleStatus = staleAcceptanceHeads.get(candidateId);
        if (staleStatus) {
          staleAcceptanceHeads.delete(candidateId);
          candidates.get(candidateId)!.head = (candidates.get(candidateId)!.head ?? 0) + 1;
          throw Object.assign(new Error('Concurrent candidate review'), { status: staleStatus });
        }
        if (refuseAcceptance && candidateId !== graphParentCandidateId) {
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
          expected_head: number | null;
          selection: AdoptionSelection;
        };
        adoptionWrites.push({ subjectId: id, body: structuredClone(action) });
        if (action.selection.some((item) => item.rank === 'deprecated' || rejected.has(item.candidate)))
          throw Object.assign(new Error('Unsupported adoption selection'), { status: 422 });
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
          const rowId = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined;
          const candidate = typeof rowId === 'string' ? candidates.get(rowId) : undefined;
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
    const recoveryExisting = journal.acknowledgedCommands();
    const recoveryInput = { plan, result, aliases: crossMediaAliases, existing: recoveryExisting };
    expect(
      await resolveLegacyCandidates({
        ...recoveryInput,
        review: {
          reviewedCandidates: async () => {
            throw new Error('scoped receipts must not enter legacy recovery');
          },
        },
      }),
    ).toEqual({ acknowledgements: recoveryExisting, omissions: [] });
    const target = recoveryExisting.find(
      (ack) => ack.command.op === 'propose' && ack.command.statement.property.id === 'schema:abstract',
    )!;
    if (target.command.op !== 'propose') throw new Error('Missing synopsis proposal');
    const recoveryReceipts = recoveryExisting.filter((ack) => ack !== target);
    for (const mode of ['exact', 'missing', 'ambiguous', 'source', 'statement', 'partial'] as const) {
      const candidate = {
        id: target.candidateId!,
        source: target.command.source,
        statement: target.command.statement,
        head: null,
        rank: null,
      };
      if (mode === 'source') candidate.source = { ...candidate.source, field_group: 'facts' };
      if (mode === 'statement') candidate.statement = { ...candidate.statement, references: [] };
      const rows =
        mode === 'missing' ? [] : mode === 'ambiguous' ? [candidate, { ...candidate, id: randomUUID() }] : [candidate];
      let page = 0;
      const recovered = await resolveLegacyCandidates({
        ...recoveryInput,
        existing: recoveryReceipts,
        review: {
          reviewedCandidates: async (_id, query) =>
            ({
              candidates: query.cursor ? [] : rows,
              adoption: null,
              next: mode === 'partial' ? String(page++) : null,
            }) as never,
        },
      });
      expect(recovered.omissions.length, mode).toBe(mode === 'exact' ? 0 : 1);
      expect(recovered.acknowledgements.length, mode).toBe(recoveryReceipts.length + (mode === 'exact' ? 1 : 0));
    }
    let tagOptions = {
      tagAssociations: preparedTags.associationBindings,
      tagAssociationRefreshes: preparedTags.associationRefreshes,
      tagWeightObservations: preparedTags.tagWeightObservations,
      tagWeightRefreshes: preparedTags.tagWeightRefreshes,
      tagParentEvidence: [graphParentBinding],
      tagParentAcknowledgements: parentPublication.acknowledgements,
      tagParentRefreshes: [graphParentRefresh],
    };
    // A fresh public reader can see the native Subject before its source identifier is adopted.
    // Publication must recover that exact original create target without rewriting seed identity evidence.
    const firstInput = { ...result, readings: result.readings.filter((reading) => reading.externalId !== '101') };
    const subjectReads = spyOn(review, 'readReviewedSubject');
    const pageReads = spyOn(review, 'reviewedCandidates');
    const fenceReads = spyOn(review, 'fence');
    const readCounts = () => ({
      subjects: subjectReads.mock.calls.length,
      pages: pageReads.mock.calls.length,
      fences: fenceReads.mock.calls.length,
    });
    const tracePrefix = 'Cross-media final showcase manifest ';
    const trace: Record<string, number | string>[] = [];
    let validationStart = readCounts();
    let validationEnd = validationStart;
    const first = await publishShowcase({
      plan,
      result: firstInput,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      traceFinalManifest: true,
      onProgress(line) {
        if (line.includes('phase=manifest-validation')) validationStart = readCounts();
        if (line.includes('phase=acceptance')) validationEnd = readCounts();
        if (line.startsWith(tracePrefix)) trace.push(JSON.parse(line.slice(tracePrefix.length)));
      },
      ...tagOptions,
    });
    const milestones = trace.filter(({ phase }) => phase === 'assertions');
    expect(milestones.map(({ state }) => state)).toEqual(['started', 25, 50, 75, 'completed']);
    const finished = milestones.at(-1)!;
    expect(milestones.map(({ completed }) => completed)).toEqual(
      [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.ceil(fraction * Number(finished.total))),
    );
    const elapsed = trace.map(({ elapsedMs }) => Number(elapsedMs));
    expect(elapsed).toEqual(elapsed.toSorted((a, b) => a - b));
    const validationSubjects = subjectReads.mock.calls.slice(validationStart.subjects, validationEnd.subjects);
    const validationFences = fenceReads.mock.calls.slice(validationStart.fences, validationEnd.fences);
    expect(finished.subjects).toBe(new Set(validationSubjects.map(([id]) => id)).size);
    expect(finished.subjects).toBe(validationSubjects.length);
    expect(finished.candidatePages).toBe(validationEnd.pages - validationStart.pages);
    expect(finished.candidateListingMisses).toBe(finished.candidatePages);
    expect(finished.factsFences).toBe(validationFences.filter(([query]) => query.fieldGroup === 'facts').length);
    expect(finished.coverFences).toBe(validationFences.filter(([query]) => query.fieldGroup === 'cover').length);
    expect(finished.localMs).toBeGreaterThanOrEqual(0);
    expect(trace.filter(({ state }) => state === 'completed').map(({ phase }) => phase)).toEqual([
      'initial-build',
      'validation-setup',
      'bindings',
      'assertions',
      'validated-build',
      'validated-seal',
      'membership-build',
      'membership-seal',
      'final-build',
      'final-seal',
    ]);
    expect(subjectReads.mock.calls.length).toBeGreaterThan(validationEnd.subjects);
    expect(pageReads.mock.calls.length).toBeGreaterThan(validationEnd.pages);
    expect(fenceReads.mock.calls.length).toBeGreaterThan(validationEnd.fences);
    subjectReads.mockRestore();
    pageReads.mockRestore();
    fenceReads.mockRestore();
    expect(first.status).toBe('incomplete');
    expect(first.manifest.records.find((record) => record.sourceKey === '101')?.subjectId).toBe(workId);
    expect(firstInput.readings.some((reading) => reading.externalId === '101')).toBe(false);
    const acknowledged = journal.acknowledgedCommands().filter((entry) => entry.candidateId);
    expect(acknowledged.length).toBeGreaterThan(0);
    expect(accepted).toEqual(seededAcceptedCandidates);
    const graphReplacement = adoptionWrites.find(
      (write) => write.subjectId === tagConceptId && write.body.property === 'skos:broader',
    );
    const expectedGraphSelection: AdoptionSelection = [
      ...retainedGraphSelection,
      { candidate: graphParentCandidateId, rank: 'normal' as const },
    ].sort((left, right) => left.candidate.localeCompare(right.candidate));
    expect(graphReplacement?.body).toEqual({
      context: globalContext,
      property: 'skos:broader',
      mode: 'replace',
      expected_head: 2,
      selection: expectedGraphSelection,
    });
    expect(adopted.get(`${tagConceptId}\0skos:broader`)?.selection).toEqual(expectedGraphSelection);
    expect(subjects.get(tagConceptId)!.statements['skos:broader']).toEqual(
      expectedGraphSelection.map(({ candidate }) => candidates.get(candidate)!.statement),
    );
    const parentAcceptances = acceptanceCalls.filter((call) => call.candidateId === graphParentCandidateId);
    expect(parentAcceptances.map((call) => call.body)).toEqual([
      { context: globalContext, expected_head: null },
      { context: globalContext, expected_head: 1 },
    ]);
    expect(parentAcceptances[1]!.idempotencyKey).not.toBe(parentAcceptances[0]!.idempotencyKey);
    const parentAssertion = first.manifest.vocabulary
      .flatMap((record) => record.assertions)
      .find((assertion) => assertion.candidateId === graphParentCandidateId)!;
    const parentAction = `accept:${showcaseDigest({ identity: graphParentCandidateId, digest: parentAssertion.candidateDigest })}`;
    expect(journal.action(parentAction)?.state).toBe('acknowledged');
    expect(journal.actionDecisions(parentAction)).toEqual([
      {
        decision: 'changed-body',
        refusal: 'review-http-409',
        priorIdempotencyKey: parentAcceptances[0]!.idempotencyKey,
        idempotencyKey: parentAcceptances[1]!.idempotencyKey,
      },
    ]);
    expect(publicReads.get(tagConceptId)?.subject?.statements?.['skos:broader']).toEqual(
      expect.arrayContaining(
        expectedGraphSelection.map(({ candidate, rank }) => expect.objectContaining({ id: candidate, rank })),
      ),
    );
    const graphReadback = await review.reviewedCandidates(tagConceptId, {
      context: globalContext,
      property: 'skos:broader',
      limit: showcaseLimits.reviewPage,
    });
    expect(graphReadback.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: graphParentCandidateId, rank: 'normal' }),
        expect.objectContaining({ id: graphUnrelatedId, rank: 'deprecated' }),
      ]),
    );
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
    const preparedReplayPath = join(directory, 'prepared-proposal.sqlite');
    const preparedReplayJournal = new ShowcaseJournal(preparedReplayPath);
    preparedReplayJournal.prepareCommand(interruptedSynopsisProposal.command);
    const preparedReplayCalls: BatchCommand[] = [];
    try {
      const preparedReplayTransport = {
        ...port,
        async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
          preparedReplayCalls.push(...request.commands);
          return port.batch({ commands: [...request.commands] });
        },
      } as CrossMediaPort;
      const resumedPrepared = await replayMissingSelectedProposalCommands({
        plan,
        aliases: crossMediaAliases,
        journal: preparedReplayJournal,
        review,
        transport: preparedReplayTransport,
      });
      expect(resumedPrepared).toEqual([interruptedSynopsisProposal.command]);
      expect(preparedReplayCalls).toEqual([interruptedSynopsisProposal.command]);
      expect(preparedReplayJournal.preparedCommands()).toEqual([]);
      expect(preparedReplayJournal.acknowledgedCommands()).toContainEqual(
        expect.objectContaining({
          command: interruptedSynopsisProposal.command,
          candidateId: interruptedSynopsis.id,
        }),
      );
    } finally {
      preparedReplayJournal.close();
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
    const sourceSynopsis = synopses.find((candidate) => candidate.source?.external_id === '101')!;
    const rejectedAbstractId = randomUUID();
    const retainedAbstractSelection: AdoptionSelection = [
      { candidate: randomUUID(), rank: 'normal' },
      { candidate: randomUUID(), rank: 'preferred' },
    ];
    for (const selection of [...retainedAbstractSelection, { candidate: rejectedAbstractId, rank: 'deprecated' }]) {
      const statement: BatchStatement = {
        ...sourceSynopsis.statement,
        value: {
          type: 'value',
          content: {
            language: 'en',
            document: { type: 'text', value: `Previously reviewed ${selection.rank} synopsis` },
          },
        },
        references: [],
      };
      candidates.set(selection.candidate, {
        id: selection.candidate,
        source: null,
        statement,
        head: null,
      });
      if (selection.rank === 'deprecated') rejected.add(selection.candidate);
      else {
        accepted.add(selection.candidate);
        seededAcceptedCandidates.add(selection.candidate);
      }
      retainedAbstractCandidates.add(selection.candidate);
    }
    adopted.set(`${workId}\0schema:abstract`, { head: 1, selection: retainedAbstractSelection });
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
    candidates.delete(membershipCandidateId);
    candidates.delete(interruptedSynopsis.id);
    staleAcceptanceHeads.set(membershipCandidateId, 412);
    const resumedAcknowledgedCalls: BatchCommand[] = [];
    const resumedAcknowledgedTransport = {
      ...port,
      async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
        resumedAcknowledgedCalls.push(...request.commands);
        return port.batch({ commands: [...request.commands] });
      },
    } as CrossMediaPort;
    const replayed = await publishShowcase({
      onProgress: (line) => publicationPhases.push(line),
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      transport: resumedAcknowledgedTransport,
      publicClient,
      ...tagOptions,
    });
    expect(resumedAcknowledgedCalls).toContainEqual(interruptedSynopsisProposal.command);
    expect(resumedAcknowledgedCalls).toContainEqual(membership.command);
    expect(candidates.has(interruptedSynopsis.id)).toBe(true);
    expect(candidates.has(membershipCandidateId)).toBe(true);
    const dependencyOnly = replayed.manifest.vocabulary.filter(
      (record) => record.provenance === 'source-parent-binding' && record.assertions.length === 0,
    );
    expect(dependencyOnly.map(({ subjectId }) => subjectId).sort()).toEqual(
      [graphParentBinding.parentId, graphParentBinding.schemeId].sort(),
    );
    expect(
      replayed.published.some(({ subjectId }) => dependencyOnly.some((record) => record.subjectId === subjectId)),
    ).toBe(false);
    expect(
      replayed.status,
      JSON.stringify({
        omissions: replayed.omissions.map(({ code }) => code),
        published: replayed.published.length,
        expected: replayed.manifest.records.length + replayed.manifest.vocabulary.length - dependencyOnly.length,
      }),
    ).toBe('published');
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
    const expectedAbstractSelection: AdoptionSelection = [
      ...retainedAbstractSelection,
      { candidate: sourceSynopsis.id, rank: 'normal' as const },
    ].sort((left, right) => left.candidate.localeCompare(right.candidate));
    const abstractReplacement = adoptionWrites.find(
      (write) => write.subjectId === workId && write.body.property === 'schema:abstract',
    );
    expect(abstractReplacement?.body).toEqual({
      context: globalContext,
      property: 'schema:abstract',
      mode: 'replace',
      expected_head: 1,
      selection: expectedAbstractSelection,
    });
    const abstractReadback = await review.reviewedCandidates(workId, {
      context: globalContext,
      property: 'schema:abstract',
      limit: showcaseLimits.reviewPage,
    });
    expect(abstractReadback.candidates).toEqual(
      expect.arrayContaining(
        expectedAbstractSelection.map((selection) =>
          expect.objectContaining({ id: selection.candidate, rank: selection.rank }),
        ),
      ),
    );
    expect(abstractReadback.candidates).toContainEqual(
      expect.objectContaining({ id: rejectedAbstractId, decision: 'rejected', rank: 'deprecated' }),
    );
    expect(acceptanceCalls.some((call) => rejected.has(call.candidateId))).toBe(false);
    expect(adoptionWrites.flatMap((write) => write.body.selection).some((item) => rejected.has(item.candidate))).toBe(
      false,
    );
    expect(accepted).toEqual(
      new Set([...acknowledged.map((entry) => entry.candidateId!), ...seededAcceptedCandidates]),
    );
    expect(
      replayed.published
        .find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')
        ?.assertions.some((assertion) => assertion.property === 'schema:abstract'),
    ).toBe(false);
    for (const candidate of synopses) {
      const subject = [...subjects.values()].find((item) => item.sourceExternalId === candidate.source?.external_id)!;
      expect(accepted.has(candidate.id)).toBe(true);
      const currentSelection = adopted.get(`${subject.id}\0schema:abstract`)!.selection;
      expect(currentSelection).toEqual(
        subject.id === workId
          ? [...retainedAbstractSelection, { candidate: candidate.id, rank: 'normal' as const }].sort((left, right) =>
              left.candidate.localeCompare(right.candidate),
            )
          : [{ candidate: candidate.id, rank: 'normal' }],
      );
      expect(subject.statements['schema:abstract']).toEqual(
        currentSelection.map(({ candidate: selectedCandidate }) => candidates.get(selectedCandidate)!.statement),
      );
      expect(publicReadIds.has(subject.id)).toBe(true);
      const publicAbstractRows = publicReads.get(subject.id)?.subject?.statements?.['schema:abstract'];
      expect(publicAbstractRows).toContainEqual(
        expect.objectContaining({
          id: candidate.id,
          rank: 'normal',
          value: { type: 'value', content: synopsisDocuments.get(candidate.id) },
        }),
      );
      if (subject.id === workId)
        for (const retained of retainedAbstractSelection)
          expect(publicAbstractRows).toContainEqual(
            expect.objectContaining({ id: retained.candidate, rank: retained.rank }),
          );
      const publishedSynopsis = replayed.published
        .find((record) => record.provider === 'bangumi' && record.sourceKey === candidate.source?.external_id)
        ?.assertions.find((assertion) => assertion.candidateId === candidate.id);
      expect(publishedSynopsis).toMatchObject({
        candidateId: candidate.id,
        property: 'schema:abstract',
        citations: [`https://bgm.tv/subject/${candidate.source?.external_id}`],
        adoption: { head: subject.id === workId ? 2 : 1, candidateId: candidate.id, rank: 'normal' },
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
    expect(tagAcceptanceCalls.length - tagAcceptanceCallsBeforeReplay).toBe(2);
    const sealedMembershipAcceptance = tagAcceptanceCalls[0]!;
    expect(tagAcceptanceCalls[tagAcceptanceCallsBeforeReplay]).toEqual(sealedMembershipAcceptance);
    expect(tagAcceptanceCalls.at(-1)?.body).toEqual({ context: globalContext, expected_head: 1 });
    expect(tagAcceptanceCalls.at(-1)?.idempotencyKey).not.toBe(sealedMembershipAcceptance.idempotencyKey);
    const publishedMembership = replayed.published
      .find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')
      ?.assertions.find((assertion) => assertion.candidateId === membershipCandidateId);
    const manifestMembership = replayed.manifest.records
      .find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')
      ?.assertions.find((assertion) => assertion.candidateId === membershipCandidateId);
    expect(manifestMembership).toMatchObject({
      source: { source: crossMediaAliases.vndb, external_id: 'v2' },
      citations: ['https://vndb.org/v2.1#/tags_vn/v2/g105/tag'],
    });
    expect(publishedMembership).toMatchObject({
      candidateId: membershipCandidateId,
      property: 'schema:genre',
      citations: ['https://vndb.org/v2.1#/tags_vn/v2/g105/tag'],
      adoption: { candidateId: membershipCandidateId, rank: 'normal' },
      readback: {
        property: { id: 'schema:genre' },
        value: { type: 'value', content: tagConceptId },
      },
    });
    expect(publicReads.get(membership.command.subject)?.subject?.statements?.['schema:genre']).toContainEqual(
      expect.objectContaining({ value: { type: 'value', content: tagConceptId } }),
    );

    // A later rejection keeps the acknowledged proposal reviewable without selecting it again.
    rejected.add(membershipCandidateId);
    accepted.delete(membershipCandidateId);
    const beforeRejectedRefresh = adoptionWrites.length;
    const rejectedRefresh = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(rejectedRefresh.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v2',
      code: 'candidate-currently-rejected',
    });
    expect(adoptionWrites.slice(beforeRejectedRefresh).flatMap((write) => write.body.selection)).not.toContainEqual(
      expect.objectContaining({ candidate: membershipCandidateId }),
    );
    expect(adopted.get(`${membership.command.subject}\0schema:genre`)?.selection).toContainEqual(
      expect.objectContaining({ candidate: membershipCandidateId }),
    );
    expect(publicReads.get(membership.command.subject)?.subject?.statements?.['schema:genre'] ?? []).not.toContainEqual(
      expect.objectContaining({ id: membershipCandidateId }),
    );
    const rejectedMembershipPage = await review.reviewedCandidates(membership.command.subject, {
      context: globalContext,
      property: 'schema:genre',
      limit: showcaseLimits.reviewPage,
    });
    expect(rejectedMembershipPage.candidates).toContainEqual(
      expect.objectContaining({ id: membershipCandidateId, decision: 'rejected', rank: 'deprecated' }),
    );
    rejected.delete(membershipCandidateId);
    accepted.add(membershipCandidateId);

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
      result: {
        ...result,
        status: 'imported-with-gaps',
        gaps: [
          ...result.gaps,
          {
            source: 'vndb',
            fields: ['vn_extlinks.site'],
            record: { id: 'v1' },
            reason: 'Unsupported external link site; retained as source metadata only',
          },
        ],
        vndbCreditDiagnostics: [
          {
            provider: 'vndb',
            path: '/chars/bloodt',
            code: 'unknown',
            reason: 'invalid_row',
            property: 'chars.bloodt',
          },
        ],
        mediaOutcomes: [
          ...result.mediaOutcomes,
          {
            sourceAlias: crossMediaAliases.bangumi,
            externalId: '101',
            sourceRevision: 'unversioned',
            archiveDigest: sourceDigest(plan.records.bangumi.find((row) => row.key === '101')!.payload),
            endpoint: 'https://api.bgm.tv/v0/subjects/101',
            sourceStatus: 'absent',
            status: 'absent',
            containerId: workId,
          },
        ],
      },
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(recoveredCurrentSynopsis.status).toBe('published');
    expect(recoveredCurrentSynopsis.omissions).toContainEqual({
      provider: 'bangumi',
      sourceKey: '101',
      code: 'cover-source-absent',
    });
    expect(
      recoveredCurrentSynopsis.published.some((record) => record.provider === 'bangumi' && record.sourceKey === '101'),
    ).toBe(true);

    for (const reason of ['property_not_admitted', 'invalid_row'] as const) {
      const missingRequiredProperty = await publishShowcase({
        plan,
        result: {
          ...result,
          characterDiagnostics: [
            {
              provider: 'bangumi',
              path: '/subject/101/summary',
              endpoint: '101',
              reason,
              property: 'schema:abstract',
              requiredProfile: 'schema:TVSeries',
            },
          ],
        },
        aliases: crossMediaAliases,
        journal,
        review,
        publicClient,
        ...tagOptions,
      });
      expect(missingRequiredProperty.published.some((record) => record.sourceKey === '101')).toBe(true);
      expect(missingRequiredProperty.status).toBe('incomplete');
      expect(missingRequiredProperty.omissions).toContainEqual({
        provider: 'bangumi',
        sourceKey: '101',
        code: 'source-claim-withheld',
      });
    }

    const missingRequiredBinding = await publishShowcase({
      plan,
      result: {
        ...result,
        characterDiagnostics: [
          {
            provider: 'bangumi',
            path: '/subject-characters/0/type',
            code: '1',
            reason: 'missing_scheme',
            property: 'skos:ConceptScheme',
          },
        ],
      },
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(missingRequiredBinding.status).toBe('incomplete');
    expect(missingRequiredBinding.omissions).toContainEqual({
      provider: 'bangumi',
      sourceKey: 'selected-family',
      code: 'source-claim-withheld',
    });

    const reopenedSynopsis = synopses.find((candidate) => candidate.source?.external_id === '101')!;
    const reopenedSubject = [...subjects.values()].find(
      (item) => item.sourceExternalId === reopenedSynopsis.source?.external_id,
    )!;
    adopted.set(`${reopenedSubject.id}\0schema:abstract`, { head: 3, selection: [] });
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
      adoption: { head: 4, candidateId: reopenedSynopsis.id, rank: 'normal' },
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
    unavailableReviewSubjects.add(tagConceptId);
    const unavailableBinding = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(unavailableBinding.status).toBe('incomplete');
    expect(unavailableBinding.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v2',
      code: 'public-view-unavailable',
    });
    expect(subjects.get(membership.command.subject)!.statements['schema:genre']).toContainEqual(
      membership.command.statement,
    );
    expect(
      unavailableBinding.published.find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')
        ?.assertions,
    ).not.toContainEqual(expect.objectContaining({ property: 'schema:genre' }));

    unavailableReviewSubjects.delete(tagConceptId);
    subjects.get(tagConceptId)!.statements['skos:inScheme'] = [
      nativeValueStatement('skos:inScheme', tagSchemeId, 'deprecated'),
    ];
    unavailableReviewSubjects.add(vndbTargetId);
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
    expect(
      withdrawn.published.find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')?.assertions,
    ).toContainEqual(expect.objectContaining({ property: 'schema:name' }));
    expect(withdrawn.omissions).toContainEqual({
      provider: 'vndb',
      sourceKey: 'v2',
      code: 'vocabulary-binding-missing',
    });

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    unavailableReviewSubjects.delete(vndbTargetId);
    subjects.get(tagConceptId)!.statements['skos:inScheme'] = [
      nativeValueStatement('skos:inScheme', tagSchemeId, 'deprecated'),
      nativeValueStatement('skos:inScheme', tagSchemeId, 'preferred'),
    ];
    publicReadIds.clear();
    const restoredBinding = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      ...tagOptions,
    });
    expect(restoredBinding.status).toBe('published');
    expect(subjects.get(membership.command.subject)!.statements['schema:genre']).toContainEqual(
      membership.command.statement,
    );
    expect(
      restoredBinding.published.find((record) => record.provider === 'vndb' && record.sourceKey === 'v2')?.assertions,
    ).toContainEqual(expect.objectContaining({ candidateId: membershipCandidateId, property: 'schema:genre' }));
    const withheldSource = withdrawn.published.find(
      (record) => record.provider === 'vndb' && record.sourceKey === 'r1',
    );
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:name')).toBe(true);
    expect(withheldSource?.assertions.some((assertion) => assertion.property === 'schema:exampleOfWork')).toBe(false);
    const withheldTagWork = withdrawn.published.find(
      (record) => record.provider === 'vndb' && record.sourceKey === 'v2',
    );
    expect(withheldTagWork?.assertions.some((assertion) => assertion.property === 'schema:genre')).toBe(false);
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
      tagParentEvidence: [graphParentBinding],
      tagParentAcknowledgements: parentPublication.acknowledgements,
      tagParentRefreshes: [graphParentRefresh],
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
    expect(resumed.published.map((record) => record.subjectId).sort()).toEqual(
      [...new Set([...workIds, tagConceptId])].sort(),
    );
    expect(accepted).toEqual(
      new Set([
        ...journal
          .acknowledgedCommands()
          .filter((entry) => entry.candidateId)
          .map((entry) => entry.candidateId!),
        ...seededAcceptedCandidates,
      ]),
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
    const stageProgress: string[] = [];
    const stage = (selected: ShowcaseVocabularyRequirement[]) =>
      publishShowcaseVocabulary({
        plan,
        result: initialResult,
        aliases: crossMediaAliases,
        journal,
        review,
        publicClient,
        vocabularyRequirements: selected,
        onProgress(line) {
          stageProgress.push(line);
        },
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
      expect(stageProgress.some((line) => line.startsWith(tracePrefix))).toBe(false);
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

for (const siblingDecision of ['accepted', 'undecided'] as const) {
  test(`publication retains an ${siblingDecision} sibling beside unresolved acceptance through reopen`, async () => {
    const temporary = join(import.meta.dir, '../../../.temp');
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(join(temporary, 'showcase-accepted-siblings-'));
    const journalPath = join(directory, 'showcase.sqlite');
    let journal = new ShowcaseJournal(journalPath);
    const subjectId = randomUUID();
    let nativeType = '';
    let labels: Record<string, string> = {};
    const candidates = new Map<
      string,
      { id: string; source: BatchCommand['source'] | null; statement: BatchStatement; head: number | null }
    >();
    const candidateByKey = new Map<string, string>();
    const accepted = new Set<string>();
    type Selection = { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
    const adopted = new Map<string, { head: number; selection: Selection }>();
    const read = () =>
      ({
        subject: {
          id: subjectId,
          type: nativeType,
          labels,
          statements: Object.fromEntries(
            [...adopted].map(([property, adoption]) => [
              property,
              adoption.selection.map(({ candidate, rank }) => ({
                ...candidates.get(candidate)!.statement,
                id: candidate,
                rank,
              })),
            ]),
          ),
        },
      });
    const metadata = sourceRecordMetadataFixture();
    const port = {
      async batch(request: { commands: readonly BatchCommand[] }): Promise<BatchWriteResult> {
        return {
          results: request.commands.map((command) => {
            if (command.op === 'create') {
              nativeType = command.subject.type;
              labels = command.subject.labels;
              return { key: command.key, status: 201 as const, value: { id: subjectId, revision: 1 } };
            }
            if (command.op === 'propose') {
              const id = candidateByKey.get(command.key) ?? randomUUID();
              candidateByKey.set(command.key, id);
              candidates.set(id, { id, source: command.source, statement: command.statement, head: null });
              // The record already has an independently accepted, current source identifier.
              if (command.statement.property.id === 'wdt:P3180') {
                accepted.add(id);
                adopted.set('wdt:P3180', { head: 1, selection: [{ candidate: id, rank: 'normal' }] });
              }
              return { key: command.key, status: 201 as const, value: { candidate: id, revision: 1 } };
            }
            return { key: command.key, status: 200 as const, value: { revision: 1 } };
          }),
        };
      },
      async readReviewedSubject() {
        return read();
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
    try {
      const { plan, result } = await seedVndbPublicationFixture(
        join(directory, 'import.sqlite'),
        captureShowcaseCommands(port, journal),
      );
      expect(plan.records.vndb.map((record) => record.key)).toEqual(['v1']);
      const names = [...candidates.values()]
        .filter((candidate) => candidate.statement.property.id === 'schema:name')
        .sort((left, right) => left.id.localeCompare(right.id));
      expect(names).toHaveLength(2);
      // The unresolved candidate runs first, including when its sibling still needs acceptance.
      const unresolved = names[0]!;
      const sibling = names[1]!;
      for (const candidate of candidates.values())
        if (candidate.id !== unresolved.id && (candidate.id !== sibling.id || siblingDecision === 'accepted'))
          accepted.add(candidate.id);
      const editorialId = randomUUID();
      candidates.set(editorialId, {
        id: editorialId,
        source: null,
        statement: {
          ...sibling.statement,
          value: { type: 'value', content: { language: 'en', text: 'Editorial title' } },
        },
        head: 1,
      });
      accepted.add(editorialId);
      adopted.set('schema:name', { head: 7, selection: [{ candidate: editorialId, rank: 'preferred' }] });
      const acknowledged = journal.acknowledgedCommands();
      const acceptanceCalls: { candidateId: string; body: unknown; idempotencyKey: string }[] = [];
      const adoptionWrites: Parameters<ShowcaseReviewPort['adoptReviewedCandidates']>[1][] = [];
      const publicReads: ReturnType<typeof read>[] = [];
      let unavailableCandidateId: string | null = unresolved.id;
      const review: ShowcaseReviewPort = {
        fence: port.fence,
        readReviewedSubject: port.readReviewedSubject,
        async reviewedCandidates(id, query) {
          expect(id).toBe(subjectId);
          expect(query.context).toBe(globalContext);
          const property = query.property;
          if (!property) throw new Error('Publication fixture requires a property');
          const adoption = adopted.get(property);
          const rows = [...candidates.values()].filter((candidate) => candidate.statement.property.id === property);
          const paginated = property === 'schema:name';
          const page = paginated
            ? rows.filter((candidate) => (query.cursor ? candidate.id === editorialId : candidate.id !== editorialId))
            : rows;
          return {
            candidates: page.map((candidate) => ({
              ...candidate,
              decision: accepted.has(candidate.id) ? 'accepted' : null,
              rank: adoption?.selection.find((item) => item.candidate === candidate.id)?.rank ?? null,
            })),
            next: paginated && !query.cursor ? 'editorial' : null,
            adoption: adoption ? { mode: 'replace', head: adoption.head } : null,
          } as never;
        },
        async acceptReviewedCandidate(id, candidateId, body, idempotencyKey) {
          expect(id).toBe(subjectId);
          expect(body).toEqual({ context: globalContext, expected_head: candidates.get(candidateId)!.head });
          acceptanceCalls.push({ candidateId, body: structuredClone(body), idempotencyKey });
          if (candidateId === unavailableCandidateId)
            throw Object.assign(new Error('Acceptance unavailable'), { status: 503 });
          accepted.add(candidateId);
          candidates.get(candidateId)!.head = 1;
          return {
            acceptance: { context: body.context, candidate: candidateId, decision: 'accept', head: 1 },
            revision: 1,
          };
        },
        async adoptReviewedCandidates(id, body) {
          expect(id).toBe(subjectId);
          expect(body.context).toBe(globalContext);
          expect(body.mode).toBe('replace');
          expect(body.expected_head).toBe(adopted.get(body.property)?.head ?? null);
          for (const item of body.selection) {
            expect(accepted.has(item.candidate)).toBe(true);
            expect(item.rank).not.toBe('deprecated');
          }
          adoptionWrites.push(structuredClone(body));
          const current = { head: (body.expected_head ?? 0) + 1, selection: body.selection };
          adopted.set(body.property, current);
          return { adoption: { ...body, head: current.head }, revision: 1 };
        },
      };
      const publicClient = createPublicBulkClient({
        origin: 'https://fixture.test',
        fetch: (async (input) => {
          expect(new URL(String(input)).pathname.split('/').at(-1)).toBe(subjectId);
          const current = read();
          publicReads.push(structuredClone(current));
          return Response.json(current);
        }) as typeof fetch,
      });
      const publish = () =>
        publishShowcase({ plan, result, aliases: crossMediaAliases, journal, review, publicClient, onProgress() {} });
      const retainedSelection: Selection = [
        { candidate: sibling.id, rank: 'normal' },
        { candidate: editorialId, rank: 'preferred' },
      ];
      retainedSelection.sort((left, right) => left.candidate.localeCompare(right.candidate));
      const expectPartialPublication = (publication: Awaited<ReturnType<typeof publish>>) => {
        expect(publication.status).toBe('incomplete');
        expect(publication.omissions).toContainEqual({ provider: 'vndb', sourceKey: 'v1', code: 'review-http-503' });
        const record = publication.published.find((item) => item.sourceKey === 'v1');
        expect(record?.assertions.find((assertion) => assertion.candidateId === sibling.id)).toEqual(
          expect.objectContaining({
            property: 'schema:name',
            adoption: { head: 8, candidateId: sibling.id, rank: 'normal' },
            readback: { ...sibling.statement, id: sibling.id, rank: 'normal' },
          }),
        );
        expect(record?.assertions.some((assertion) => assertion.candidateId === unresolved.id)).toBe(false);
        expect(publication.manifest.records.find((item) => item.sourceKey === 'v1')?.assertions).toContainEqual(
          expect.objectContaining({ candidateId: unresolved.id, statement: unresolved.statement }),
        );
        expect(adopted.get('schema:name')).toEqual({ head: 8, selection: retainedSelection });
        expect(publicReads.at(-1)?.subject?.statements?.['schema:name']).toEqual(
          retainedSelection.map(({ candidate, rank }) => ({
            ...candidates.get(candidate)!.statement,
            id: candidate,
            rank,
          })),
        );
        expect(accepted.has(unresolved.id)).toBe(false);
        expect(acceptanceCalls.filter((call) => call.candidateId === sibling.id)).toHaveLength(
          siblingDecision === 'accepted' ? 0 : 1,
        );
      };
      const first = await publish();
      expectPartialPublication(first);
      const assertion = first.manifest.records[0]!.assertions.find((item) => item.candidateId === unresolved.id)!;
      const actionKey = `accept:${showcaseDigest({ identity: unresolved.id, digest: assertion.candidateDigest })}`;
      const originalAction = journal.action(actionKey)!;
      expect(originalAction).toMatchObject({ state: 'prepared', error_code: null });
      expect(adoptionWrites.filter((body) => body.property === 'schema:name')).toEqual([
        {
          context: globalContext,
          property: 'schema:name',
          mode: 'replace',
          expected_head: 7,
          selection: retainedSelection,
        },
      ]);

      journal.close();
      journal = new ShowcaseJournal(journalPath);
      const reopened = await publish();
      expectPartialPublication(reopened);
      expect(reopened.manifest.digest).toBe(first.manifest.digest);
      expect(journal.action(actionKey)).toMatchObject({
        state: 'prepared',
        error_code: null,
        body_json: originalAction.body_json,
        idempotency_key: originalAction.idempotency_key,
      });
      expect(adoptionWrites.filter((body) => body.property === 'schema:name')).toHaveLength(1);

      journal.close();
      journal = new ShowcaseJournal(journalPath);
      unavailableCandidateId = null;
      const recovered = await publish();
      expect(recovered.status).toBe('published');
      expect(recovered.omissions).toEqual([]);
      expect(recovered.manifest.digest).toBe(first.manifest.digest);
      expect(journal.acknowledgedCommands()).toEqual(acknowledged);
      const finalSelection: Selection = [...retainedSelection, { candidate: unresolved.id, rank: 'normal' }];
      finalSelection.sort((left, right) => left.candidate.localeCompare(right.candidate));
      expect(adoptionWrites.filter((body) => body.property === 'schema:name').at(-1)).toEqual({
        context: globalContext,
        property: 'schema:name',
        mode: 'replace',
        expected_head: 8,
        selection: finalSelection,
      });
      const recoveredNames = recovered.published[0]!.assertions.filter((item) => item.property === 'schema:name');
      expect(recoveredNames.map((item) => item.candidateId).sort()).toEqual([sibling.id, unresolved.id].sort());
      for (const item of recoveredNames)
        expect(item.adoption).toEqual({ head: 9, candidateId: item.candidateId, rank: 'normal' });
      expect(publicReads.at(-1)?.subject?.statements?.['schema:name']).toEqual(
        finalSelection.map(({ candidate, rank }) => ({
          ...candidates.get(candidate)!.statement,
          id: candidate,
          rank,
        })),
      );
      const attempts = acceptanceCalls.filter((call) => call.candidateId === unresolved.id);
      expect(attempts).toHaveLength(3);
      for (const attempt of attempts) expect(attempt).toEqual(attempts[0]!);
      expect(journal.action(actionKey)).toMatchObject({
        state: 'acknowledged',
        body_json: originalAction.body_json,
        idempotency_key: originalAction.idempotency_key,
      });
      if (siblingDecision === 'accepted') {
        // Partial fact publication still requires the record's current source identity.
        const identity = [...candidates.values()].find((item) => item.statement.property.id === 'wdt:P3180')!;
        accepted.delete(identity.id);
        adopted.delete('wdt:P3180');
        unavailableCandidateId = identity.id;
        const writesBeforeIdentityFailure = adoptionWrites.length;
        const withheld = await publish();
        expect(withheld.status).toBe('incomplete');
        expect(withheld.published.some((record) => record.sourceKey === 'v1')).toBe(false);
        expect(withheld.omissions).toContainEqual({ provider: 'vndb', sourceKey: 'v1', code: 'review-http-503' });
        expect(withheld.omissions).toContainEqual({
          provider: 'vndb',
          sourceKey: 'v1',
          code: 'source-uri-not-current',
        });
        expect(adoptionWrites).toHaveLength(writesBeforeIdentityFailure);
      }
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

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

function fixtureAdoptionReceipt(body: Parameters<ShowcaseReviewPort['adoptReviewedCandidates']>[1], head: number) {
  const { context, property, mode, selection } = body;
  return { adoption: { context, property, mode, selection, head }, revision: head };
}

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
  const review: Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'> = {
    async adoptReviewedCandidates(_id, body, key) {
      calls.push({ body, key });
      return fixtureAdoptionReceipt(body, (body.expected_head ?? 0) + 1);
    },
  };
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
      property: planned.property,
      async plan(refresh) {
        expect(refresh).toBe(true);
        expect(journal.action(laterKey)?.state).toBe('acknowledged');
        return { planned: { ...planned, expected_head: 2 }, current: { selection: planned.selection } };
      },
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
        async adoptReviewedCandidates(_id, body, key) {
          previousCalls.push(key);
          return fixtureAdoptionReceipt(body, 2);
        },
      },
      subjectId,
      intent,
      property: planned.property,
      async plan(refresh) {
        expect(refresh).toBe(true);
        expect(previousJournal.action(previousKey)?.state).toBe('acknowledged');
        return { planned: { ...planned, expected_head: 2 }, current: { selection: planned.selection } };
      },
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
      property: planned.property,
      async plan(refresh) {
        expect(refresh).toBe(true);
        expect(emptyJournal.action(emptyKey)?.state).toBe('acknowledged');
        return { planned: { ...emptyPlanned, expected_head: 2 }, current: { selection: [] } };
      },
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
    let committedReceipt: ReturnType<typeof fixtureAdoptionReceipt> | undefined;
    const unknownReview: Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'> = {
      async adoptReviewedCandidates(_id, body, key) {
        unknownCalls.push({ body, key });
        if (!committedReceipt) {
          committedReceipt = fixtureAdoptionReceipt(body, 2);
          throw new Error('Lost committed adoption');
        }
        return committedReceipt;
      },
    };
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
      property: planned.property,
      async plan(refresh) {
        expect(refresh).toBe(true);
        const replayed = adoptKey(showcaseDigest({ intent, generation: 32 }));
        expect(reopened.action(replayed)?.state).toBe('acknowledged');
        return { planned: { ...planned, expected_head: 99 }, current: { selection: planned.selection } };
      },
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
  const current = { head: 99, selection: otherBody.selection };
  const review: Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'> = {
    async adoptReviewedCandidates(_id, body, key) {
      calls.push({ body, key });
      // Idempotent replay returns its original receipt while the current native head stays unchanged.
      if (key === sealedKey) return fixtureAdoptionReceipt(planned, 2);
      expect(body.expected_head).toBe(current.head);
      return fixtureAdoptionReceipt(body, current.head + 1);
    },
  };
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
      property: planned.property,
      async plan(refresh) {
        expect(refresh).toBe(true);
        expect(journal.action(generation32)?.state).toBe('acknowledged');
        return { planned: { ...planned, expected_head: current.head }, current };
      },
    });
    expect(recovered).toEqual({
      status: 'complete',
      snapshot: { head: current.head + 1, selection: planned.selection },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(sealedKey);
    expect(calls[0]?.body).toEqual(planned);
    expect(calls[1]?.key).not.toBe(sealedKey);
    expect(calls[1]?.body).toEqual({ ...planned, expected_head: current.head });
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
    'Cross-media seed finalization state=started scope=seed phase=result-write remaining=result-write,publication-completion',
    'Cross-media seed finalization state=failed scope=seed phase=result-write remaining=result-write,publication-completion',
  ]);
  expect(formatSeedError(failure)).toBe(
    'Cross-media seed failed finalization{scope=seed phase=result-write remaining=result-write,publication-completion}',
  );
  expect(formatSeedError(new Error('phase=result-write secret'))).toBe('Cross-media seed failed');
});

test('incomplete publication preserves the written seed artifact and reports completion separately from I/O', async () => {
  const temporary = join(import.meta.dir, '../../../.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'seed-result-'));
  const resultPath = join(directory, 'result.json'),
    lines: string[] = [];
  const progress = new SeedFinalization('seed', (line) => lines.push(line));
  const publication = { status: 'incomplete' as const, omissions: [{ code: 'legacy-candidate-not-exact' }] };
  const report = { showcase: publication, published: 507 };
  let written = false;
  try {
    const failure = await finalizeSeedResult({
      resultPath,
      report,
      publication,
      progress,
      onWritten: () => {
        written = true;
      },
    }).catch((error: unknown) => error);
    progress.failed(failure);
    expect(written).toBe(true);
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(report);
    expect(formatSeedError(failure)).toContain('publication incomplete result-write=completed');
    expect(formatSeedError(failure)).toContain(`artifact=${JSON.stringify(resultPath)} bounded-omissions=1`);
    expect(formatSeedArtifactHandoff(failure)).toBe(
      `Cross-media seed artifact handoff ${JSON.stringify({
        version: 1,
        state: 'publication-incomplete',
        artifact: resultPath,
        artifactSha256: createHash('sha256')
          .update(JSON.stringify(report, null, 2) + '\n')
          .digest('hex'),
        omissions: 1,
      })}`,
    );
    expect(lines.at(-1)).toContain('state=failed scope=seed phase=publication-completion');
    expect(lines.some((line) => line.includes('state=completed'))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
