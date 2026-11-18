import { sourceDigest } from '@rezics/conversion/support';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  vndbStaffCreditConverterRevision,
} from '../src/vndb-staff-credits.ts';
import { crossMediaAliases, planCrossMediaSeed, seedCrossMedia, type CrossMediaPort } from '../src/cross-media-seed.ts';
import {
  prepareShowcaseVndbCreditVocabulary,
  planShowcaseVndbCredits,
  publishedShowcaseVndbCreditReferences,
} from '../src/showcase-vndb-credits.ts';
import { buildShowcaseManifest, showcaseDigest, type ShowcaseVocabularyRequirement } from '../src/showcase-manifest.ts';
import {
  captureShowcaseCommands,
  ShowcaseJournal,
  type ShowcasePublicationResult,
} from '../src/showcase-publication.ts';
import {
  reviewedStatementFixture,
  reviewedSubjectReadbackFixture,
  reviewedVocabularySubjectFixture,
  sourceRecordMetadataFixture,
} from './transport-driver.ts';

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
      { id: 'v1', aid: '10', role: 'scenario', note: 'Common route, After Story routes' },
      { id: 'v1', aid: '10', role: 'scenario', eid: '5', note: 'Additional source staff grouping' },
      { id: 'v1', aid: '20', role: 'chardesign', note: 'Original character designs' },
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

function currentVocabulary(schemeId: string, concepts: { code: string; id: string }[]) {
  return new Map([
    [
      schemeId,
      reviewedVocabularySubjectFixture(schemeId, 'skos:ConceptScheme', creditTypeSchemeUri, {
        'schema:url': creditTypeSchemeUri,
      }),
    ],
    ...concepts.map(({ code, id }) => {
      const uri = creditTypeConceptUri(code);
      return [
        id,
        reviewedVocabularySubjectFixture(id, 'skos:Concept', uri, {
          'schema:url': uri,
          'skos:inScheme': schemeId,
        }),
      ] as const;
    }),
  ]);
}

function creditPort(commands: BatchCommand[], known: ReadonlyMap<string, ReviewedSubjectRead> = new Map()) {
  const metadata = sourceRecordMetadataFixture();
  const readback = reviewedSubjectReadbackFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = readback.ids.get(command.source.external_id) ?? randomUUID();
            readback.created(command, id);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const candidate = randomUUID();
            const property = command.statement.property.id;
            if (property === 'wdt:P5732' || property === 'wdt:P3180') readback.select(command, candidate);
            return { key: command.key, status: 201 as const, value: { candidate, revision: 1 } };
          }
          return { key: command.key, status: 201 as const, value: { revision: 1 } };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return known.get(id) ?? readback.readReviewedSubject(id);
    },
  };
  return { port, readback };
}

test('the selected-family seed qualifies staff and voice credits without alias identities or duplicate edges', async () => {
  const tables = selectedVn();
  const plan = await planCrossMediaSeed(tables);
  expect(
    planShowcaseVndbCredits(plan).credits.filter((credit) => credit.sourcePath === '/vn_staff/v1/10/scenario'),
  ).toHaveLength(1);
  const schemeId = randomUUID();
  const scenarioId = randomUUID();
  const designId = randomUUID();
  const known = currentVocabulary(schemeId, [
    { code: 'scenario', id: scenarioId },
    { code: 'chardesign', id: designId },
  ]);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credits-'));
  try {
    const result = await seedCrossMedia(
      plan,
      join(directory, 'state.sqlite'),
      creditPort(commands, known).port,
      undefined,
      {
        vndbCreditReferences: {
          schemeId,
          concepts: [
            { code: 'scenario', id: scenarioId },
            { code: 'chardesign', id: designId },
          ],
        },
        mediaDeadlineMs: 0,
      },
    );
    const readings = new Map(result.readings.map((reading) => [reading.externalId, reading.subject.subject]));
    const person = readings.get('s4')?.id;
    const character = readings.get('c3')?.id;
    expect(plan.franchises.clannad.vndb).toEqual(['v1']);
    expect(plan.entities.vndb.filter((row) => row.key === 's4')).toHaveLength(1);
    expect(person).toBeTruthy();
    expect(character).toBeTruthy();
    expect(readings.get('v1')?.type).toBe('wd:Q689445');

    const credits = commands.filter(
      (command) =>
        command.op === 'propose' &&
        command.source.source === crossMediaAliases.vndb &&
        command.source.converter_revision === vndbStaffCreditConverterRevision,
    );
    expect(credits).toHaveLength(3);
    expect(
      credits.every(
        (command) =>
          command.op === 'propose' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === person,
      ),
    ).toBe(true);
    const proposals = credits.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> => command.op === 'propose',
    );
    expect(proposals.filter((command) => command.statement.property.id === 'schema:author')).toHaveLength(1);
    const author = proposals.find((command) => command.statement.property.id === 'schema:author')!;
    const illustrator = proposals.find((command) => command.statement.property.id === 'schema:illustrator')!;
    const voice = proposals.find((command) => command.statement.property.id === 'wdt:P725')!;
    const qualifiers = (command: typeof author) => command.statement.qualifiers ?? [];
    const sourceRows = plan.edges.filter(
      (edge) =>
        edge.source === 'vndb' &&
        edge.table === 'vn_staff' &&
        edge.record.aid === '10' &&
        edge.record.role === 'scenario',
    );
    const rowDigests = sourceRows.map((edge) => sourceDigest(edge.record)).sort();
    expect(author.source.digest).toBe(sourceDigest(rowDigests));
    const reordered = planShowcaseVndbCredits({ ...plan, edges: [...plan.edges].reverse() });
    expect(reordered.credits.find((credit) => credit.sourcePath === '/vn_staff/v1/10/scenario')?.sourceDigest).toBe(
      author.source.digest,
    );
    const conflicting = planShowcaseVndbCredits({
      ...plan,
      edges: [...plan.edges, { ...sourceRows[0]!, target: 's999' }],
    });
    expect(conflicting.credits.some((credit) => credit.sourcePath === '/vn_staff/v1/10/scenario')).toBe(false);
    expect(conflicting.diagnostics).toContainEqual({
      provider: 'vndb',
      path: '/vn_staff/v1/10/scenario',
      reason: 'invalid_row',
    });

    expect(author.source).toEqual(
      expect.objectContaining({
        external_id: 'v1',
        record_revision: '7',
        converter_revision: vndbStaffCreditConverterRevision,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(author.statement.references?.[0]?.parts[0]?.value).toEqual({
      type: 'value',
      content: 'https://vndb.org/v1#/vn_staff/v1/10/scenario',
    });
    expect(qualifiers(author)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: scenarioId } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Writer Alias' } },
      ]),
    );
    expect(qualifiers(illustrator)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: designId } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Artist Alias' } },
      ]),
    );
    expect(qualifiers(voice)).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P453' }, value: { type: 'value', content: character } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Writer Alias' } },
      ]),
    );
    expect(
      commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:author'),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P725'),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.op === 'create' && command.source.external_id.startsWith('s')),
    ).toHaveLength(1);
    expect(result.vndbCreditVocabularyRequirements.map((requirement) => requirement.code)).toEqual([
      'chardesign',
      'scenario',
    ]);
    expect(result.vndbCreditDiagnostics).toEqual([
      {
        provider: 'vndb',
        path: '/vn_staff/v1/10/scenario',
        code: '5',
        reason: 'unsupported_source_case',
        property: 'vn_staff.eid',
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('local credit vocabulary stages from selected rows, recovers ACK UUIDs and withholds a changed role', async () => {
  const tables = selectedVn();
  const plan = await planCrossMediaSeed(tables);
  const commands: BatchCommand[] = [];
  const { port: rawPort, readback } = creditPort(commands);
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credit-journal-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const statePath = join(directory, 'state.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  let captured = captureShowcaseCommands(rawPort, journal);
  const selectVocabulary = (requirements: readonly ShowcaseVocabularyRequirement[]) => {
    const sourceIds = new Set(requirements.map(({ source }) => source.external_id));
    for (const { command, candidateId } of journal.acknowledgedCommands()) {
      if (command.op === 'propose' && candidateId && sourceIds.has(command.source.external_id))
        readback.select(command, candidateId);
    }
  };
  try {
    const first = await seedCrossMedia(plan, statePath, captured, undefined, { mediaDeadlineMs: 0 });
    const schemes = await prepareShowcaseVndbCreditVocabulary({ plan, port: captured, journal, stage: 'schemes' });
    expect(schemes.requirements).toHaveLength(1);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    captured = captureShowcaseCommands(rawPort, journal);

    selectVocabulary(schemes.requirements);
    const concepts = await prepareShowcaseVndbCreditVocabulary({ plan, port: captured, journal, stage: 'concepts' });
    expect(concepts.requirements.map((requirement) => requirement.sourceKey)).toEqual([
      'vndb.credit_type',
      'vndb.credit_type:chardesign',
      'vndb.credit_type:scenario',
    ]);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    captured = captureShowcaseCommands(rawPort, journal);
    selectVocabulary(concepts.requirements);

    const manifest = buildShowcaseManifest({
      plan,
      readings: first.readings,
      acknowledgements: journal.acknowledgedCommands(),
      aliases: crossMediaAliases,
      vocabularyRequirements: concepts.requirements,
    });
    const publicReads = new Map<string, ReviewedSubjectRead>();
    const published = await Promise.all(
      manifest.vocabulary.map(async ({ provider, sourceKey, subjectId, nativeType, assertions }) => {
        const read = await rawPort.readReviewedSubject(subjectId);
        publicReads.set(subjectId, read);
        return {
          provider,
          sourceKey,
          subjectId,
          nativeType,
          readerRoute: `/subjects/${subjectId}/credit`,
          assertions: assertions.map(({ candidateId, property, candidateDigest }) => {
            const selected = read.subject.statements[property]?.find(
              ({ id, rank }) => id === candidateId && rank === 'normal',
            );
            if (!selected) throw new Error(`Missing selected vocabulary candidate ${candidateId}`);
            return {
              candidateId,
              property,
              digest: candidateDigest,
              adoption: { head: 1, candidateId, rank: 'normal' as const },
              readback: selected,
            };
          }),
        };
      }),
    );
    const design = published.find(({ sourceKey }) => sourceKey === 'vndb.credit_type:chardesign')!;
    const publication = {
      status: 'incomplete' as const,
      manifest,
      published,
      vndbWorkRelations: [],
      omissions: [],
      unresolvedCharacterDependencies: [],
    } satisfies ShowcasePublicationResult;
    const partialPublication = { ...publication, published: published.filter((record) => record !== design) };
    expect(publishedShowcaseVndbCreditReferences(partialPublication, journal, concepts.requirements)?.concepts).toEqual(
      [expect.objectContaining({ code: 'scenario' })],
    );
    const references = publishedShowcaseVndbCreditReferences(publication, journal, concepts.requirements)!;
    expect(references.concepts).toEqual([
      { code: 'chardesign', id: design.subjectId },
      expect.objectContaining({ code: 'scenario' }),
    ]);

    // The public membership changed after the publication result was recorded.
    const designRead = publicReads.get(design.subjectId)!;
    designRead.subject.statements['skos:inScheme'] = [
      reviewedStatementFixture(randomUUID(), 'normal', {
        property: { id: 'skos:inScheme' },
        value: { type: 'value', content: randomUUID() },
        references: [],
      }),
    ];

    const current = await seedCrossMedia(plan, statePath, captured, undefined, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: async (id) => {
        const read = publicReads.get(id);
        if (!read) throw new Error('Public test subject is unavailable');
        return read;
      },
    });
    const readings = new Map(current.readings.map((reading) => [reading.externalId, reading.subject.subject.id]));
    const roleCommands = commands.filter(
      (command) => command.op === 'propose' && command.source.converter_revision === vndbStaffCreditConverterRevision,
    );
    const author = roleCommands.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:author',
    );
    const voice = roleCommands.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P725',
    );
    if (!author || author.op !== 'propose' || !voice || voice.op !== 'propose')
      throw new Error('Expected selected VNDB author and voice proposals');
    expect(current.vndbCreditCandidateDigests).toEqual(
      expect.arrayContaining(
        [author, voice].map((proposal) => showcaseDigest({ source: proposal.source, statement: proposal.statement })),
      ),
    );
    expect(author?.op === 'propose' ? author.statement.value : undefined).toEqual({
      type: 'value',
      content: readings.get('s4'),
    });
    expect(voice?.op === 'propose' ? voice.statement.qualifiers : []).toContainEqual({
      property: { id: 'wdt:P453' },
      value: { type: 'value', content: readings.get('c3') },
    });
    expect(
      roleCommands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:illustrator',
      ),
    ).toBe(false);
    expect(current.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    const creditManifest = buildShowcaseManifest({
      plan,
      readings: current.readings,
      acknowledgements: journal.acknowledgedCommands(),
      aliases: crossMediaAliases,
      ...(current.vndbCreditCandidateDigests ? { vndbCreditCandidateDigests: current.vndbCreditCandidateDigests } : {}),
      vocabularyRequirements: concepts.requirements,
    });
    const work = creditManifest.records.find((record) => record.sourceKey === 'v1')!;
    expect(creditManifest.omissions).not.toContainEqual({
      provider: 'vndb',
      sourceKey: 'v1',
      code: 'candidate-ack-missing',
    });
    expect(work.assertions.map((assertion) => assertion.property)).toEqual(
      expect.arrayContaining(['schema:author', 'wdt:P725']),
    );
    expect(work.assertions.map((assertion) => assertion.property)).not.toContain('schema:illustrator');
    if (!author || author.op !== 'propose') throw new Error('Expected selected VNDB author proposal');
    const stale = {
      ...author,
      key: `${author.key}:stale`,
      statement: { ...author.statement, value: { type: 'value' as const, content: randomUUID() } },
    };
    await captured.batch({ commands: [stale] });
    const staleCandidate = journal.acknowledgedCommands().find((entry) => entry.command.key === stale.key)?.candidateId;
    expect(staleCandidate).toBeTruthy();
    const afterStale = buildShowcaseManifest({
      plan,
      readings: current.readings,
      acknowledgements: journal.acknowledgedCommands(),
      aliases: crossMediaAliases,
      ...(current.vndbCreditCandidateDigests ? { vndbCreditCandidateDigests: current.vndbCreditCandidateDigests } : {}),
      vocabularyRequirements: concepts.requirements,
    });
    expect(afterStale.records.find((record) => record.sourceKey === 'v1')?.assertions).not.toContainEqual(
      expect.objectContaining({ candidateId: staleCandidate }),
    );
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
