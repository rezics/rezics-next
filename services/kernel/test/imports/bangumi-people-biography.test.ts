import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  convertCrossMediaEntity,
  converter_revision,
} from '../../../../packages/conversion/src/cross-media-entities.ts';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import type { Json, Statement } from '../../../../specs/semantic-driver.ts';
import type { Proposal } from '../../../../specs/imports-api-driver.ts';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
} from '../../../importer/src/cross-media-seed.ts';
import { createImporter } from '../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import type { ImportTransport, SourceRegistration } from '../../../importer/src/import-contract.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const alias = crossMediaAliases.bangumi;
const globalContext = '00000000-0000-8000-8000-000000000000';
const families = [
  { id: 101, name: 'STEINS;GATE', vndb: 'v101', title: 'STEINS;GATE' },
  { id: 201, name: 'CLANNAD', vndb: 'v201', title: 'CLANNAD' },
  { id: 301, name: 'Fate/stay night', vndb: 'v301', title: 'Fate/stay night' },
];
const personOne = {
  id: 8101,
  type: 1,
  name: '星見',
  summary: '作者紹介：物語と音楽を研究する。',
  career: ['mangaka'],
  birth_year: 1974,
  birth_mon: 11,
  birth_day: 8,
};
const personBirthDate = {
  time: '+1974-11-08T00:00:00Z',
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
};
const organization = { id: 8102, type: 2, name: '星見制作室', summary: '星見制作室の歩み：作品を作り続ける。' };
const emptyPerson = { id: 8103, type: 1, name: '空欄の人物', summary: '' };
const absentPerson = { id: 8104, type: 1, name: '紹介のない人物' };
const fixturePeople = [personOne, organization, emptyPerson, absentPerson];

const bangumiTables = [
  'subject',
  'subject-relations',
  'subject-characters',
  'subject-persons',
  'person-characters',
  'person-relations',
  'character',
  'person',
  'episode',
] as const;
const vndbTables = [
  'vn_titles',
  'vn_relations',
  'vn',
  'entry_meta',
  'releases_vn',
  'vn_staff',
  'vn_seiyuu',
  'chars_vns',
  'staff_alias',
  'staff',
  'chars',
  'releases',
  'vn_anime',
  'releases_producers',
  'releases_supersedes',
  'releases_titles',
  'staff_extlinks',
  'vn_extlinks',
  'producers',
  'anime',
  'extlinks',
] as const;

async function writeBangumi(directory: string, people: readonly Record<string, unknown>[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    subject: families.map(({ id, name }) => ({ id, name, type: 2 })),
    'subject-persons': fixturePeople.map((person) => ({ subject_id: 101, person_id: person.id, position: 1 })),
    person: [...people],
  };
  for (const table of bangumiTables) {
    const body = (tables[table] ?? []).map((row) => JSON.stringify(row)).join('\n');
    await writeFile(join(directory, `${table}.jsonlines`), body ? `${body}\n` : '');
  }
}

async function writeVndb(directory: string) {
  await mkdir(join(directory, 'db'), { recursive: true });
  for (const table of vndbTables) {
    const header =
      table === 'vn_titles'
        ? 'id\tlang\ttitle\tlatin\tofficial'
        : table === 'vn'
          ? 'id\tolang\talias'
          : table === 'entry_meta'
            ? 'id\trevision\tlastmod'
            : 'id';
    const body =
      table === 'vn_titles'
        ? families.map(({ vndb, title }) => `${vndb}\tja\t${title}\t${title}\tt`).join('\n')
        : table === 'vn'
          ? families.map(({ vndb }) => `${vndb}\tja\t\\N`).join('\n')
          : table === 'entry_meta'
            ? families.map(({ vndb }) => `${vndb}\t1\t2026-11-01`).join('\n')
            : '';
    await writeFile(join(directory, 'db', `${table}.header`), `${header}\n`);
    await writeFile(join(directory, 'db', table), body ? `${body}\n` : '');
  }
}

function commands(runtime: Awaited<ReturnType<typeof openApiRuntime>>, from = 0) {
  return runtime.captures.slice(from).flatMap((capture) => {
    if (!new URL(capture.request.url).pathname.endsWith('/subjects:batchWrite')) return [];
    return (JSON.parse(capture.body) as { commands: BatchCommand[] }).commands;
  });
}

async function candidates(editor: Awaited<ReturnType<typeof openApiObserver>>, id: string, property: string) {
  const response = await editor.http(
    `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
  );
  expect(response.status).toBe(200);
  return response.body.candidates as {
    id: string;
    source: {
      source: string;
      external_id: string;
      record_revision: string;
      digest: string;
      converter_revision: string;
      field_group: string;
    } | null;
    statement: {
      value: { content: unknown };
      references?: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
    };
  }[];
}

function readSubjectId(result: Awaited<ReturnType<typeof seedCrossMedia>>, externalId: string) {
  const value = result.readings.find((reading) => reading.externalId === externalId)?.subject as
    | { subject?: { id?: string } }
    | undefined;
  const id = value?.subject?.id;
  if (!id) throw new Error(`Missing public subject binding for ${externalId}`);
  return id;
}

function importerTransport(port: CrossMediaPort): ImportTransport {
  return {
    batchWrite: (request) => port.batch(request),
    setSourceRecordMetadata: (request, signal) => port.setSourceRecordMetadata(request, signal),
    readFence: (tuple) => port.fence(tuple),
    writeSourceStatistic: (request, signal) => port.writeSourceStatistic(request, signal),
    clearSourceStatistic: (request, signal) => port.clearSourceStatistic(request, signal),
  };
}

test('authored Bangumi JSON-lines biographies are adopted and read on Person and Organization, refresh by digest, and respect the summary fence', async () => {
  // Every source row is authored fixture data, not observed pinned dump evidence.
  const repositoryTemp = resolve(import.meta.dir, '../../../../.temp');
  await mkdir(repositoryTemp, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(repositoryTemp, 'bangumi-people-biography-'));
  const bangumiDirectory = join(fixtureDirectory, 'bangumi');
  const vndbDirectory = join(fixtureDirectory, 'vndb');
  const stateDirectory = await mkdtemp(join(tmpdir(), 'bangumi-people-biography-state-'));
  const statePath = join(stateDirectory, 'state.sqlite');
  await mkdir(bangumiDirectory, { recursive: true });
  await writeBangumi(bangumiDirectory, fixturePeople);
  await writeVndb(vndbDirectory);

  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const loadPlan = () => planCrossMediaSeed(new CrossMediaDumpFiles(bangumiDirectory, vndbDirectory));
    const plan = await loadPlan();
    expect(plan.members).toContainEqual(
      expect.objectContaining({ source: 'bangumi', key: 'person:8101', kind: 'person', membership: 'referenced' }),
    );
    expect(plan.credits.some((credit) => credit.person === 'person:8101' && credit.work === '101')).toBe(true);

    const currentRegistration = createSourceRegistration('bangumi', { source: alias });
    const legacyRegistration: SourceRegistration = {
      ...currentRegistration,
      converter_revision: 'cross-media-entities@3',
      convert(input, context) {
        const record = Object.fromEntries(
          Object.entries(input.record as Record<string, unknown>).filter(([key]) => key !== 'summary'),
        );
        const converted = convertCrossMediaEntity({ ...input, record }, context, {
          converterRevision: 'cross-media-entities@3',
          sourceKind: 'bangumi',
        });
        return { ...converted, normalized: converted.normalizedRecord, coverAssets: [], mediaImportIntents: [] };
      },
    };
    let loseFirstCreate = true;
    const oldPort: CrossMediaPort = {
      ...runtime.importTransport,
      async batch(request) {
        const result = await runtime.importTransport.batch(request);
        if (
          loseFirstCreate &&
          request.commands.some((command) => command.op === 'create' && command.source.external_id === 'person:8101')
        ) {
          loseFirstCreate = false;
          throw new Error('simulated response loss after the native commit');
        }
        return result;
      },
    };
    const legacyImporter = createImporter({
      path: statePath,
      destination: { origin: 'https://kernel.import.test' },
      transport: importerTransport(oldPort),
    });
    try {
      const oldRecord: SourceRecord = { source: 'bangumi', key: 'person:8101', revision: null, payload: personOne };
      await legacyImporter.runRecords(
        legacyRegistration,
        (async function* () {
          yield oldRecord;
        })(),
      );
    } finally {
      await legacyImporter.close();
    }
    const oldEnvelope = runtime.captures.find((capture) =>
      (JSON.parse(capture.body) as { commands: BatchCommand[] }).commands.some(
        (command) => command.op === 'create' && command.source.external_id === 'person:8101',
      ),
    )?.body;
    expect(oldEnvelope).toBeDefined();
    const oldCommand = (JSON.parse(oldEnvelope!) as { commands: BatchCommand[] }).commands.find(
      (command) => command.op === 'create' && command.source.external_id === 'person:8101',
    );
    expect(oldCommand?.source).toMatchObject({
      record_revision: 'unversioned',
      converter_revision: 'cross-media-entities@3',
    });
    const oldEnvelopeCount = runtime.captures.filter((capture) => capture.body === oldEnvelope).length;

    const runSeed = async () =>
      seedCrossMedia(
        await loadPlan(),
        statePath,
        runtime.importTransport,
        { origin: 'https://kernel.import.test' },
        { providers: ['bangumi'], recordConcurrency: 2 },
      );
    const recovered = await runSeed();
    expect(recovered.runs.bangumi?.status).toBe('committed');
    expect(runtime.captures.filter((capture) => capture.body === oldEnvelope).length).toBeGreaterThan(oldEnvelopeCount);

    const firstRun = await runSeed();
    expect(firstRun.runs.bangumi?.status).toBe('committed');
    const personId = readSubjectId(firstRun, 'person:8101');
    const organizationId = readSubjectId(firstRun, 'person:8102');
    const captured = commands(runtime);
    const biographyCommands = captured.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        command.source.field_group === 'summary' &&
        ['person:8101', 'person:8102'].includes(command.source.external_id),
    );
    expect(biographyCommands.map((command) => command.source.external_id).sort()).toEqual([
      'person:8101',
      'person:8102',
    ]);
    expect(biographyCommands.every((command) => command.source.converter_revision === converter_revision)).toBe(true);
    expect(
      captured.some(
        (command) =>
          command.op === 'propose' &&
          command.source.field_group === 'summary' &&
          ['person:8103', 'person:8104'].includes(command.source.external_id),
      ),
    ).toBe(false);
    expect(
      captured.some(
        (command) =>
          command.op === 'create' &&
          command.source.external_id === 'person:8101' &&
          command.subject.type === 'schema:Person',
      ),
    ).toBe(true);
    expect(
      captured.some(
        (command) =>
          command.op === 'create' &&
          command.source.external_id === 'person:8102' &&
          command.subject.type === 'schema:Organization',
      ),
    ).toBe(true);
    const personBiography = biographyCommands.find((command) => command.source.external_id === 'person:8101');
    if (!personBiography) throw new Error('Missing Person biography command');
    expect(personBiography.rights).toEqual({
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Bangumi contributors (https://bgm.tv/person/8101)',
    });
    const sentBiography = personBiography.statement.value.content as {
      language: string;
      document: { doc: { content: { content?: { text: string }[] }[] } };
    };
    expect(sentBiography.language).toBe('und');
    expect(sentBiography.document.doc.content[0]?.content?.[0]?.text).toBe(personOne.summary);
    expect(personBiography.statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/person/8101' },
    });

    for (const [id, expected] of [
      [personId, personOne.summary],
      [organizationId, organization.summary],
    ] as const) {
      const candidatesForBiography = await candidates(editor, id, 'schema:abstract');
      expect(candidatesForBiography).toHaveLength(1);
      const candidate = candidatesForBiography[0]!;
      const content = candidate.statement.value.content as {
        language: string;
        id?: string;
        document?: string;
      };
      expect(content.language).toBe('und');
      await editor.adoptSubject(id, 'schema:abstract', content as unknown as Json, globalContext);
      const source = candidate.source;
      if (!source) throw new Error('Missing public biography attribution');
      const proposal: Proposal = {
        id: candidate.id,
        subjectId: id,
        source: source.source as Proposal['source'],
        externalId: source.external_id,
        recordRevision: source.record_revision,
        recordDigest: source.digest,
        converterRevision: source.converter_revision,
        fieldGroup: source.field_group,
        kind: 'value',
        statement: candidate.statement as unknown as Statement,
        references: candidate.statement.references ?? [],
      };
      expect(proposal.references[0]?.parts).toContainEqual({
        property: { id: 'schema:url' },
        value: { type: 'value', content: `https://bgm.tv/person/${id === personId ? '8101' : '8102'}` },
      });
      const storedDocument = await editor.document(proposal);
      expect(storedDocument.response.status).toBe(200);
      expect(storedDocument.semantic.language).toBe('und');
      expect(storedDocument.stored.rights).toEqual({
        license: 'CC-BY-SA-3.0',
        obligations: ['cc:Attribution', 'cc:ShareAlike'],
        attribution: `Bangumi contributors (https://bgm.tv/person/${id === personId ? '8101' : '8102'})`,
      });
      expect(new TextDecoder().decode(storedDocument.response.bytes)).toContain(expected);
      const current = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(current.status).toBe(200);
      const statement = (
        current.body.subject as { statements: Record<string, { value: { content: unknown }; references: unknown[] }[]> }
      ).statements['schema:abstract']?.[0];
      expect(statement?.value.content).toEqual(content);
      expect(JSON.stringify(statement?.references)).toContain(
        `https://bgm.tv/person/${id === personId ? '8101' : '8102'}`,
      );
      const documentId = content.id ?? content.document;
      if (!documentId) throw new Error('Missing public document reference');
      const document = await editor.http(`/v1/documents/${documentId}`);
      expect(document.status).toBe(200);
      expect(JSON.stringify(document.body)).toContain(expected);
    }

    const birthCandidates = await candidates(editor, personId, 'schema:birthDate');
    expect(birthCandidates).toHaveLength(1);
    const birthCandidate = birthCandidates[0]!;
    expect(birthCandidate.statement.value.content).toEqual(personBirthDate);
    expect(birthCandidate.statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/person/8101' },
    });
    await editor.adoptSubject(personId, 'schema:birthDate', birthCandidate.statement.value.content as Json, globalContext);
    const birthRead = await editor.http(`/v1/subjects/${personId}?context=${globalContext}`);
    expect(birthRead.status).toBe(200);
    expect(
      (birthRead.body.subject as { statements: Record<string, { value: { content: unknown } }[]> }).statements[
        'schema:birthDate'
      ]?.[0]?.value.content,
    ).toEqual(personBirthDate);

    const acceptedIds = (await candidates(editor, personId, 'schema:abstract')).map((candidate) => candidate.id);
    const reopened = await runSeed();
    expect(reopened.runs.bangumi?.status).toBe('committed');
    expect(readSubjectId(reopened, 'person:8101')).toBe(personId);
    expect((await candidates(editor, personId, 'schema:abstract')).map((candidate) => candidate.id)).toEqual(
      acceptedIds,
    );

    const selectedBirth = (
      (await editor.http(`/v1/subjects/${personId}?context=${globalContext}`)).body.subject as {
        statements: Record<string, { value: { content: unknown } }[]>;
      }
    ).statements['schema:birthDate']?.[0]?.value.content;
    expect(selectedBirth).toEqual(personBirthDate);

    const changedBiography = { ...personOne, summary: '新しい紹介：別の作品を発表した。' };
    await writeBangumi(bangumiDirectory, [changedBiography, organization, emptyPerson, absentPerson]);
    const changed = await runSeed();
    expect(changed.runs.bangumi?.status).toBe('committed');
    const personCandidates = await candidates(editor, personId, 'schema:abstract');
    expect(personCandidates).toHaveLength(2);
    const changedCommand = commands(runtime).find(
      (command) =>
        command.op === 'propose' &&
        command.source.external_id === 'person:8101' &&
        command.source.field_group === 'summary' &&
        command.source.digest !== personBiography.source.digest,
    );
    expect(changedCommand?.op).toBe('propose');
    if (changedCommand?.op !== 'propose') throw new Error('Missing changed biography proposal');
    expect(changedCommand.source.digest).not.toBe(personBiography.source.digest);
    const changedCandidate = personCandidates.find((candidate) => candidate.id !== acceptedIds[0]);
    if (!changedCandidate) throw new Error('Missing changed public biography');
    await editor.adoptSubject(
      personId,
      'schema:abstract',
      changedCandidate.statement.value.content as Json,
      globalContext,
    );
    const changedContent = changedCandidate.statement.value.content as { id?: string; document?: string };
    const changedDocumentId = changedContent.id ?? changedContent.document;
    if (!changedDocumentId) throw new Error('Missing refreshed document reference');
    const changedDocument = await editor.http(`/v1/documents/${changedDocumentId}`);
    expect(changedDocument.status).toBe(200);
    expect(JSON.stringify(changedDocument.body)).toContain(changedBiography.summary);

    await editor.takedown(alias, 'person:8101', 'summary');
    await writeBangumi(bangumiDirectory, [
      { ...changedBiography, name: '星見 改訂', summary: '受け取られない再掲載：概要の取り下げ後。' },
      organization,
      emptyPerson,
      absentPerson,
    ]);
    const fenceCaptureStart = runtime.captures.length;
    const fenced = await runSeed();
    expect(fenced.runs.bangumi?.status).toBe('committed');
    expect(readSubjectId(fenced, 'person:8101')).toBe(personId);
    const fencedCommands = commands(runtime, fenceCaptureStart);
    const fencedFacts = fencedCommands.find(
      (command) =>
        command.op === 'propose' &&
        command.source.external_id === 'person:8101' &&
        command.source.field_group === 'facts' &&
        command.statement.property.id === 'schema:name' &&
        command.source.digest !== changedCommand.source.digest,
    );
    expect(fencedFacts?.op).toBe('propose');
    if (!fencedFacts || fencedFacts.op !== 'propose') throw new Error('Facts did not refresh behind the summary fence');
    expect(fencedFacts.statement.value.content).toEqual({ language: 'und', text: '星見 改訂' });
    expect(
      fencedCommands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'person:8101' &&
          command.source.field_group === 'summary' &&
          command.source.digest !== changedCommand.source.digest,
      ),
    ).toBe(false);
    const stillBound = await editor.http(`/v1/subjects/${personId}?context=${globalContext}`);
    expect(stillBound.status).toBe(200);
    expect((await editor.http(`/v1/documents/${changedDocumentId}`)).status).toBe(404);
    expect(
      (await candidates(editor, personId, 'wdt:P6298')).some((candidate) =>
        JSON.stringify(candidate.statement.value.content).includes('8101'),
      ),
    ).toBe(true);
  } finally {
    await runtime.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 300_000);
