import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  manualProgressSessions,
  manualScalarId,
  manualSparseId,
  manualCursorId,
  manualWithheldId,
  manualVersionId,
  routes,
} from '../src/kernel/fake/progress-profile-stories';
import type { NativeProgressSession, ProgressSessionPage } from '../src/library/progress-reads';
import { progressIndexSubjects, progressSubjects } from '../src/library/progress-subjects';
import type { PublishedLogPage } from '../src/library/logs-read';

// Interface transport fixtures only: no modeled grants, profile pins or native presentation producer.
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  viewerCredential: () => 'Bearer progress-owner',
}));

const { loadProgressSession, startProgress, recordProgress, finishProgress } =
  await import('../src/library/progress-reads');
const request = new Request('https://web.test/en/library/progress');
const key = '0192f3a0-6c1e-7b2a-9d4e-000000000899';
const newId = '0192f3a0-6c1e-7b2a-9d4e-000000000898';
const selectedVersionId = '0192f3a0-6c1e-7b2a-9d4e-000000000897';
type Call = { method: string; url: URL; authorization: string | null; key: string | null; body: unknown };

function transport(write?: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      const call: Call = {
        method: req.method,
        url: new URL(req.url),
        authorization: req.headers.get('authorization'),
        key: req.headers.get('idempotency-key'),
        body: req.method === 'POST' ? await req.json() : null,
      };
      calls.push(call);
      if (req.method === 'POST' && write) return write(call);
      for (const route of routes) {
        if (route.method !== req.method || !(route.path instanceof RegExp)) continue;
        const match = route.path.exec(call.url.pathname);
        if (!match) continue;
        const result = await route.story?.({ request: req, match, recordings: {} });
        if (result) return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
      }
      throw new Error(`Unexpected progress read: ${req.method} ${call.url.pathname}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

async function detail(id: string) {
  const { client, calls } = transport();
  const page = await loadProgressSession(client, request, {}, { id });
  if (!page.signedIn) throw new Error('Expected an owner page');
  return { page, calls };
}

test('A person reads historic manual progress under its original meaning and explicitly starts another allowed version session without retargeting or converting old values', async () => {
  const original = structuredClone(manualProgressSessions.find(({ id }) => id === manualScalarId)!);
  const { page } = await detail(original.id);
  expect(page.session).toMatchObject({
    id: original.id,
    versionSubjectId: manualVersionId,
    amount: '120.000001',
    total: '300',
    revision: original.revision,
    startedAt: original.startedAt,
    completedAt: original.completedAt,
  });
  // Missing native metadata must not turn today's unit vocabulary into historic evidence or permission.
  expect(page.session.meaning).toBe('unavailable');
  expect(page.session.recordingState).toBe('unavailable');
  expect(page.session).not.toHaveProperty('unitLabel');

  const created: NativeProgressSession = {
    ...original,
    id: newId,
    versionSubjectId: selectedVersionId,
    amount: null,
    total: '360',
    locator: null,
    position: null,
    completedUnitCount: 0,
    revision: 1,
    startedAt: '2026-10-31T00:00:00.000Z',
    completedAt: null,
    versionSubject: { id: selectedVersionId, type: 'schema:Book', label: 'Explicitly chosen version B' },
  };
  const { client, calls } = transport(() => Response.json({ progressSession: created }, { status: 201 }));
  const result = await startProgress(
    client,
    request,
    {},
    {
      subjectId: original.subjectId,
      versionSubjectId: selectedVersionId,
      mode: 'scalar_amount',
      unit: 'page',
      total: '360',
      idempotencyKey: key,
    },
  );
  expect(result).toEqual({ ok: true, id: newId });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({
    subjectId: original.subjectId,
    versionSubjectId: selectedVersionId,
    mode: 'scalar_amount',
    unit: 'page',
    total: '360',
  });
  expect(calls[0]!.url.pathname).toBe('/v1/progressSessions');
  expect(calls[0]!.authorization).toBe('Bearer progress-owner');
  expect(calls[0]!.key).toBe(JSON.stringify(key));
  expect(created).toMatchObject({ amount: null, locator: null, position: null, completedUnitCount: 0, revision: 1 });
  expect(manualProgressSessions.find(({ id }) => id === original.id)).toEqual(original);
  expect(page.session.amount).toBe('120.000001');
  expect(page.session.total).toBe('300');
});

test('an optional version reference is neither defaulted nor accepted as opaque free text', async () => {
  const original = manualProgressSessions[0]!;
  const { client, calls } = transport(() =>
    Response.json({ progressSession: { ...original, id: newId } }, { status: 201 }),
  );
  const input = { subjectId: original.subjectId, mode: 'scalar_amount', unit: 'page', idempotencyKey: key };
  expect(await startProgress(client, request, {}, { ...input, versionSubjectId: 'another edition' })).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(calls).toHaveLength(0);
  expect(await startProgress(client, request, {}, input)).toEqual({ ok: true, id: newId });
  expect(calls[0]!.body).not.toHaveProperty('versionSubjectId');
  expect(calls[0]!.body).not.toHaveProperty('total');
});

test('exact sparse keys, cardinality and intents survive paging without range expansion', async () => {
  const { client, calls } = transport();
  const first = await loadProgressSession(client, request, {}, { id: manualSparseId });
  if (!first.signedIn) throw new Error('Expected an owner page');
  const next = await loadProgressSession(client, request, {}, { id: manualSparseId, units: first.session.unitsNext! });
  if (!next.signedIn) throw new Error('Expected an owner page');
  expect([...first.session.units, ...next.session.units]).toEqual(['1', '3', '7']);
  expect(first.session.completedUnitCount).toBe(3);
  expect(next.session.completedUnitCount).toBe(3);
  expect(first.session.changes[0]!.add).toEqual(['1', '3', '7']);
  expect(first.session.changes[0]!.remove).toEqual([]);
  expect(next.unitsCursor).toBe('manual-units-next');
  for (const call of calls) {
    expect(call.authorization).toBe('Bearer progress-owner');
    if (call.url.pathname.endsWith('/changes') || call.url.pathname.endsWith('/completedUnits'))
      expect(call.url.searchParams.has('presentation')).toBe(false);
  }
});

test('opaque cursor text is read and recorded byte for byte, without edition translation', async () => {
  const { page } = await detail(manualCursorId);
  const locator = ' epubcfi(/6/2[old-chapter]) ';
  expect(page.session.locator).toBe(locator);
  expect(page.session.position).toBe('12.250001');
  expect(page.session.changes[0]).toMatchObject({ locator, position: '12.250001' });
  const raw = manualProgressSessions.find(({ id }) => id === manualCursorId)!;
  const { client, calls } = transport(() => Response.json({ progressSession: raw }));
  await recordProgress(
    client,
    request,
    {},
    { sessionId: raw.id, revision: 2, idempotencyKey: key, locator, position: '12.250001' },
  );
  expect(calls[0]!.body).toEqual({ revision: 2, locator, position: '12.250001' });
});

test('native record refusal retains history while completion and abandonment have their own authority', async () => {
  const { page } = await detail(manualScalarId);
  const before = structuredClone(page.session);
  for (const action of ['complete', 'abandon'] as const) {
    const raw = manualProgressSessions.find(({ id }) => id === manualScalarId)!;
    const terminal = {
      ...raw,
      revision: 3,
      state: action === 'complete' ? 'completed' : 'abandoned',
      completedAt: action === 'complete' ? '2026-10-31T00:00:00.000Z' : null,
    };
    const { client, calls } = transport((call) =>
      call.url.pathname.endsWith(':record')
        ? Response.json({ code: 'unsupported_library_profile', effect_status: 'not_applied' }, { status: 422 })
        : Response.json({ progressSession: terminal }),
    );
    expect(
      await recordProgress(client, request, {}, { sessionId: raw.id, revision: 2, idempotencyKey: key, amount: '121' }),
    ).toEqual({ ok: false, reason: 'unsupported_library_profile' });
    const result = await finishProgress(
      client,
      request,
      {},
      { sessionId: raw.id, action, revision: 2, idempotencyKey: key },
    );
    expect(result).toMatchObject({
      ok: true,
      session: { id: raw.id, revision: 3, state: terminal.state, amount: raw.amount, total: raw.total },
    });
    expect(calls[1]!.body).toEqual({ revision: 2 });
    expect(calls[1]!.url.pathname).toBe(`/v1/progressSessions/${raw.id}:${action}`);
    expect(page.session).toEqual(before);
  }
});

test('a failed start does not roll back an explicitly abandoned session', async () => {
  const raw = manualProgressSessions[0]!;
  const { client, calls } = transport((call) =>
    call.url.pathname.endsWith(':abandon')
      ? Response.json({ progressSession: { ...raw, revision: 3, state: 'abandoned' } })
      : Response.json({ code: 'unsupported_library_profile', effect_status: 'not_applied' }, { status: 422 }),
  );
  const abandoned = await finishProgress(
    client,
    request,
    {},
    { sessionId: raw.id, revision: 2, action: 'abandon', idempotencyKey: key },
  );
  const started = await startProgress(
    client,
    request,
    {},
    {
      subjectId: raw.subjectId,
      versionSubjectId: selectedVersionId,
      mode: 'scalar_amount',
      unit: 'page',
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(abandoned).toMatchObject({
    ok: true,
    session: { id: raw.id, state: 'abandoned', amount: raw.amount, total: raw.total },
  });
  expect(started).toEqual({ ok: false, reason: 'unsupported_library_profile' });
  expect(calls.map(({ url }) => url.pathname)).toEqual([
    `/v1/progressSessions/${raw.id}:abandon`,
    '/v1/progressSessions',
  ]);
});

test('a currently withheld summary is never refilled from another session or a published log', async () => {
  const { page } = await detail(manualWithheldId);
  expect(page.session.subject).toBeNull();
  expect(page.session.versionSubject).toBeNull();
  const visible = (await detail(manualScalarId)).page.session;
  expect(progressIndexSubjects([page.session, visible])[0]!.subject).toBeNull();
  const logs: PublishedLogPage = {
    signedIn: true,
    next: null,
    logs: [
      {
        id: newId,
        sessionState: 'completed',
        startedAt: visible.startedAt,
        completedAt: null,
        note: null,
        publishedAt: visible.startedAt,
        account: null,
        subject: visible.subject,
      },
    ],
  };
  const result = progressSubjects(page as ProgressSessionPage, logs);
  if (!result.progress.signedIn) throw new Error('Expected an owner page');
  expect(result.progress.session.subject).toBeNull();
  expect(result.progress.session.versionSubject).toBeNull();
  expect(result.logs.logs[0]!.subject).toEqual(visible.subject);
});

test('all eight locales explain explicit new sessions, unverified structure and unavailable recording', async () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    for (const name of [
      'version',
      'version_scope',
      'no_version',
      'new_session',
      'new_session_scope',
      'meaning_unknown',
      'recording_unavailable',
      'structure_unverified',
      'retry',
      'unavailable',
      'refused',
    ])
      expect(messages[`library_progress_${name}`], `${locale}: ${name}`).toBeTruthy();
  }
});
