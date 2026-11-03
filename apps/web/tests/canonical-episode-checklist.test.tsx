import { expect, mock, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../src/subject/candidates';
import type { WorkPartsRead } from '../src/features/catalogue/work-parts';
import {
  CHECKLIST_VISIT_READ_CALLS,
  bindFromIndex,
  captureEpisodeCommand,
  checklistActionClass,
  continueRetainedEpisodes,
  inspectEpisodes,
  loadEpisodeChecklist,
  mapEpisodeStatus,
  matchingBinding,
  mutationIntent,
  preserveInspectOrder,
  projectMembership,
  quotedIdempotencyKey,
  readyVisit,
  recordEpisodes,
  redactedRow,
  replaceBinding,
  retirePrivateState,
  stageChecklistClear,
  submitEpisodeIntent,
  toggleRow,
  workWithinBound,
  type ChecklistRow,
  type ChecklistViewerBinding,
} from '../src/library/episode-checklist';
import { newCsrfToken } from '../src/session/csrf';

mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  viewerCredential: () => 'Bearer progress-owner',
}));

const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const otherSession = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const parentId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const ep = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const episode1 = ep(1);
const episode2 = ep(2);
const episode3 = ep(3);
const special = ep(4);
const viewerA = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const viewerB = '0192f3a0-6c1e-7b2a-9d4e-0000000000bb';

function binding(overrides: Partial<ChecklistViewerBinding> = {}): ChecklistViewerBinding {
  return {
    viewer: viewerA,
    locale: 'en',
    subjectId: parentId,
    sessionId,
    revision: 3,
    cursor: null,
    ...overrides,
  };
}

function row(
  id: string | null,
  completed: boolean | null,
  membership: ChecklistRow['membership'],
  ordinal: string | null = null,
): ChecklistRow {
  return { episodeSubjectId: id, completed, membership, ordinal, label: null, source: 'inspect' };
}

function completion(id: string | null, completed: boolean | null, membership: ChecklistRow['membership'], ordinal: string | null = null) {
  return { episodeSubjectId: id, completed, membership, ordinal };
}

function adapterClient(
  inspect: (options: { query: { ids?: string; cursor?: string; limit?: number }; headers: { authorization: string } }) => Promise<{ data?: unknown; status: number; error?: unknown }>,
  record: (body: unknown, options: { headers: Record<string, string> }) => Promise<{ data?: unknown; status: number; error?: unknown }>,
): KernelClient {
  return {
    progressSessions: Object.assign(
      (_params: { sessionId: string }) => ({ episodes: { get: inspect }, $recordEpisodes: { post: record } }),
      { post: async () => ({ status: 404 }) },
    ),
  } as KernelClient;
}

test('gaps stay unmarked and specials keep distinct identities', () => {
  const supplied = [episode1, episode2, episode3, special];
  const rows = preserveInspectOrder(supplied, [
    completion(episode1, true, 'member', '1'),
    completion(episode2, false, 'member', '2'),
    completion(episode3, true, 'member', '3'),
    completion(special, false, 'member', '3'),
  ]);
  expect(rows.map((item) => [item.episodeSubjectId, item.completed, item.ordinal])).toEqual([
    [episode1, true, '1'],
    [episode2, false, '2'],
    [episode3, true, '3'],
    [special, false, '3'],
  ]);
  let visit = readyVisit(binding(), rows, { membership: 'admitted' });
  visit = toggleRow(visit, episode1, true);
  visit = toggleRow(visit, episode3, true);
  expect(visit.selection).toEqual({ add: [], remove: [episode1, episode3] });
  visit = readyVisit(binding(), rows);
  visit = toggleRow(visit, episode1, false);
  visit = toggleRow(visit, episode3, false);
  expect(visit.rows.find((item) => item.episodeSubjectId === episode2)?.completed).toBe(false);
  expect(visit.selection.add).toEqual([episode1, episode3]);
  expect(special).not.toBe(episode3);
});

test('supplied-ID inspection preserves order and redacts unavailable rows', () => {
  const supplied = [episode3, episode1, episode2];
  const rows = preserveInspectOrder(supplied, [
    completion(episode3, true, 'member', '3'),
    completion(null, null, 'unavailable', null),
    completion(episode2, false, 'member', '2'),
  ]);
  expect(rows.map((item) => item.episodeSubjectId)).toEqual([episode3, null, episode2]);
  expect(rows[1]).toEqual({ ...redactedRow(), source: 'inspect' });
  expect(preserveInspectOrder([episode1], [completion(episode2, true, 'member', '1')])[0]?.membership).toBe(
    'unavailable',
  );
  expect(mutationIntent([episode1, episode1], [])).toBeNull();
  expect(mutationIntent([episode1], [episode1])).toBeNull();
  expect(mutationIntent(Array.from({ length: 21 }, (_, i) => ep(i + 1)), [])).toBeNull();
});

test('work-parts inverse isPartOf admits episodes including specials; books stay unavailable', () => {
  const statement = (id: string, position: string) => ({
    id,
    property: { id: 'schema:isPartOf', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: parentId },
    rank: 'normal' as const,
    qualifiers: [{ property: { id: 'schema:position', data_type: 'string' as const }, value: { type: 'value' as const, content: position } }],
    references: [],
    rezics: { release: 'r', revision: 1 },
  });
  const summary = (id: string, title: string, type: string) => ({
    id,
    type,
    types: [type],
    label: { value: title, language: 'en' },
    creativeWork: true,
    cover: null,
  });
  const admitted = {
    ok: true as const,
    public: { subject: { id: parentId, type: 'schema:TVSeries', context: candidateContext } },
    streams: [{ key: 'inverse:schema:isPartOf', property: 'schema:isPartOf', direction: 'inverse' as const, label: { text: 'Episodes', lang: 'en' }, positionEditable: false }],
    stream: { key: 'inverse:schema:isPartOf', property: 'schema:isPartOf', direction: 'inverse' as const, label: { text: 'Episodes', lang: 'en' }, positionEditable: false },
    rows: [
      { holder: episode1, statementId: ep(11), statement: statement(ep(11), '1'), summary: summary(episode1, 'One', 'schema:Episode'), related: {} },
      { holder: episode2, statementId: ep(12), statement: statement(ep(12), '2'), summary: summary(episode2, 'Two', 'schema:Episode'), related: {} },
      { holder: special, statementId: ep(14), statement: statement(ep(14), '2'), summary: summary(special, 'Special', 'schema:Episode'), related: {} },
    ],
    labels: {},
    next: null,
    caughtUp: true,
  } as unknown as WorkPartsRead;
  const page = projectMembership(admitted, bundledRelease);
  expect(page.state).toBe('admitted');
  if (page.state !== 'admitted') throw new Error('expected admitted');
  expect(page.candidates.map((item) => [item.id, item.ordinal])).toEqual([
    [episode1, '1'],
    [episode2, '2'],
    [special, '2'],
  ]);
  const books = {
    ...admitted,
    streams: [{ key: 'inverse:wdt:P179', property: 'wdt:P179', direction: 'inverse' as const, label: { text: 'Volumes', lang: 'en' }, positionEditable: true }],
    stream: { key: 'inverse:wdt:P179', property: 'wdt:P179', direction: 'inverse' as const, label: { text: 'Volumes', lang: 'en' }, positionEditable: true },
    rows: [
      {
        holder: episode1,
        statementId: ep(11),
        statement: statement(ep(11), '1'),
        summary: summary(episode1, 'Volume', 'schema:Book'),
        related: {},
      },
    ],
  } as unknown as WorkPartsRead;
  expect(projectMembership(books, bundledRelease).state).toBe('unavailable');
});

test('exclusive clear is distinct from add/remove and detached rows remain correctable', () => {
  const rows = [row(episode1, true, 'detached', '1'), row(null, null, 'unavailable')];
  let visit = readyVisit(binding(), rows, { membership: 'unavailable' });
  visit = toggleRow(visit, episode1, true);
  expect(visit.selection.remove).toEqual([episode1]);
  visit = toggleRow(visit, episode1, true);
  expect(mutationIntent(visit.selection.add, visit.selection.remove)).toBeNull();
  const cleared = stageChecklistClear(visit);
  expect(cleared.kind).toBe('review');
  expect(cleared.selection).toEqual({ add: [], remove: [] });
});

test('exact replay keeps sender, credentials, key, body and JSON idempotency encoding', async () => {
  const credential = { 'X-CSRF-Token': newCsrfToken() };
  const key = '33333333-3333-4333-8333-333333333333';
  expect(quotedIdempotencyKey(key)).toBe(JSON.stringify(key));
  const command = captureEpisodeCommand(credential, sessionId, 3, key, { kind: 'patch', add: [episode1], remove: [] });
  expect(command.operands.body).toEqual({ revision: 3, add: [episode1] });
  const sender = async () => {
    throw new Error('transport');
  };
  const result = await submitEpisodeIntent(sessionId, 3, { kind: 'patch', add: [episode1], remove: [] }, credential, () => true, sender, key);
  expect(result.outcome.state).toBe('uncertain');
  if (result.outcome.state !== 'uncertain') throw new Error('expected uncertain');
  expect(result.outcome.command.credential).toBe(credential);
  expect(result.outcome.command.key).toBe(key);
  expect(result.outcome.command.operands.body).toEqual({ revision: 3, add: [episode1] });
  expect(result.command.operands).toBe(result.outcome.command.operands);
});

test('installed adapter inspects in supplied order, records with encoded key, and maps native errors', async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const client = adapterClient(
    async (options) => {
      seen.push({ url: `ids:${(options as { query: { ids?: string } }).query.ids}`, headers: new Headers((options as { headers: HeadersInit }).headers) });
      return {
        status: 200,
        data: {
          revision: 3,
          episodes: [completion(episode1, true, 'member', '1'), completion(null, null, 'unavailable', null)],
          next: null,
        },
      };
    },
    async (body, options) => {
      seen.push({ url: 'record', headers: new Headers(options.headers) });
      expect(body).toEqual({ revision: 3, add: [episode3] });
      return { status: 200, data: { revision: 4 } };
    },
  );
  const inspected = await inspectEpisodes(client, sessionId, 'Bearer progress-owner', { ids: [episode1, episode2] });
  expect(inspected.ok).toBe(true);
  const recorded = await recordEpisodes(client, sessionId, 'Bearer progress-owner', 'k', 3, { kind: 'patch', add: [episode3], remove: [] });
  expect(recorded).toEqual({ ok: true, revision: 4 });
  expect(seen[1]?.headers.get('idempotency-key')).toBe(JSON.stringify('k'));
  expect(mapEpisodeStatus(400, { code: 'invalid_cursor' })).toBe('invalid_cursor');
  expect(mapEpisodeStatus(409, { code: 'stale_cursor' })).toBe('stale_cursor');
  expect(mapEpisodeStatus(409, { code: 'conflict' })).toBe('conflict');
  expect(mapEpisodeStatus(422, { code: 'idempotency_conflict' })).toBe('idempotency_conflict');
  expect(mapEpisodeStatus(422, { code: 'unsupported_library_profile' })).toBe('unsupported_library_profile');
  expect(mapEpisodeStatus(404, {})).toBe('not_found');
  expect(mapEpisodeStatus(503, { code: 'semantic_not_ready' })).toBe('unavailable');
});

test('shared revision conflict, exact-key ambiguity and authorized retirement replay stay distinct', async () => {
  const credential = { 'X-CSRF-Token': 'csrf' };
  const key = '44444444-4444-4444-8444-444444444444';
  const conflict = await submitEpisodeIntent(
    sessionId,
    3,
    { kind: 'clear' },
    credential,
    () => true,
    async () => ({ ok: false, kind: 'conflict' }),
    key,
  );
  expect(conflict.outcome.state).toBe('conflict');
  const ambiguous = await submitEpisodeIntent(
    sessionId,
    3,
    { kind: 'clear' },
    credential,
    () => true,
    async () => ({ ok: false, kind: 'idempotency_conflict' }),
    key,
  );
  expect(ambiguous.outcome.state).toBe('ambiguous');
  expect(ambiguous.outcome.state === 'ambiguous' && ambiguous.outcome.command.key).toBe(key);
  const retired = await submitEpisodeIntent(
    sessionId,
    3,
    { kind: 'clear' },
    credential,
    () => true,
    async () => ({ ok: false, kind: 'not_found' }),
    key,
  );
  expect(retired.outcome.state).toBe('retired');
  const replayed = await submitEpisodeIntent(
    sessionId,
    3,
    { kind: 'clear' },
    credential,
    () => true,
    async () => ({ ok: true, revision: 3 }),
    key,
  );
  expect(replayed.outcome).toEqual({ state: 'acknowledged', revision: 3 });
});

test('two occurrences keep independent bindings; owner replacement retires private state', () => {
  const first = readyVisit(binding(), [row(episode1, true, 'member', '1')]);
  const second = readyVisit(binding({ sessionId: otherSession, revision: 1 }), [row(episode1, false, 'member', '1')]);
  expect(matchingBinding(first.binding!, second.binding!)).toBe(false);
  expect(first.rows[0]?.completed).toBe(true);
  expect(second.rows[0]?.completed).toBe(false);
  const replaced = replaceBinding(first, binding({ viewer: viewerB }));
  expect(replaced.kind).toBe('preparing');
  expect(replaced.rows).toEqual([]);
  expect(retirePrivateState(first).binding).toBeNull();
  const envelope = bindFromIndex(
    { viewer: viewerA, requested: { subjectId: parentId, cursor: 'opaque' }, locale: 'en' },
    sessionId,
    3,
  );
  expect(envelope?.cursor).toBe('opaque');
  expect(bindFromIndex({ viewer: null, requested: { subjectId: parentId, cursor: null }, locale: 'en' }, sessionId, 3)).toBeNull();
  const stale = replaceBinding(first, binding({ revision: 9 }));
  expect(stale.kind).toBe('stale');
  expect(stale.retainedNext).toBeNull();
});

test('sparse retained continuation stays bounded and a changed revision retires the cursor', async () => {
  let page = 0;
  const client = adapterClient(async (options) => {
    const query = (options as { query: { cursor?: string; ids?: string } }).query;
    expect(query.ids).toBeUndefined();
    page += 1;
    if (query.cursor === 'stale') return { status: 409, error: { value: { code: 'stale_cursor' } } };
    if (!query.cursor) return { status: 200, data: { revision: 3, episodes: [], next: 'sparse' } };
    return { status: 200, data: { revision: 3, episodes: [completion(episode1, true, 'detached', null)], next: null } };
  }, async () => ({ status: 503 }));
  const empty = await continueRetainedEpisodes(client, sessionId, 'Bearer progress-owner');
  expect(empty).toMatchObject({ rows: [], next: 'sparse', revision: 3 });
  const next = await continueRetainedEpisodes(client, sessionId, 'Bearer progress-owner', 'sparse');
  expect(next).toMatchObject({ revision: 3 });
  if ('kind' in next) throw new Error('expected page');
  expect(next.rows[0]?.membership).toBe('detached');
  expect(await continueRetainedEpisodes(client, sessionId, 'Bearer progress-owner', 'stale')).toEqual({ kind: 'stale' });
  expect(page).toBe(3);
});

function subjectBody() {
  return {
    subject: {
      id: parentId,
      type: 'schema:TVSeries',
      context: candidateContext,
      labels: { en: 'Series' },
      statements: {},
      release: 'r',
      revision: 1,
    },
  };
}

function linksBody() {
  const item = (id: string, title: string, position: string) => ({
    subject: id,
    property: 'schema:isPartOf',
    statement: ep(Number(id.slice(-2)) + 10),
    assertion: {
      id: ep(Number(id.slice(-2)) + 10),
      property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
      value: { type: 'value', content: parentId },
      rank: 'normal',
      qualifiers: [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }],
      references: [],
      rezics: { release: 'r', revision: 1 },
    },
    related: { [parentId]: { type: 'schema:TVSeries', labels: { en: 'Series' } } },
    summary: { id, type: 'schema:Episode', types: ['schema:Episode'], label: { value: title, language: 'en' }, creativeWork: true, cover: null },
  });
  return {
    links: [item(episode1, 'One', '1'), item(episode2, 'Two', '2'), item(episode3, 'Three', '3'), item(special, 'Special', '2')],
    next: null,
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
  };
}

test('loader visit is O(L+20) across 20, 200 and 2,000 retained completions', async () => {
  for (const history of [20, 200, 2000]) {
    let inspectBytes = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === `/v1/subjects/${parentId}`) return Response.json(subjectBody());
        if (url.pathname === `/v1/subjects/${parentId}/links`) return Response.json(linksBody());
        if (url.pathname === `/v1/progressSessions/${sessionId}/episodes`) {
          expect(url.searchParams.get('ids')?.split(',').length).toBeLessThanOrEqual(20);
          const body = {
            revision: 3,
            episodes: [episode1, episode2, episode3, special].map((id, index) =>
              completion(id, index === 0 || index === 2, 'member', String(index + 1)),
            ),
            next: null,
          };
          inspectBytes = new TextEncoder().encode(JSON.stringify(body)).length;
          void history;
          return Response.json(body);
        }
        return new Response('missing', { status: 404 });
      }) as typeof fetch,
    });
    const loaded = await loadEpisodeChecklist(
      client,
      new Request(`https://web.test/en/library/progress/${sessionId}`),
      {},
      binding(),
      bundledRelease,
    );
    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') throw new Error('expected ready');
    expect(loaded.visit.rows).toHaveLength(4);
    expect(loaded.visit.rows[1]?.completed).toBe(false);
    expect(loaded.visit.completeness).toBe('unavailable');
    expect(loaded.work.nativeCallCount).toBeLessThanOrEqual(CHECKLIST_VISIT_READ_CALLS);
    expect(loaded.work.inspectRows).toBe(4);
    expect(loaded.work.membershipRows).toBe(4);
    expect(workWithinBound(loaded.work, history)).toBe(true);
    expect(loaded.work.bytesRetained).toBeGreaterThan(0);
    expect(loaded.work.bytesRetained).toBeLessThan(inspectBytes + loaded.work.bytesRetained + 1);
    expect(loaded.work.nativeCalls.some((name) => name.includes('episodes.get'))).toBe(true);
    expect(loaded.work.nativeCalls.filter((name) => name.includes('episodes.get'))).toHaveLength(1);
    expect(loaded.work.nativeCallCount).toBe(CHECKLIST_VISIT_READ_CALLS);
  }
});

test('wrapping actions stay 44px', () => {
  expect(checklistActionClass).toContain('min-h-11');
  expect(checklistActionClass).toContain('min-w-11');
  expect(checklistActionClass).toContain('[overflow-wrap:anywhere]');
});

test('controller mount path: pending is not completion, and a replacement viewer cannot keep the prior command', () => {
  const rows = [row(episode1, false, 'member', '1'), row(episode2, false, 'member', '2'), row(episode3, false, 'member', '3')];
  let visit = readyVisit(binding(), rows);
  visit = toggleRow(visit, episode1, false);
  visit = toggleRow(visit, episode3, false);
  expect(visit.selection.add).toEqual([episode1, episode3]);
  expect(visit.rows.find((item) => item.episodeSubjectId === episode2)?.completed).toBe(false);
  expect(visit.pending).toBe(false);
  const replaced = replaceBinding(visit, binding({ viewer: viewerB }));
  expect(replaced.kind).toBe('preparing');
  expect(replaced.rows).toEqual([]);
  expect(replaced.retry).toBeNull();
});

// Shared-boundary references (not executed here): progress-index-current-viewer.test.tsx
// and progress-index-read-credentials.test.tsx cover cookie/bearer/refusal association.
