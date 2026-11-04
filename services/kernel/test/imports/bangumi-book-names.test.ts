import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { crossMediaAliases, emptyCrossMediaPlan, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const externalId = '990411';
const record = (aliasState: 'malformed' | 'corrected' | 'fenced') => ({
  id: Number(externalId),
  type: 1,
  name: 'STEINS;GATE',
  name_cn: 'Top-level Chinese title',
  infobox: `{{Infobox animanga/Book
|中文名=Source Chinese title
|别名=${aliasState === 'malformed' ? 'Scalar title' : ''}
${aliasState === 'malformed' ? '* Must not leak\n' : `* ${aliasState === 'corrected' ? 'New alias' : 'Fenced alias'}\n`}|作者=Source author
}}`,
});

async function planFor(source: ReturnType<typeof record>) {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: externalId, revision: null, payload: source });
  return plan;
}

function titleValues(statements: readonly BatchStatement[] | undefined) {
  return (statements ?? [])
    .flatMap((statement) =>
      statement.value.type === 'value' &&
      statement.value.content &&
      typeof statement.value.content === 'object' &&
      'text' in statement.value.content
        ? [statement.value.content as { language: string; text: string }]
        : [],
    )
    .sort((left, right) => `${left.language}\u0000${left.text}`.localeCompare(`${right.language}\u0000${right.text}`));
}

function hasTitleCandidate(candidates: readonly { statement: BatchStatement }[], language: string, text: string) {
  return candidates.some(
    (candidate) =>
      candidate.statement.value.type === 'value' &&
      JSON.stringify(candidate.statement.value.content) === JSON.stringify({ language, text }),
  );
}

test('Book names move through explicit publication and same-UUID refresh without restoring fenced facts', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-book-native-'));
  const importPath = join(directory, 'imports.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const editor = await openApiObserver(runtime);
  const publicClient = createPublicBulkClient({
    origin: runtime.origin,
    fetch: async (input) => {
      const url = new URL(String(input));
      return runtime.request(`${url.pathname}${url.search}`);
    },
  });
  const seed = async (state: 'malformed' | 'corrected' | 'fenced') => {
    const plan = await planFor(record(state));
    const result = await seedCrossMedia(
      plan,
      importPath,
      captureShowcaseCommands(runtime.importTransport, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'] },
    );
    return { plan, result };
  };

  try {
    const first = await seed('malformed');
    expect(first.result.runs.bangumi?.status).toBe('committed');
    const id = first.result.readings[0]!.subject.subject!.id!;
    expect(first.result.readings[0]!.subject.subject!.type).toBe('schema:Book');
    const firstPage = await runtime.importTransport.reviewedCandidates(id, {
      property: 'schema:name',
      context: GLOBAL_CONTEXT,
      limit: 100,
    });
    expect(firstPage.candidates.map((candidate) => candidate.statement.value.content)).toContainEqual({
      language: 'zh',
      text: 'Source Chinese title',
    });
    expect(
      firstPage.candidates.some((candidate) =>
        JSON.stringify(candidate.statement.value.content).includes('Must not leak'),
      ),
    ).toBe(false);
    expect(
      await runtime.importTransport
        .reviewedCandidates(id, { property: 'schema:alternateName', context: GLOBAL_CONTEXT, limit: 100 })
        .then((page) => page.candidates),
    ).toEqual([]);

    const notAuthorized = await publishShowcase({
      plan: first.plan,
      result: first.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(notAuthorized.status).toBe('incomplete');
    expect((await publicClient.readSubject(id)).subject?.type).toBe('schema:Book');
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const published = await publishShowcase({
      plan: first.plan,
      result: first.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(published.status).toBe('published');
    expect(runtime.captures.some((capture) => capture.request.url.includes(':accept'))).toBe(true);
    expect(runtime.captures.some((capture) => capture.request.url.endsWith(':adopt'))).toBe(true);
    const adopted = await publicClient.readSubject(id);
    const publicSubject = adopted.subject as { id: string; type: string; statements: Record<string, BatchStatement[]> };
    expect(publicSubject.id).toBe(id);
    expect(titleValues(publicSubject.statements['schema:name'])).toEqual([
      { language: 'und', text: 'STEINS;GATE' },
      { language: 'zh', text: 'Source Chinese title' },
      { language: 'zh', text: 'Top-level Chinese title' },
    ]);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const corrected = await seed('corrected');
    expect(corrected.result.readings[0]!.subject.subject!.id).toBe(id);
    expect(corrected.result.runs.bangumi?.counts.changed).toBe(1);
    const correctedCandidates = await runtime.importTransport.reviewedCandidates(id, {
      property: 'schema:name',
      context: GLOBAL_CONTEXT,
      limit: 100,
    });
    expect(hasTitleCandidate(correctedCandidates.candidates, 'und', 'New alias')).toBe(true);
    expect(
      titleValues((await publicClient.readSubject(id)).subject?.statements?.['schema:name'] as BatchStatement[]),
    ).toEqual(titleValues(publicSubject.statements['schema:name']));

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId,
      fieldGroup: 'facts',
      reason: 'Book title facts refresh fence',
    });
    expect(fence.status).toBe(200);
    const fenced = await seed('fenced');
    expect(fenced.result.readings[0]!.subject.subject!.id).toBe(id);
    const afterFence = await runtime.importTransport.reviewedCandidates(id, {
      property: 'schema:name',
      context: GLOBAL_CONTEXT,
      limit: 100,
    });
    expect(
      afterFence.candidates.some((candidate) =>
        JSON.stringify(candidate.statement.value.content).includes('Fenced alias'),
      ),
    ).toBe(false);
    expect(
      titleValues((await publicClient.readSubject(id)).subject?.statements?.['schema:name'] as BatchStatement[]),
    ).toEqual(titleValues(publicSubject.statements['schema:name']));
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
