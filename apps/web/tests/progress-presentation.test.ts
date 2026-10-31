import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { manualProgressSessions } from '../src/kernel/fake/progress-profile-stories';
import type { NativeProgressPresentation, NativeProgressSession } from '../src/library/progress-reads';
import { progressView } from '../src/library/progress-label';

let credential: string | null = 'Bearer progress-owner';
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  viewerCredential: () => credential,
}));

const { loadProgressIndex, loadProgressSession, nativeProgressPresentationQuery, recordProgress } =
  await import('../src/library/progress-reads');
const request = new Request('https://web.test/en/library/progress');
const original = manualProgressSessions[0]!;
// Explicit native DTO example: accepted vocabulary and current numeric hints are separate inputs.
// This transport fixture does not prove native pin resolution, permission or structure identity.
const declared = {
  meaning: 'known',
  unitLabel: 'leaf at acceptance',
  unitLabelLanguage: 'en',
  unitCountForms: { one: 'leaf at acceptance', other: 'leaves at acceptance' },
  dimension: 'pages',
  structure: 'unverified',
  recording: { state: 'supported', inputRules: { min: '0.25', max: '10', step: '0.01', total: 'required' } },
} satisfies NativeProgressPresentation;
type Call = { method: string; url: URL; authorization: string | null; key: string | null; body: unknown };

function transport(presentation: unknown, session: NativeProgressSession = original, detailStatus = 200) {
  const calls: Call[] = [];
  const wire = {
    ...session,
    presentation,
    // Undeclared sibling additions cannot override the opted-in native presentation.
    unitLabel: 'Untrusted current label',
    meaning: 'known',
    recordingState: 'supported',
    inputRules: { min: '999', step: '1', total: 'optional' },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        url,
        authorization: req.headers.get('authorization'),
        key: req.headers.get('idempotency-key'),
        body: req.method === 'POST' ? await req.json() : null,
      });
      const reply = (body: unknown, status = 200) =>
        Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
      if (req.method === 'POST' && url.pathname === `/v1/progressSessions/${session.id}:record`)
        return reply({ code: 'unsupported_library_profile', effect_status: 'not_applied' }, 422);
      if (req.method !== 'GET') throw new Error(`Unexpected method: ${req.method}`);
      if (url.pathname === '/v1/progressSessions')
        return reply({ progressSessions: [{ ...session, presentation }], next: null });
      if (url.pathname === `/v1/progressSessions/${session.id}`)
        return detailStatus === 200
          ? reply({ progressSession: wire })
          : reply({ code: detailStatus === 404 ? 'not_found' : 'dependency_unavailable' }, detailStatus);
      if (url.pathname === `/v1/progressSessions/${session.id}/changes`)
        return reply({
          changes: [
            { id: `${session.id}:2`, revision: 2, createdAt: session.startedAt, intent: { add: ['1', '3', '7'] } },
          ],
          next: 'opaque-changes-next',
        });
      if (url.pathname === `/v1/progressSessions/${session.id}/completedUnits`)
        return reply({ completedUnits: ['1', '3', '7'], next: 'opaque-units-next' });
      throw new Error(`Unexpected progress read: ${url.pathname}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

async function detail(presentation: unknown, session = original) {
  const { client, calls } = transport(presentation, session);
  const page = await loadProgressSession(
    client,
    request,
    {},
    {
      id: session.id,
      changes: 'original-changes-cursor',
      units: 'original-units-cursor',
    },
  );
  if (!page.signedIn) throw new Error('Expected an owner page');
  return { page, client, calls };
}

test('The existing progress inspector requests actual declared FULL presentation and binds accepted labels/current advisory recording rules without inventing history structure or authority', async () => {
  const { page, calls } = await detail(declared);
  expect(nativeProgressPresentationQuery()).toEqual({ presentation: 'FULL' });
  expect(calls).toHaveLength(3);
  const point = calls.find((call) => call.url.pathname === `/v1/progressSessions/${original.id}`)!;
  expect(Object.fromEntries(point.url.searchParams)).toEqual({ view: 'FULL', presentation: 'FULL' });
  for (const call of calls) {
    expect(call.method).toBe('GET');
    expect(call.authorization).toBe('Bearer progress-owner');
    if (call === point) continue;
    expect(call.url.searchParams.get('view')).toBe('FULL');
    expect(call.url.searchParams.get('limit')).toBe('100');
    expect(call.url.searchParams.has('presentation')).toBe(false);
    expect(call.url.searchParams.get('cursor')).toBe(
      call.url.pathname.endsWith('/changes') ? 'original-changes-cursor' : 'original-units-cursor',
    );
  }
  expect(page.session).toMatchObject({
    id: original.id,
    versionSubjectId: original.versionSubjectId,
    amount: original.amount,
    total: original.total,
    revision: original.revision,
    startedAt: original.startedAt,
    meaning: 'known',
    recordingState: 'supported',
    unitLabel: declared.unitLabel,
    unitLabelLanguage: 'en',
    unitCountForms: declared.unitCountForms,
    dimension: 'pages',
    inputRules: declared.recording.inputRules,
    units: ['1', '3', '7'],
    unitsNext: 'opaque-units-next',
    changesNext: 'opaque-changes-next',
  });
  expect(page.session.changes[0]!.add).toEqual(['1', '3', '7']);
  expect(progressView(page.session, 'en')!.text).toBe('120.000001 / 300 leaves at acceptance');
  expect(page.changesCursor).toBe('original-changes-cursor');
  expect(page.unitsCursor).toBe('original-units-cursor');
  expect(page.session).not.toHaveProperty('structureRevision');
  expect(page.session).not.toHaveProperty('creationVersion');
  expect(page.session).not.toHaveProperty('profileId');
});

test('optional native bounds stay absent and every declared total policy and plural category survives', async () => {
  for (const total of ['optional', 'required', 'forbidden'] as const) {
    const unitCountForms = { zero: 'zero', one: 'one', two: 'two', few: 'few', many: 'many', other: 'other' };
    const { page } = await detail({
      ...declared,
      unitCountForms,
      recording: { state: 'supported', inputRules: { step: 'any', total } },
    } satisfies NativeProgressPresentation);
    expect(page.session.inputRules).toEqual({ step: 'any', total });
    expect(page.session.inputRules).not.toHaveProperty('min');
    expect(page.session.inputRules).not.toHaveProperty('max');
    expect(page.session.unitCountForms).toEqual(unitCountForms);
  }
});

test('a missing original release, unknown raw unit, retired current pair and unavailable current evidence remain distinct', async () => {
  for (const [meaning, recordingState] of [
    ['unavailable', 'unavailable'],
    ['unknown', 'unsupported'],
    ['known', 'unsupported'],
    ['known', 'unavailable'],
  ] as const) {
    const { page } = await detail({ ...declared, meaning, recording: { state: recordingState } });
    expect(page.session.meaning).toBe(meaning);
    expect(page.session.recordingState).toBe(recordingState);
    expect(page.session).not.toHaveProperty('inputRules');
    if (meaning === 'known') expect(page.session.unitLabel).toBe(declared.unitLabel);
    else expect(page.session).not.toHaveProperty('unitLabel');
    expect(page.session.amount).toBe(original.amount);
    expect(page.session.total).toBe(original.total);
  }
});

test('absent, malformed and undeclared presentation never enables recording or rescues labels from sibling fields', async () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    'known',
    {},
    { ...declared, meaning: 'inferred' },
    { ...declared, structure: 'verified' },
    { ...declared, unitLabel: 12 },
    { ...declared, unitLabelLanguage: 12 },
    { ...declared, unitLabelLanguage: 'not_a_language' },
    { ...declared, dimension: {} },
    { ...declared, unitCountForms: [] },
    { ...declared, unitCountForms: { one: 'leaf' } },
    { ...declared, unitCountForms: { other: 12 } },
    { ...declared, unitCountForms: { other: 'leaves', privatePin: 'secret' } },
    { ...declared, recording: null },
    { ...declared, recording: { state: 'allowed' } },
    { ...declared, recording: { state: 'supported' } },
    { ...declared, recording: { state: 'unsupported', inputRules: declared.recording.inputRules } },
    ...[
      null,
      [],
      {},
      { step: 'any', total: 'inferred' },
      { step: 1, total: 'optional' },
      { step: 'any', total: 'optional', min: 0 },
      { step: 'any', total: 'optional', max: null },
      { step: 'any', total: 'optional', privatePin: 'secret' },
    ].map((inputRules) => ({ ...declared, recording: { state: 'supported', inputRules } })),
    ...['profileId', 'releaseDigest', 'acceptingType', 'libraryProfilePin', 'creationVersion', 'scope', 'token'].map(
      (field) => ({ ...declared, [field]: 'private-or-undeclared' }),
    ),
    { ...declared, recording: { ...declared.recording, token: 'private' } },
  ];
  for (const presentation of invalid) {
    const { page, calls } = await detail(presentation);
    expect(page.session.meaning).toBe('unavailable');
    expect(page.session.recordingState).toBe('unavailable');
    expect(page.session).not.toHaveProperty('unitLabel');
    expect(page.session).not.toHaveProperty('inputRules');
    expect(page.session.amount).toBe(original.amount);
    expect(calls).toHaveLength(3);
  }
});

test('declared presentation preserves opaque cursors, sparse cardinality and withheld summaries', async () => {
  for (const original of manualProgressSessions) {
    const { page, calls } = await detail(declared, original);
    expect(page.session).toMatchObject({
      id: original.id,
      versionSubjectId: original.versionSubjectId,
      mode: original.mode,
      unit: original.unit,
      total: original.total,
      amount: original.amount,
      locator: original.locator,
      position: original.position,
      completedUnitCount: original.completedUnitCount,
    });
    expect(page.session.units).toEqual(['1', '3', '7']);
    if (original.subject === null) expect(page.session.subject).toBeNull();
    if (original.versionSubject === null) expect(page.session.versionSubject).toBeNull();
    expect(calls).toHaveLength(3);
  }
});

test('native advice never overrides current command refusal, revision or idempotency', async () => {
  const { page, client, calls } = await detail(declared);
  const before = structuredClone(page.session);
  const key = '10203040-5060-4070-8090-102030405060';
  expect(
    await recordProgress(
      client,
      request,
      {},
      {
        sessionId: original.id,
        revision: original.revision,
        idempotencyKey: key,
        amount: '9',
      },
    ),
  ).toEqual({ ok: false, reason: 'unsupported_library_profile' });
  expect(page.session).toEqual(before);
  expect(calls).toHaveLength(4);
  expect(calls[3]!.body).toEqual({ revision: original.revision, amount: '9' });
  expect(calls[3]!.authorization).toBe('Bearer progress-owner');
  expect(calls[3]!.key).toBe(JSON.stringify(key));
});

test('presentation does not add list fanout or an anonymous fallback after a refused detail', async () => {
  const { client, calls } = transport(declared);
  await loadProgressIndex(client, request, {}, { subjectId: original.subjectId });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.pathname).toBe('/v1/progressSessions');
  expect(calls[0]!.url.searchParams.has('presentation')).toBe(false);
  for (const status of [404, 503]) {
    const denied = transport(declared, original, status);
    await expect(loadProgressSession(denied.client, request, {}, { id: original.id })).rejects.toBeDefined();
    expect(denied.calls).toHaveLength(3);
    expect(denied.calls.every((call) => call.authorization === 'Bearer progress-owner')).toBe(true);
  }
  credential = null;
  try {
    const anonymous = transport(declared);
    expect(await loadProgressSession(anonymous.client, request, {}, { id: original.id })).toMatchObject({
      signedIn: false,
    });
    expect(anonymous.calls).toHaveLength(0);
  } finally {
    credential = 'Bearer progress-owner';
  }
});
