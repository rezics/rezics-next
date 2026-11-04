import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import {
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from '../../../packages/conversion/src/support.ts';
import { planCrossMediaSeed, type CrossMediaPort, type CrossMediaTables } from '../src/cross-media-seed.ts';
import {
  developmentStatusConceptUri,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
} from '../src/vndb-release-fidelity.ts';
import { prepareShowcaseVndbReleaseClassifications, seedShowcaseVndbReleases } from '../src/showcase-vndb-releases.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../src/showcase-publication.ts';
import { planVndbReleasePlatforms } from '../src/vndb-release-platforms.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

type Row = Record<string, unknown>;

/** Compact COPY-shaped selected family. These rows are not observed public dump evidence. */
function family(
  overrides: { released?: Row[]; vn?: Row[]; links?: Row[]; supersedes?: Row[]; platforms?: Row[]; media?: Row[] } = {},
): CrossMediaTables {
  const rows: Record<string, Row[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/vn': overrides.vn ?? [
      { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/releases': overrides.released ?? [
      { id: 'r1', released: '20200229' },
      { id: 'r2', released: '99999999' },
      { id: 'r4', released: '20200300' },
      { id: 'r3', released: '20210101' },
    ],
    'vndb/releases_titles': [
      { id: 'r1', lang: 'ja', mtl: 't', title: 'Selected day release', latin: null },
      { id: 'r2', lang: 'ja', mtl: 't', title: 'Selected TBA release', latin: null },
      { id: 'r4', lang: 'ja', mtl: 't', title: 'Selected month release', latin: null },
      { id: 'r5', lang: 'ja', mtl: 't', title: 'Selected unknown release', latin: null },
      { id: 'r3', lang: 'ja', mtl: 't', title: 'Unselected owner', latin: null },
    ],
    'vndb/releases_vn': overrides.links ?? [
      { id: 'r1', vid: 'v1', rtype: 'complete' },
      { id: 'r2', vid: 'v1', rtype: 'bundle' },
      { id: 'r4', vid: 'v2', rtype: 'complete' },
      { id: 'r3', vid: 'v99', rtype: 'complete' },
    ],
    'vndb/releases_supersedes': overrides.supersedes ?? [{ id: 'r1', rid: 'r2' }],
    'vndb/releases_platforms': overrides.platforms ?? [],
    'vndb/releases_media': overrides.media ?? [],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function localReviewPort(commands: BatchCommand[], created = new Map<string, string>()): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const subjectsById = new Map<string, { subject: Record<string, unknown> }>();
  for (const [id, value] of Object.entries(subjects(true)))
    subjectsById.set(id, value as { subject: Record<string, unknown> });
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = created.get(command.key) ?? randomUUID();
            created.set(command.key, id);
            subjectsById.set(id, {
              subject: { id, type: command.subject.type, labels: command.subject.labels, statements: {} },
            });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const read = subjectsById.get(command.subject) ?? { subject: { id: command.subject, statements: {} } };
            const subject = read.subject;
            const statements = (subject.statements ?? {}) as Record<string, unknown[]>;
            statements[command.statement.property.id] = [
              ...(statements[command.statement.property.id] ?? []),
              { value: command.statement.value },
            ];
            subject.statements = statements;
            subjectsById.set(command.subject, read);
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
      return (subjectsById.get(id) ?? { subject: { id } }) as Awaited<
        ReturnType<CrossMediaPort['readReviewedSubject']>
      >;
    },
  };
}

const schemeId = '00000000-0000-4000-8000-000000000021';
const statusId = '00000000-0000-4000-8000-000000000022';
const hiddenStatus = '00000000-0000-4000-8000-000000000025';
const platformSchemeId = '00000000-0000-4000-8000-000000000031';
const platformWinId = '00000000-0000-4000-8000-000000000032';
const platformMacId = '00000000-0000-4000-8000-000000000033';
const mediumSchemeId = '00000000-0000-4000-8000-000000000034';
const mediumCdId = '00000000-0000-4000-8000-000000000035';
const catalogue = {
  'vndb-development-status-scheme': schemeId,
  'vndb-development-status-1': statusId,
};

function classificationGroups() {
  return [
    {
      taxonomy: vndbReleasePlatformTaxonomy,
      uri: vndbReleasePlatformSchemeUri,
      schemeId: platformSchemeId,
      concepts: [
        { code: 'win', id: platformWinId },
        { code: 'mac', id: platformMacId },
      ],
    },
    {
      taxonomy: vndbReleaseMediumTaxonomy,
      uri: vndbReleaseMediumSchemeUri,
      schemeId: mediumSchemeId,
      concepts: [{ code: 'cd', id: mediumCdId }],
    },
  ];
}

function subjects(statusBound: boolean, platformWinBound = true): Record<string, object> {
  const conceptId = statusBound ? statusId : hiddenStatus;
  return {
    [schemeId]: {
      subject: {
        id: schemeId,
        type: 'skos:ConceptScheme',
        statements: { 'schema:url': [{ value: { content: developmentStatusSchemeUri } }] },
      },
    },
    [conceptId]: {
      subject: {
        id: conceptId,
        type: statusBound ? 'skos:Concept' : 'wd:Q20631656',
        statements: statusBound
          ? {
              'schema:url': [{ value: { content: developmentStatusConceptUri('1') } }],
              'skos:inScheme': [{ value: { content: schemeId } }],
            }
          : {},
      },
    },
    [platformSchemeId]: {
      subject: {
        id: platformSchemeId,
        type: 'skos:ConceptScheme',
        statements: { 'schema:url': [{ value: { content: vndbReleasePlatformSchemeUri } }] },
      },
    },
    [platformWinId]: {
      subject: {
        id: platformWinId,
        type: 'skos:Concept',
        statements: platformWinBound
          ? {
              'schema:url': [{ value: { content: `${vndbReleasePlatformSchemeUri}/win` } }],
              'skos:inScheme': [{ value: { content: platformSchemeId } }],
            }
          : { 'skos:inScheme': [{ value: { content: platformSchemeId } }] },
      },
    },
    [platformMacId]: {
      subject: {
        id: platformMacId,
        type: 'skos:Concept',
        statements: {
          'schema:url': [{ value: { content: `${vndbReleasePlatformSchemeUri}/mac` } }],
          'skos:inScheme': [{ value: { content: platformSchemeId } }],
        },
      },
    },
    [mediumSchemeId]: {
      subject: {
        id: mediumSchemeId,
        type: 'skos:ConceptScheme',
        statements: { 'schema:url': [{ value: { content: vndbReleaseMediumSchemeUri } }] },
      },
    },
    [mediumCdId]: {
      subject: {
        id: mediumCdId,
        type: 'skos:Concept',
        statements: {
          'schema:url': [{ value: { content: `${vndbReleaseMediumSchemeUri}/cd` } }],
          'skos:inScheme': [{ value: { content: mediumSchemeId } }],
        },
      },
    },
  };
}

function port(
  commands: BatchCommand[],
  statusBound: boolean,
  created = new Map<string, string>(),
  platformWinBound = true,
): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  const known = subjects(statusBound, platformWinBound);
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = created.get(command.key) ?? randomUUID();
            created.set(command.key, id);
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
      const row = known[id];
      if (!row) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return row as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

function extras() {
  return {
    providers: ['vndb'] as const,
    mediaDeadlineMs: 0,
    recordConcurrency: 1,
    episodeCatalogueSubjects: catalogue,
  };
}

function dateContent(command: BatchCommand) {
  return command.op === 'propose' && command.statement.value.type === 'value'
    ? command.statement.value.content
    : undefined;
}

test('default seed without binding files rereads catalogue state and exposes selected dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-'));
  const created = new Map<string, string>();
  let journal: ShowcaseJournal | undefined;
  try {
    const tables = family({
      released: [
        { id: 'r1', released: '20200229', olang: 'ja', minage: 18, gtin: '1234567890123' },
        { id: 'r2', released: '99999999' },
        { id: 'r4', released: '20200300' },
        { id: 'r3', released: '20210101' },
      ],
      platforms: [
        { id: 'r1', platform: 'mac' },
        { id: 'r1', platform: 'win' },
        { id: 'r1', platform: 'win' },
        { id: 'r1', platform: 'xyz' },
        { id: 'r2', platform: 'ios' },
        { id: 'r3', platform: 'win' },
        { id: 'r99', platform: 'win' },
      ],
      media: [
        { id: 'r1', medium: 'cd' },
        { id: 'r1', medium: 'dvd' },
        { id: 'r1', medium: 'dvd' },
        { id: 'r2', medium: 'cd' },
        { id: 'r3', medium: 'dvd' },
      ],
    });
    const plan = await planCrossMediaSeed(tables);
    expect(plan.entities.vndb.some((row) => row.key === 'r1')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r2')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r4')).toBe(true);
    expect(plan.entities.vndb.some((row) => row.key === 'r3')).toBe(false);
    const firstCommands: BatchCommand[] = [];
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const basePort = localReviewPort(firstCommands, created);
    const baseBatch = basePort.batch.bind(basePort);
    const attempted: BatchCommand[] = [];
    let loseFirstDelivery = true;
    const recoveryPort = captureShowcaseCommands(
      {
        ...basePort,
        async batch(request) {
          attempted.push(...request.commands);
          if (loseFirstDelivery) {
            loseFirstDelivery = false;
            throw new Error('lost delivery');
          }
          return baseBatch(request);
        },
      },
      journal,
    );
    let lost = false;
    try {
      await prepareShowcaseVndbReleaseClassifications({ plan, port: recoveryPort, journal, stage: 'schemes' });
    } catch (error) {
      lost = error instanceof Error && error.message === 'lost delivery';
    }
    expect(lost).toBe(true);
    const sealedBeforeRetry = journal.preparedCommands().map((row) => row.command);
    expect(sealedBeforeRetry).toEqual(attempted);
    const reviewPort = recoveryPort;
    const schemes = await prepareShowcaseVndbReleaseClassifications({
      plan,
      port: reviewPort,
      journal,
      stage: 'schemes',
    });
    expect(attempted.slice(0, sealedBeforeRetry.length)).toEqual(
      attempted.slice(sealedBeforeRetry.length, sealedBeforeRetry.length * 2),
    );
    expect(journal.preparedCommands()).toHaveLength(0);
    expect(schemes.requirements.map((item) => item.nativeType).sort()).toEqual([
      'skos:ConceptScheme',
      'skos:ConceptScheme',
    ]);
    const classifications = await prepareShowcaseVndbReleaseClassifications({
      plan,
      port: reviewPort,
      journal,
      stage: 'concepts',
    });
    expect(classifications.bindings.concepts.map((item) => item.code).sort()).toEqual([
      'cd',
      'dvd',
      'ios',
      'mac',
      'win',
    ]);
    expect(classifications.requirements.filter((item) => item.nativeType === 'skos:Concept')).toHaveLength(5);
    expect(
      firstCommands.some(
        (command) =>
          command.op === 'create' &&
          command.subject.type === 'skos:Concept' &&
          command.subject.labels.en === 'win' &&
          /^[0-9a-f]{64}$/u.test(command.source.digest),
      ),
    ).toBe(true);
    expect(
      firstCommands.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:url' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === `${vndbReleasePlatformSchemeUri}/win` &&
          JSON.stringify(command.statement.references).includes('https://vndb.org/r1'),
      ),
    ).toBe(true);
    const overflow = await planVndbReleasePlatforms(tables, ['r1'], new Map([['r1', 1]]));
    expect(overflow.byRelease.get('r1')).toEqual({
      platforms: [{ code: 'mac', path: '/releases_platforms/r1/platform' }],
      media: [],
    });
    expect(overflow.gaps.some((row) => row.reason.includes('available source-vocabulary row cap'))).toBe(true);
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: reviewPort,
      bindings: classifications.bindings,
      groups: classifications.groups,
      extras: extras(),
    });
    expect(first.converterRevision).toBe(converter_revision);
    expect(first.bindings.releaseDigest).toBe(bundledDigest);
    expect(first.bindings.concepts.some((row) => row.id === statusId && row.code === '1')).toBe(true);
    expect(first.facts.releases.get('r1')?.links).toEqual([{ vid: 'v1', completeness: 'complete' }]);
    expect(first.facts.releases.get('r2')?.links).toEqual([{ vid: 'v1', completeness: 'bundle' }]);
    expect(first.facts.releases.has('r3')).toBe(false);
    expect(plan.releasePlatforms?.get('r1')).toMatchObject({
      platforms: [{ code: 'mac' }, { code: 'win' }],
      media: [{ code: 'cd' }, { code: 'dvd' }],
    });
    expect(first.identities.some((row) => row.key === 'v1' && row.kind === 'work' && row.subjectId)).toBe(true);
    expect(first.identities.some((row) => row.key === 'r1' && row.kind === 'release')).toBe(true);
    const proposed = firstCommands.filter((command) => command.op === 'propose');
    const classificationsByProperty = (property: string) =>
      proposed.flatMap((command) =>
        command.source.external_id.startsWith('r') &&
        command.statement.property.id === property &&
        command.statement.value.type === 'value' &&
        typeof command.statement.value.content === 'string'
          ? [{ release: command.source.external_id, concept: command.statement.value.content }]
          : [],
      );
    const codeId = (code: string) => classifications.bindings.concepts.find((item) => item.code === code)!.id;
    expect(classificationsByProperty('schema:gamePlatform').sort((a, b) => a.concept.localeCompare(b.concept))).toEqual(
      [
        { release: 'r1', concept: codeId('mac') },
        { release: 'r1', concept: codeId('win') },
        { release: 'r2', concept: codeId('ios') },
      ].sort((a, b) => a.concept.localeCompare(b.concept)),
    );
    expect(
      classificationsByProperty('wdt:P437').sort(
        (left, right) => left.release.localeCompare(right.release) || left.concept.localeCompare(right.concept),
      ),
    ).toEqual(
      [
        { release: 'r1', concept: codeId('cd') },
        { release: 'r1', concept: codeId('dvd') },
        { release: 'r2', concept: codeId('cd') },
      ].sort((left, right) => left.release.localeCompare(right.release) || left.concept.localeCompare(right.concept)),
    );
    const associationProposals = proposed.filter(
      (command) =>
        command.statement.property.id === 'schema:gamePlatform' || command.statement.property.id === 'wdt:P437',
    );
    expect(JSON.stringify(associationProposals)).toContain('/releases_platforms/r1/platform');
    expect(JSON.stringify(associationProposals)).toContain('/releases_media/r1/medium');
    expect(first.gaps.some((row) => JSON.stringify(row.record).includes('xyz'))).toBe(true);
    expect(classifications.groups.map((group) => group.taxonomy).sort()).toEqual(
      [vndbReleaseMediumTaxonomy, vndbReleasePlatformTaxonomy].sort(),
    );
    expect(
      classifications.groups.every(
        (group) => group.uri === vndbReleasePlatformSchemeUri || group.uri === vndbReleaseMediumSchemeUri,
      ),
    ).toBe(true);
    expect(
      firstCommands.some(
        (command) =>
          command.op === 'create' &&
          command.source.external_id === 'r1' &&
          command.subject.labels.ja === 'Selected day release',
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:inLanguage' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === 'ja',
      ),
    ).toBe(true);
    expect(
      proposed.some((command) => command.source.external_id === 'r1' && command.statement.property.id === 'wdt:P2899'),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:gtin' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === '1234567890123',
      ),
    ).toBe(true);
    const workIdForRelease = first.identities.find((row) => row.key === 'v1')?.subjectId;
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:exampleOfWork' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === workIdForRelease,
      ),
    ).toBe(true);
    expect(JSON.stringify(firstCommands)).not.toContain('schema:downloadUrl');
    expect(JSON.stringify(firstCommands)).not.toContain('bf:Instance');
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r4' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-03-00T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === statusId,
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'r2' && command.statement.property.id === 'schema:datePublished',
      ),
    ).toBe(false);
    expect(
      proposed.some(
        (command) => command.source.external_id === 'r2' && command.statement.property.id === 'schema:keywords',
      ),
    ).toBe(false);
    expect(first.gaps.some((row) => row.reason.includes('finite reviewed inventory'))).toBe(true);
    expect(
      first.vocabularyGaps.some(
        (gap) =>
          gap.path === '/releases_vn/r1/v1' &&
          gap.code === 'complete' &&
          gap.reason === 'qualifier_not_admitted' &&
          gap.property === 'wdt:P31',
      ),
    ).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    expect(JSON.stringify(proposed)).not.toContain('wdt:P1365');
    const workId = first.identities.find((row) => row.key === 'v1')?.subjectId;
    const releaseId = first.identities.find((row) => row.key === 'r1')?.subjectId;
    const againCommands: BatchCommand[] = [];
    const again = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(againCommands, true, created),
      extras: extras(),
    });
    expect(again.identities.find((row) => row.key === 'v1')?.subjectId).toBe(workId);
    expect(again.identities.find((row) => row.key === 'r1')?.subjectId).toBe(releaseId);
    expect(again.bindings.concepts.some((row) => row.id === statusId)).toBe(true);
  } finally {
    journal?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('malformed and retracted source states withhold only affected claims', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-releases-edges-'));
  const created = new Map<string, string>();
  try {
    const tables = family({
      vn: [
        { id: 'v1', olang: 'ja', alias: null, devstatus: 1 },
        { id: 'v2', olang: 'ja', alias: null, devstatus: 9 },
        { id: 'v3', olang: 'ja', alias: null },
      ],
      released: [
        { id: 'r1', released: '20200229' },
        { id: 'r2', released: null },
        { id: 'r4', released: 'not-a-date' },
        { id: 'r5', released: '00000000' },
        { id: 'r3', released: '20210101' },
      ],
      links: [
        { id: 'r1', vid: 'v1', rtype: 'complete' },
        { id: 'r2', vid: 'v1', rtype: 'complete' },
        { id: 'r4', vid: 'v1', rtype: 'complete' },
        { id: 'r5', vid: 'v1', rtype: 'complete' },
        { id: 'r3', vid: 'v99', rtype: 'complete' },
      ],
      supersedes: [{ id: 'r1', rid: 'r5' }],
    });
    const plan = await planCrossMediaSeed(tables);
    const firstCommands: BatchCommand[] = [];
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(firstCommands, true, created),
      extras: extras(),
      groups: [
        {
          taxonomy: developmentStatusTaxonomy,
          uri: developmentStatusSchemeUri,
          schemeId,
          concepts: [{ code: '1', id: statusId }],
        },
      ],
    });
    const proposed = firstCommands.filter((command) => command.op === 'propose');
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished' &&
          JSON.stringify(dateContent(command)).includes('+2020-02-29T00:00:00Z'),
      ),
    ).toBe(true);
    expect(
      proposed.some(
        (command) =>
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === statusId,
      ),
    ).toBe(true);
    for (const id of ['r2', 'r4', 'r5']) {
      expect(
        proposed.some(
          (command) => command.source.external_id === id && command.statement.property.id === 'schema:datePublished',
        ),
      ).toBe(false);
    }
    expect(first.vocabularyGaps.some((gap) => gap.path === '/releases/r2/released' && gap.code === 'absent')).toBe(
      true,
    );
    expect(first.gaps.some((row) => row.reason.includes('finite reviewed inventory'))).toBe(true);
    expect(plan.gaps.some((row) => row.reason.includes('supersession'))).toBe(true);
    expect(JSON.stringify(proposed)).not.toContain('wdt:P155');
    const workId = first.identities.find((row) => row.key === 'v1')?.subjectId;
    const releaseId = first.identities.find((row) => row.key === 'r1')?.subjectId;
    const retracted: BatchCommand[] = [];
    const lost = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: join(directory, 'state.sqlite'),
      port: port(retracted, false, created),
      extras: extras(),
      groups: [
        {
          taxonomy: developmentStatusTaxonomy,
          uri: developmentStatusSchemeUri,
          schemeId,
          concepts: [{ code: '1', id: hiddenStatus }],
        },
      ],
    });
    expect(lost.identities.find((row) => row.key === 'v1')?.subjectId).toBe(workId);
    expect(lost.identities.find((row) => row.key === 'r1')?.subjectId).toBe(releaseId);
    expect(lost.bindings.concepts.some((row) => row.code === '1')).toBe(false);
    expect(
      retracted.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'v1' &&
          command.statement.property.id === 'schema:keywords' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === hiddenStatus,
      ),
    ).toBe(false);
    expect(
      retracted.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:datePublished',
      ),
    ).toBe(false);
    expect(JSON.stringify(retracted)).not.toContain('wdt:P155');

    const platformPath = join(directory, 'platform-state.sqlite');
    const initialPlatformTables = family({
      platforms: [{ id: 'r1', platform: 'win' }],
      media: [{ id: 'r1', medium: 'cd' }],
    });
    const initialPlatformCommands: BatchCommand[] = [];
    const initialPlatform = await seedShowcaseVndbReleases({
      tables: initialPlatformTables,
      plan: await planCrossMediaSeed(initialPlatformTables),
      path: platformPath,
      port: port(initialPlatformCommands, true, created),
      extras: extras(),
      groups: classificationGroups(),
    });
    expect(
      initialPlatformCommands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:gamePlatform',
      ),
    ).toBe(true);
    expect(
      initialPlatformCommands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P437',
      ),
    ).toBe(true);
    const changedPlatformTables = family({
      platforms: [
        { id: 'r1', platform: 'win' },
        { id: 'r1', platform: 'mac' },
      ],
      media: [{ id: 'r1', medium: 'cd' }],
    });
    const changedPlatformCommands: BatchCommand[] = [];
    const changedPlatform = await seedShowcaseVndbReleases({
      tables: changedPlatformTables,
      plan: await planCrossMediaSeed(changedPlatformTables),
      path: platformPath,
      port: port(changedPlatformCommands, true, created, false),
      extras: extras(),
      groups: classificationGroups(),
    });
    expect(changedPlatform.identities.find((row) => row.key === 'r1')?.subjectId).toBe(
      initialPlatform.identities.find((row) => row.key === 'r1')?.subjectId,
    );
    expect(
      changedPlatform.bindings.concepts.some(
        (row) => row.taxonomy === vndbReleasePlatformTaxonomy && row.code === 'win',
      ),
    ).toBe(false);
    expect(
      changedPlatform.bindings.concepts.some(
        (row) => row.taxonomy === vndbReleasePlatformTaxonomy && row.code === 'mac',
      ),
    ).toBe(true);
    expect(
      changedPlatform.vocabularyGaps.some(
        (row) =>
          row.path === '/releases_platforms/r1/platform' && row.code === 'win' && row.reason === 'missing_concept',
      ),
    ).toBe(true);
    expect(
      changedPlatformCommands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'schema:gamePlatform' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === platformMacId,
      ),
    ).toBe(true);
    expect(
      changedPlatformCommands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'r1' &&
          command.statement.property.id === 'wdt:P437' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === mediumCdId,
      ),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
