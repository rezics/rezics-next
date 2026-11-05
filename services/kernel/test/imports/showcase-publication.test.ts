import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import {
  seedCrossMedia,
  planCrossMediaSeed,
  crossMediaAliases,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

test('local publication accepts only its acknowledged plan after authorization and verifies it through an anonymous read', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-publication-native-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const tables: CrossMediaTables = {
      async *rows(provider, table) {
        if (provider === 'bangumi' && table === 'subject') yield { id: 101, name: 'STEINS;GATE', type: 2 };
      },
    };
    const plan = await planCrossMediaSeed(tables);
    const result = await seedCrossMedia(
      plan,
      join(directory, 'import.sqlite'),
      captureShowcaseCommands(runtime.importTransport, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'] },
    );
    const workId = result.readings[0]!.subject.subject!.id!;
    const editor = await openApiObserver(runtime);
    const selectedPage = await runtime.importTransport.reviewedCandidates(workId, {
      property: 'schema:name',
      context: globalContext,
      limit: 100,
    });
    const selectedName = selectedPage.candidates.find((candidate) => candidate.source?.external_id === '101');
    if (!selectedName) throw new Error('Selected source name candidate is missing');
    const unrelated = await editor.http(`/v1/subjects/${workId}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Unrelated title' } },
        references: selectedName.statement.references,
      },
    });
    expect(unrelated.status).toBe(201);
    const unrelatedId = (unrelated.body as { candidate: string }).candidate;
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    expect(
      (await publicClient.readSubject(workId).then((read) => read.subject as { statements: Record<string, unknown[]> }))
        .statements['schema:name'],
    ).toBeUndefined();

    const first = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(first.status).toBe('incomplete');
    const acknowledged = journal.acknowledgedCommands().filter((entry) => entry.candidateId);
    expect(acknowledged.length).toBeGreaterThan(0);
    expect(
      await runtime.importTransport
        .reviewedCandidates(workId, {
          property: 'schema:name',
          context: globalContext,
          limit: 100,
        })
        .then((page) => page.adoption?.selection?.map((entry) => entry.candidate)),
    ).toBeUndefined();

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    expect(
      journal
        .acknowledgedCommands()
        .filter((entry) => entry.candidateId)
        .map((entry) => entry.candidateId),
    ).toEqual(acknowledged.map((entry) => entry.candidateId));

    const published = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(published.status).toBe('published');
    const publicRead = await publicClient.readSubject(workId);
    const subject = publicRead.subject as { id: string; type: string; statements: Record<string, BatchStatement[]> };
    expect(subject.id).toBe(workId);
    expect(subject.type).toBe(published.manifest.records[0]?.nativeType);
    const expected = published.manifest.records[0]!.assertions.map(({ property, statement }) => ({
      property,
      value: statement.value.content,
    }));
    const actual = expected.map(({ property }) => ({
      property,
      value: subject.statements[property]?.map((statement) => statement.value.content),
    }));
    for (const fact of expected)
      expect(actual.find((row) => row.property === fact.property)?.value).toContain(fact.value);
    const after = await runtime.importTransport.reviewedCandidates(workId, {
      property: 'schema:name',
      context: globalContext,
      limit: 100,
    });
    expect(after.adoption?.selection?.some((entry) => entry.candidate === unrelatedId)).toBe(false);
    expect(runtime.captures.some((capture) => capture.request.url.endsWith(`/candidates/${unrelatedId}:accept`))).toBe(
      false,
    );
    expect(published.published.map((record) => record.subjectId)).toEqual([workId]);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('selected VNDB prequel relation reopens exactly and reports publication only after current public readback', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-relations-native-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider !== 'vndb') return;
      if (table === 'vn_titles') {
        yield { id: 'v4', lang: 'en', official: 't', title: 'CLANNAD', latin: null };
        yield { id: 'v7983', lang: 'en', official: 't', title: 'Clannad -The Past Path-', latin: null };
      }
      if (table === 'vn') {
        for (const id of ['v4', 'v7983']) yield { id, olang: 'ja', alias: null };
      }
      if (table === 'entry_meta') {
        for (const id of ['v4', 'v7983']) yield { id, revision: '1', lastmod: '2026-10-25 00:00:00+00' };
      }
      if (table === 'vn_relations')
        yield { id: 'v4', vid: 'v7983', relation: 'preq', official: 't' };
    },
  };
  const plan = await planCrossMediaSeed(tables, {
    selection: { bangumi: [51], vndb: ['v4', 'v7983'], includeReleases: false },
  });
  const edge = plan.edges.find((draft) => draft.source === 'vndb' && draft.table === 'vn_relations')!;
  expect(edge).toMatchObject({ holder: 'v7983', target: 'v4', property: 'wdt:P155' });
  const importPath = join(directory, 'import.sqlite');
  const seed = () =>
    seedCrossMedia(
      plan,
      importPath,
      captureShowcaseCommands(runtime.importTransport, journal),
      { origin: runtime.origin },
      { providers: ['vndb'] },
    );
  const publicClient = createPublicBulkClient({
    origin: runtime.origin,
    fetch: async (input) => {
      const url = new URL(String(input));
      return runtime.request(`${url.pathname}${url.search}`);
    },
  });

  try {
    const first = await seed();
    const relation = first.vndbWorkRelations[0]!;
    expect(relation).toMatchObject({
      sourceRecordKey: 'v4',
      relatedRecordKey: 'v7983',
      holderKey: 'v7983',
      targetKey: 'v4',
      property: 'wdt:P155',
      delivery: 'acknowledged',
      publication: 'pending',
      fields: expect.arrayContaining(['vn_relations.id', 'vn_relations.vid', 'vn_relations.relation', 'vn_relations.official']),
      citation: 'https://vndb.org/v7983',
    });
    const candidate = journal
      .acknowledgedCommands()
      .find((entry) => entry.command.op === 'propose' && entry.command.statement.property.id === 'wdt:P155')!;
    if (candidate.command.op !== 'propose') throw new Error('Expected an acknowledged work relation candidate');
    expect(candidate.candidateId).toBe(relation.candidateId);
    expect(candidate.command).toMatchObject({
      subject: relation.holderSubjectId,
      statement: {
        value: { type: 'value', content: relation.targetSubjectId },
        references: [
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/v7983' } }] },
        ],
      },
    });
    const relationSends = () => runtime.captures.filter((capture) => capture.body.includes(candidate.command.key)).length;
    const sendsBeforeReopen = relationSends();
    expect(sendsBeforeReopen).toBeGreaterThan(0);

    const editor = await openApiObserver(runtime);
    const refused = await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(refused.status).toBe('incomplete');
    expect(refused.vndbWorkRelations[0]).toMatchObject({ delivery: 'acknowledged', publication: 'withheld' });

    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const unavailableTargetClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/${relation.targetSubjectId}`))
          return Response.json({ title: 'Unavailable' }, { status: 503 });
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const withheld = await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient: unavailableTargetClient,
    });
    expect(withheld.status).toBe('incomplete');
    expect(withheld.vndbWorkRelations[0]).toMatchObject({ delivery: 'acknowledged', publication: 'withheld' });

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const reopened = await seed();
    expect(reopened.vndbWorkRelations).toEqual(first.vndbWorkRelations);
    expect(relationSends()).toBe(sendsBeforeReopen);
    const published = await publishShowcase({
      plan,
      result: reopened,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(published.status).toBe('published');
    expect(published.vndbWorkRelations[0]).toMatchObject({
      delivery: 'acknowledged',
      publication: 'published',
      candidateId: relation.candidateId,
      holderSubjectId: relation.holderSubjectId,
      targetSubjectId: relation.targetSubjectId,
    });
    const publicHolder = await publicClient.readSubject(relation.holderSubjectId!);
    const statement = (publicHolder.subject as { statements: Record<string, BatchStatement[]> }).statements['wdt:P155']?.[0];
    expect(statement).toMatchObject({
      value: { type: 'value', content: relation.targetSubjectId },
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/v7983' } }] },
      ],
    });
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
