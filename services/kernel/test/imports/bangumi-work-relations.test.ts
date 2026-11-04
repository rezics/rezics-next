import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphEdgeKey } from '../../../importer/src/cross-media-bindings.ts';
import { planCrossMediaSeed, seedCrossMedia, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
type Candidate = { id: string; head: number | null; statement: { value: { content: unknown }; rank?: 'normal' | 'preferred' } };

function authoredTables(withReciprocal: boolean): CrossMediaTables {
  // Authored operator fixture; these values do not claim observation in a public dump.
  return {
    async *rows(_provider, table) {
      if (table === 'subject') {
        yield { id: 1, type: 2, name: 'STEINS;GATE' };
        yield { id: 2, type: 2, name: 'STEINS;GATE 0' };
        yield { id: 5, type: 6, platform: 6002, name: 'STEINS;GATE live action' };
      }
      if (table === 'subject-relations') {
        yield { subject_id: 1, related_subject_id: 2, relation_type: 12 };
        if (withReciprocal) yield { subject_id: 2, related_subject_id: 1, relation_type: 6 };
        yield { subject_id: 5, related_subject_id: 1, relation_type: 1 };
      }
      if (table === 'vn_titles') {
        yield { id: 'v1', title: 'STEINS;GATE', official: 't', lang: 'en', latin: null };
        yield { id: 'v2', title: 'CLANNAD', official: 't', lang: 'en', latin: null };
        yield { id: 'v3', title: 'Fate/stay night', official: 't', lang: 'en', latin: null };
      }
      if (table === 'vn') {
        yield { id: 'v1', olang: 'en' };
        yield { id: 'v2', olang: 'en' };
        yield { id: 'v3', olang: 'en' };
      }
      if (table === 'entry_meta') {
        yield { id: 'v1', revision: '1' };
        yield { id: 'v2', revision: '1' };
        yield { id: 'v3', revision: '1' };
      }
    },
  };
}

test('production operator imports reciprocal and one-sided work relations for independent native adoption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-work-relations-'));
  const state = join(directory, 'importer.sqlite');
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const pairedPlan = await planCrossMediaSeed(authoredTables(true));
    const pair = pairedPlan.edges.find((edge) => edge.table === 'subject-relations' && edge.property === 'rezics:sideStoryOf')!;
    expect(pair.relation?.evidence).toHaveLength(2);
    const first = await seedCrossMedia(pairedPlan, state, runtime.importTransport, { origin: 'https://kernel.import.test' });
    expect(first.gaps).toEqual([]);

    const subject = (externalId: string) => {
      const reading = first.readings.find((entry) => entry.source === 'bangumi' && entry.externalId === externalId);
      const id = (reading?.subject as { subject?: { id?: string } } | undefined)?.subject?.id;
      if (!id) throw new Error(`Authored source record ${externalId} was not bound`);
      return id;
    };
    const storyId = subject('1');
    const parentId = subject('2');
    const movieId = subject('5');
    const movieType = (first.readings.find((entry) => entry.externalId === '5')?.subject as { subject?: { type?: string } })
      .subject?.type;
    expect(movieType).toBe('schema:Movie');

    const editor = await openApiObserver(runtime);
    const createdContext = await editor.http('/v1/contexts', { labels: { en: 'Relation review' } });
    expect(createdContext.status).toBe(201);
    const context = (createdContext.body as { context: { id: string } }).context.id;
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: context },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    async function adopt(subjectId: string, property: string, targetId: string) {
      const query = new URLSearchParams({ property, context, limit: '100' });
      const page = await editor.http(`/v1/subjects/${subjectId}/candidates?${query}`);
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidates = listing.candidates.filter((candidate) => candidate.statement.value.content === targetId);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      expect((await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
        context,
        expected_head: candidate.head,
      })).status).toBe(200);
      expect((await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      })).status).toBe(200);
    }

    await adopt(storyId, 'rezics:sideStoryOf', parentId);
    let counterpartHolder: string | undefined;
    let counterpartTarget: string | undefined;
    for (const holder of [movieId, storyId]) {
      const target = holder === movieId ? storyId : movieId;
      const query = new URLSearchParams({ property: 'rezics:crossMediaCounterpart', limit: '100' });
      const page = await editor.http(`/v1/subjects/${holder}/candidates?${query}`);
      expect(page.status).toBe(200);
      const candidates = (page.body as { candidates: Candidate[] }).candidates;
      if (candidates.some((candidate) => candidate.statement.value.content === target)) {
        counterpartHolder = holder;
        counterpartTarget = target;
        break;
      }
    }
    expect(counterpartHolder).toBeDefined();
    expect(counterpartTarget).toBeDefined();
    await adopt(counterpartHolder!, 'rezics:crossMediaCounterpart', counterpartTarget!);
    async function current(subjectId: string, property: string) {
      const query = new URLSearchParams({ context });
      const response = await runtime.request(`/v1/subjects/${subjectId}?${query}`);
      expect(response.status).toBe(200);
      const view = (await response.json()) as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
      return view.subject.statements[property]?.map((statement) => statement.value.content) ?? [];
    }
    expect(await current(storyId, 'rezics:sideStoryOf')).toContain(parentId);
    expect(await current(counterpartHolder!, 'rezics:crossMediaCounterpart')).toContain(counterpartTarget);

    const priorDatabase = new Database(state, { readonly: true });
    const priorBytes = priorDatabase
      .query('SELECT command_payload FROM cross_media_graph WHERE edge_key=?')
      .get(graphEdgeKey(pair)) as { command_payload: string };
    priorDatabase.close();
    const oneSidedPlan = await planCrossMediaSeed(authoredTables(false));
    const changed = oneSidedPlan.edges.find((edge) => edge.table === 'subject-relations' && edge.holder === '1')!;
    expect(changed.property).toBe('wdt:P361');
    const second = await seedCrossMedia(oneSidedPlan, state, runtime.importTransport, { origin: 'https://kernel.import.test' });
    expect(second.gaps).toEqual([]);
    const partOfQuery = new URLSearchParams({ property: 'wdt:P361', context, limit: '100' });
    const partOfPage = await editor.http(`/v1/subjects/${storyId}/candidates?${partOfQuery}`);
    expect(partOfPage.status).toBe(200);
    expect((partOfPage.body as { candidates: Candidate[] }).candidates).toMatchObject([
      { statement: { value: { content: parentId } } },
    ]);
    await adopt(storyId, 'wdt:P361', parentId);
    expect(await current(storyId, 'wdt:P361')).toContain(parentId);
    const reopened = new Database(state, { readonly: true });
    const retainedBytes = reopened
      .query('SELECT command_payload FROM cross_media_graph WHERE edge_key=?')
      .get(graphEdgeKey(pair)) as { command_payload: string };
    expect(retainedBytes.command_payload).toBe(priorBytes.command_payload);
    reopened.close();
    const repeated = await seedCrossMedia(oneSidedPlan, state, runtime.importTransport, { origin: 'https://kernel.import.test' });
    expect(repeated.gaps).toEqual([]);
    expect(await current(storyId, 'wdt:P361')).toContain(parentId);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
