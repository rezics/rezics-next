import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { seedCrossMedia, planCrossMediaSeed, crossMediaAliases, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { captureShowcaseCommands, publishShowcase, ShowcaseJournal } from '../../../importer/src/showcase-publication.ts';
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
    expect(await runtime.importTransport.reviewedCandidates(workId, {
      property: 'schema:name', context: globalContext, limit: 100,
    }).then((page) => page.adoption?.selection?.map((entry) => entry.candidate))).toBeUndefined();

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    expect(journal.acknowledgedCommands().filter((entry) => entry.candidateId).map((entry) => entry.candidateId))
      .toEqual(acknowledged.map((entry) => entry.candidateId));

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
    for (const fact of expected) expect(actual.find((row) => row.property === fact.property)?.value).toContain(fact.value);
    const after = await runtime.importTransport.reviewedCandidates(workId, {
      property: 'schema:name', context: globalContext, limit: 100,
    });
    expect(after.adoption?.selection?.some((entry) => entry.candidate === unrelatedId)).toBe(false);
    expect(runtime.captures.some((capture) => capture.request.url.endsWith(`/candidates/${unrelatedId}:accept`))).toBe(false);
    expect(published.published.map((record) => record.subjectId)).toEqual([workId]);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
