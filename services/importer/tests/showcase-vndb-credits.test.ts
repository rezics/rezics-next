import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  creditTypeConceptUri,
  creditTypeSchemeUri,
  vndbStaffCreditConverterRevision,
} from '../src/vndb-staff-credits.ts';
import { crossMediaAliases, planCrossMediaSeed, seedCrossMedia, type CrossMediaPort } from '../src/cross-media-seed.ts';
import {
  prepareShowcaseVndbCreditVocabulary,
  publishedShowcaseVndbCreditReferences,
} from '../src/showcase-vndb-credits.ts';
import { buildShowcaseManifest } from '../src/showcase-manifest.ts';
import {
  captureShowcaseCommands,
  ShowcaseJournal,
  type ShowcasePublicationResult,
} from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

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

function publicSubjects(schemeId: string, concepts: { code: string; id: string }[]) {
  return new Map<string, unknown>([
    [
      schemeId,
      {
        subject: {
          id: schemeId,
          type: 'skos:ConceptScheme',
          statements: { 'schema:url': [{ value: { content: creditTypeSchemeUri } }] },
        },
      },
    ],
    ...concepts.map(
      ({ code, id }) =>
        [
          id,
          {
            subject: {
              id,
              type: 'skos:Concept',
              statements: {
                'schema:url': [{ value: { content: creditTypeConceptUri(code) } }],
                'skos:inScheme': [{ value: { content: schemeId } }],
              },
            },
          },
        ] as const,
    ),
  ]);
}

function port(commands: BatchCommand[], known: Map<string, unknown>): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const created = new Map<string, { id: string; type: string }>();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = randomUUID();
            created.set(command.source.external_id, { id, type: command.subject.type });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
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
      const subject = known.get(id);
      if (subject) return subject as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      const entry = [...created.values()].find((candidate) => candidate.id === id);
      return {
        subject: { id, type: entry?.type, labels: { en: entry?.type ?? 'Imported subject' }, statements: {} },
      } as unknown as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

function journalPort(commands: BatchCommand[]) {
  type Subject = {
    subject: {
      id: string;
      type: string;
      labels: Record<string, string>;
      statements: Record<string, { value: { content: unknown } }[]>;
    };
  };
  const subjects = new Map<string, Subject>();
  const metadata = sourceRecordMetadataFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, {
              subject: { id, type: command.subject.type, labels: command.subject.labels, statements: {} },
            });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const subject = subjects.get(command.subject);
            const value = command.statement.value;
            if (subject && value.type === 'value') {
              const rows = subject.subject.statements[command.statement.property.id] ?? [];
              rows.push({ value: { content: value.content } });
              subject.subject.statements[command.statement.property.id] = rows;
            }
            return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
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
      return (subjects.get(id) ?? null) as unknown as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  return { port, subjects };
}

test('the selected-family seed qualifies staff and voice credits without alias identities or duplicate edges', async () => {
  const tables = selectedVn();
  const plan = await planCrossMediaSeed(tables);
  const schemeId = randomUUID();
  const scenarioId = randomUUID();
  const designId = randomUUID();
  const known = publicSubjects(schemeId, [
    { code: 'scenario', id: scenarioId },
    { code: 'chardesign', id: designId },
  ]);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credits-'));
  try {
    const result = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port(commands, known), undefined, {
      vndbCreditReferences: {
        schemeId,
        concepts: [
          { code: 'scenario', id: scenarioId },
          { code: 'chardesign', id: designId },
        ],
      },
      mediaDeadlineMs: 0,
    });
    const readings = new Map(result.readings.map((reading) => [reading.externalId, reading.subject.subject.id]));
    const person = readings.get('s4');
    const character = readings.get('c3');
    expect(plan.franchises.clannad.vndb).toEqual(['v1']);
    expect(plan.entities.vndb.filter((row) => row.key === 's4')).toHaveLength(1);
    expect(person).toBeTruthy();
    expect(character).toBeTruthy();

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
    const author = proposals.find((command) => command.statement.property.id === 'schema:author')!;
    const illustrator = proposals.find((command) => command.statement.property.id === 'schema:illustrator')!;
    const voice = proposals.find((command) => command.statement.property.id === 'wdt:P725')!;
    const qualifiers = (command: typeof author) => command.statement.qualifiers ?? [];
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
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Voice Alias' } },
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
    expect(result.vndbCreditDiagnostics).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('local credit vocabulary stages from selected rows, recovers ACK UUIDs and withholds a changed role', async () => {
  const tables = selectedVn();
  const plan = await planCrossMediaSeed(tables);
  const commands: BatchCommand[] = [];
  const { port: rawPort, subjects } = journalPort(commands);
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credit-journal-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const statePath = join(directory, 'state.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  let captured = captureShowcaseCommands(rawPort, journal);
  try {
    const first = await seedCrossMedia(plan, statePath, captured, undefined, { mediaDeadlineMs: 0 });
    const schemes = await prepareShowcaseVndbCreditVocabulary({ plan, port: captured, journal, stage: 'schemes' });
    expect(schemes.requirements).toHaveLength(1);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    captured = captureShowcaseCommands(rawPort, journal);

    const concepts = await prepareShowcaseVndbCreditVocabulary({ plan, port: captured, journal, stage: 'concepts' });
    expect(concepts.requirements.map((requirement) => requirement.sourceKey)).toEqual([
      'vndb.credit_type',
      'vndb.credit_type:chardesign',
      'vndb.credit_type:scenario',
    ]);
    const acknowledgements = journal.acknowledgedCommands();
    const designRequirement = concepts.requirements.find((requirement) =>
      requirement.sourceKey.endsWith(':chardesign'),
    )!;
    const designCreate = acknowledgements.find(
      (entry) =>
        entry.command.op === 'create' && entry.command.source.external_id === designRequirement.source.external_id,
    )!;
    const designSubject = subjects.get(designCreate.subjectId!)!;
    designSubject.subject.statements['skos:inScheme'] = [{ value: { content: randomUUID() } }];
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    captured = captureShowcaseCommands(rawPort, journal);

    const published = concepts.requirements
      .filter((requirement) => requirement !== designRequirement)
      .flatMap((requirement) => {
        const create = acknowledgements.find(
          (entry) =>
            entry.command.op === 'create' && entry.command.source.external_id === requirement.source.external_id,
        );
        if (!create?.subjectId) return [];
        const read = subjects.get(create.subjectId);
        if (!read || read.subject.type !== requirement.nativeType) return [];
        return [
          {
            provider: 'vndb' as const,
            sourceKey: requirement.sourceKey,
            subjectId: create.subjectId,
            nativeType: requirement.nativeType,
            readerRoute: `/subjects/${create.subjectId}/credit`,
            assertions:
              requirement.nativeType === 'skos:ConceptScheme'
                ? [{ candidateId: randomUUID(), property: 'schema:url', digest: 'a'.repeat(64) }]
                : [
                    { candidateId: randomUUID(), property: 'schema:url', digest: 'b'.repeat(64) },
                    { candidateId: randomUUID(), property: 'skos:inScheme', digest: 'c'.repeat(64) },
                  ],
          },
        ];
      });
    const manifest = buildShowcaseManifest({
      plan,
      readings: first.readings,
      acknowledgements,
      aliases: crossMediaAliases,
      vocabularyRequirements: concepts.requirements,
    });
    const publication = {
      status: 'incomplete' as const,
      manifest,
      published,
      omissions: [],
      unresolvedCharacterDependencies: [],
    } satisfies ShowcasePublicationResult;
    const references = publishedShowcaseVndbCreditReferences(publication, journal, concepts.requirements)!;
    expect(references.concepts).toEqual([expect.objectContaining({ code: 'scenario' })]);

    const current = await seedCrossMedia(plan, statePath, captured, undefined, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: async (id) => {
        const read = await rawPort.readReviewedSubject(id);
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
      vocabularyRequirements: concepts.requirements,
    });
    const work = creditManifest.records.find((record) => record.sourceKey === 'v1')!;
    expect(work.assertions.map((assertion) => assertion.property)).toEqual(
      expect.arrayContaining(['schema:author', 'wdt:P725']),
    );
    expect(work.assertions.map((assertion) => assertion.property)).not.toContain('schema:illustrator');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
