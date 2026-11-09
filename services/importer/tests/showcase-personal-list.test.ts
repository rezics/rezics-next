import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import {
  applyShowcasePersonalList,
  readShowcasePersonalLibrary,
  readShowcasePersonalListExport,
  reviewShowcasePersonalList,
  runShowcasePersonalLifecycle,
  seedShowcasePersonalList,
} from '../src/showcase-personal-list.ts';

const identity = {
  origin: 'https://kernel.test',
  actor: { accountId: 'ordinary-person', clientId: 'showcase' },
  credential: { keyId: 'key-1' },
};
const tempRoot = join(import.meta.dir, '../../../.temp');

test('uploads through the generated VNDB route and resumes exact intents after unavailable delivery and restored authority', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'showcase-personal-list-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const calls: { path: string; key: string | null; body: string }[] = [];
  const firstId = '01900000-0000-4000-8000-000000000001';
  const changedId = '01900000-0000-4000-8000-000000000002';
  const restoredId = '01900000-0000-4000-8000-000000000003';
  const xml =
    '<vndb-export version="1.0"><vns><vn id="v123"><title>Original</title></vn><vn id="v456" /></vns></vndb-export>';
  const changedXml = xml.replace('Original', 'Changed');
  const restoredXml = changedXml.replace('Changed', 'Restored');
  let unauthorized = false;
  const client = createKernelClient('https://kernel.test', {
    headers: { authorization: 'Bearer ordinary-person' },
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().text();
      calls.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body,
      });
      if (calls.length === 1) throw new TypeError('fetch failed');
      if (unauthorized) return Response.json({ detail: 'owner authority unavailable' }, { status: 403 });
      const source = JSON.parse(body) as { xml: string };
      return Response.json({
        uploadId: source.xml === changedXml ? changedId : source.xml === restoredXml ? restoredId : firstId,
        rows: 2,
        limits: {},
      });
    }) as typeof globalThis.fetch,
  });

  try {
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'unknown-delivery',
      code: 'http-503',
    });
    journal.close();
    journal = new ShowcaseJournal(path);
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, identity, xml: changedXml })).toEqual({
      state: 'uploaded',
      uploadId: changedId,
      rows: 2,
    });

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.path)).toEqual(Array(4).fill('/v1/libraryImports/vndb:preview'));
    expect(calls.slice(0, 3).map((call) => call.key)).toEqual([calls[0]!.key, calls[0]!.key, calls[0]!.key]);
    expect(calls[3]!.key).not.toBe(calls[0]!.key);
    expect(calls.slice(0, 3).map((call) => JSON.parse(call.body))).toEqual(Array(3).fill({ xml }));
    expect(JSON.parse(calls[3]!.body)).toEqual({ xml: changedXml });

    unauthorized = true;
    expect(await seedShowcasePersonalList({ client, journal, identity, xml: restoredXml })).toEqual({
      state: 'unavailable',
      code: 'http-403',
    });
    const denied = calls.at(-1)!;
    journal.close();
    journal = new ShowcaseJournal(path);
    unauthorized = false;
    expect(await seedShowcasePersonalList({ client, journal, identity, xml: restoredXml })).toEqual({
      state: 'uploaded',
      uploadId: restoredId,
      rows: 2,
    });
    expect(calls.at(-1)?.key).toBe(denied.key);
    expect(calls.at(-1)?.body).toBe(denied.body);
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ xml: restoredXml });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test('reopen resumes the exact private upload after authority restoration and preserves response custody', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-custody-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const xml = '<vndb-export version="1.0"><vns><vn id="v4" /></vns></vndb-export>';
  const recoveryXml = xml.replace('vn id="v4"', 'vn id="v5"');
  const uploadId = '01900000-0000-4000-8000-000000000001';
  const recoveredUploadId = '01900000-0000-4000-8000-000000000002';
  let calls = 0;
  const requests: { body: string; key: string | null }[] = [];
  let response = () => Response.json({ uploadId, rows: 1 });
  const client = createKernelClient(identity.origin, {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls++;
      requests.push({ body: await request.clone().text(), key: request.headers.get('idempotency-key') });
      return response();
    }) as typeof fetch,
  });
  const run = (current = identity, source = xml) =>
    seedShowcasePersonalList({ client, journal, identity: current, xml: source });
  const reopen = () => {
    journal.close();
    journal = new ShowcaseJournal(path);
  };
  try {
    const acknowledge = journal.acknowledgeAction.bind(journal);
    let receiptKey = '';
    journal.acknowledgeAction = (key, id) => {
      if (key.endsWith(':response')) {
        receiptKey = key;
        throw new Error('Process stopped after recording the response');
      }
      acknowledge(key, id);
    };
    await expect(run()).rejects.toThrow('Process stopped after recording the response');
    reopen();
    expect(await run()).toEqual({ state: 'uploaded', uploadId, rows: 1 });
    expect(journal.action(receiptKey)?.state).toBe('acknowledged');
    reopen();
    for (const current of [
      { ...identity, origin: 'https://other.test' },
      { ...identity, actor: { ...identity.actor, accountId: 'other-person' } },
      { ...identity, actor: { ...identity.actor, clientId: 'other-client' } },
      { ...identity, credential: { keyId: 'other-key' } },
    ])
      expect(await run(current)).toEqual({ state: 'unavailable', code: 'sealed-identity-changed' });
    expect(calls).toBe(2);
    for (const body of [
      { uploadId, rows: 2 },
      { uploadId: '01900000-0000-4000-8000-000000000002', rows: 1 },
    ]) {
      response = () => Response.json(body);
      expect(await run()).toEqual({ state: 'unknown-delivery', code: 'upload-response-changed' });
    }
    response = () => Response.json({ uploadId, rows: 1 });
    expect(await run()).toEqual({ state: 'uploaded', uploadId, rows: 1 });
    for (const invalid of [
      () => Response.json({ uploadId, rows: 1 }, { status: 202 }),
      () => Response.json({ uploadId: 'not-a-uuid', rows: 1 }),
      () => Response.json({ uploadId, rows: 5001 }),
    ]) {
      response = invalid;
      expect(await run()).toEqual({ state: 'unknown-delivery', code: 'invalid-response' });
    }
    const privateDetail = 'private response detail must stay out of the journal';
    response = () => Response.json({ code: 'forbidden', detail: privateDetail }, { status: 403 });
    expect(await run(identity, recoveryXml)).toEqual({ state: 'unavailable', code: 'http-403' });
    const denied = requests.at(-1)!;
    expect(JSON.parse(denied.body)).toEqual({ xml: recoveryXml });
    const recoveryKey = `personal-list:vndb:upload:${createHash('sha256').update(recoveryXml, 'utf8').digest('hex')}`;
    const pending = journal.action(recoveryKey)!;
    expect(pending.state).toBe('prepared');
    expect(pending.body_json).not.toContain(privateDetail);
    const sent = calls;
    reopen();
    for (const current of [
      { ...identity, actor: { ...identity.actor, accountId: 'other-person' } },
      { ...identity, actor: { ...identity.actor, clientId: 'other-client' } },
    ])
      expect(await run(current, recoveryXml)).toEqual({ state: 'unavailable', code: 'sealed-identity-changed' });
    expect(calls).toBe(sent);
    response = () => Response.json({ uploadId: recoveredUploadId, rows: 1 });
    expect(await run(identity, recoveryXml)).toEqual({ state: 'uploaded', uploadId: recoveredUploadId, rows: 1 });
    expect(calls).toBe(sent + 1);
    expect(requests.at(-1)).toEqual(denied);
    expect(journal.action(recoveryKey)?.state).toBe('acknowledged');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test('private exports are bounded regular owner-only UTF-8 files; the native endpoint owns XML admission', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-input-'));
  const path = join(directory, 'export.xml');
  try {
    const xml = '<vndb-export version="1.0"><vns><vn id="v2002" /></vns></vndb-export>';
    await writeFile(path, xml, { mode: 0o600 });
    expect(await readShowcasePersonalListExport(path)).toBe(xml);
    await chmod(path, 0o644);
    await expect(readShowcasePersonalListExport(path)).rejects.toThrow('owner-only regular file');
    await chmod(path, 0o600);
    await symlink(path, join(directory, 'link.xml'));
    await expect(readShowcasePersonalListExport(join(directory, 'link.xml'))).rejects.toThrow();
    await expect(readShowcasePersonalListExport(directory)).rejects.toThrow('owner-only regular file');
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from([0xff])]) {
      await writeFile(path, bytes);
      await expect(readShowcasePersonalListExport(path)).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit review and confirmation keep original operands across reopen, partial responses and changed forms', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-commands-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const uploadId = '01900000-0000-4000-8000-000000000001';
  const targetId = '01900000-0000-4000-8000-000000000002';
  const reviewId = '01900000-0000-4000-8000-000000000003';
  const scoreReviewId = '01900000-0000-4000-8000-000000000004';
  const calls: { path: string; body: unknown; key: string | null; language: string | null }[] = [];
  let reply = () => new Response(null, { status: 503 });
  const client = createKernelClient(identity.origin, {
    headers: { authorization: 'Bearer owner' },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        path: new URL(request.url).pathname,
        body: request.method === 'POST' ? await request.json() : null,
        key: request.headers.get('idempotency-key'),
        language: request.headers.get('accept-language'),
      });
      return reply();
    }) as typeof fetch,
  });
  const review = (state: string, intentId = 'chosen-state', current = identity) =>
    reviewShowcasePersonalList({
      client,
      journal,
      identity: current,
      uploadId,
      intentId,
      body: { ordinal: 0, action: 'state', targetId, state, replace: false },
    });
  try {
    expect((await review('playing')).state).toBe('unknown-delivery');
    journal.close();
    journal = new ShowcaseJournal(path);
    const acknowledged = {
      reviewId,
      targetId,
      state: 'playing',
      status: 'reviewed' as const,
      action: 'state' as const,
      replace: false,
      baseline: null,
      progress: null,
    };
    reply = () => Response.json(acknowledged);
    expect(await review('completed')).toEqual({ state: 'acknowledged', value: acknowledged });
    expect(calls[1]).toEqual(calls[0]);
    const selection = {
      rows: [
        { ordinal: 0, reviewId },
        { ordinal: 1, scoreReviewId },
      ],
    };
    const apply = (body = selection, current = identity) =>
      applyShowcasePersonalList({
        client,
        journal,
        identity: current,
        uploadId,
        intentId: 'confirmed-selection',
        body,
      });
    const outcome = { ordinal: 0, reviewId, status: 'applied' };
    // A stopped page acknowledges only its returned effects; it must leave the entire original selection retryable.
    reply = () => Response.json({ uploadId, outcomes: [outcome], stopped: 'deadline' });
    expect((await apply()).state).toBe('acknowledged');
    expect(journal.action('personal-list:vndb:command:confirmed-selection')?.state).toBe('prepared');
    reply = () => Response.json({ uploadId, outcomes: [outcome], stopped: null });
    expect(await apply({ rows: [] })).toEqual({ state: 'unknown-delivery', code: 'apply-response-changed' });
    expect(calls.at(-1)?.body).toEqual(selection);
    const completed = {
      uploadId,
      outcomes: [outcome, { ordinal: 1, scoreReviewId, status: 'unavailable' }],
      stopped: null,
    };
    reply = () => Response.json(completed);
    expect(await apply()).toEqual({ state: 'acknowledged', value: completed });
    expect(journal.action('personal-list:vndb:command:confirmed-selection')?.state).toBe('acknowledged');
    const sent = calls.length;
    expect(await apply(selection, { ...identity, actor: { ...identity.actor, accountId: 'other-person' } })).toEqual({
      state: 'unavailable',
      code: 'sealed-identity-changed',
    });
    expect(calls).toHaveLength(sent);
    const current = {
      libraryEntries: [
        {
          subjectId: targetId,
          state: 'paused',
          revision: 9,
          createdAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
        },
      ],
      next: null,
    };
    reply = () => Response.json(current);
    expect(await readShowcasePersonalLibrary({ client })).toEqual({ state: 'current', value: current });
    expect(calls.at(-1)?.path).toBe('/v1/libraryEntries');
    expect(calls.at(-1)?.language).toBe('en');
    reply = () =>
      Response.json({
        uploadId,
        state: 'active',
        expiresAt: '2099-01-01T00:00:00Z',
        total: 1,
        next: null,
        rows: [],
      });
    const { readShowcasePersonalList } = await import('../src/showcase-personal-list.ts');
    expect((await readShowcasePersonalList({ client, uploadId, language: 'ja' })).state).toBe('current');
    expect(calls.at(-1)?.path).toBe(`/v1/libraryImports/vndb/${uploadId}`);
    expect(calls.at(-1)?.language).toBe('ja');
    reply = () => Response.json(current);
    expect(await readShowcasePersonalLibrary({ client, language: 'ja' })).toEqual({ state: 'current', value: current });
    expect(calls.at(-1)?.language).toBe('ja');
    const recoveryIntent = 'restored-authority-review';
    const privateDetail = 'private response detail must stay out of the journal';
    reply = () => Response.json({ detail: privateDetail }, { status: 403 });
    expect(await review('paused', recoveryIntent)).toEqual({ state: 'unavailable', code: 'http-403' });
    const denied = calls.at(-1)!;
    expect(denied.body).toEqual({ ordinal: 0, action: 'state', targetId, state: 'paused', replace: false });
    const recoveryActionKey = `personal-list:vndb:command:${recoveryIntent}`;
    const pending = journal.action(recoveryActionKey)!;
    expect(pending.state).toBe('prepared');
    expect(pending.body_json).not.toContain(privateDetail);
    const recoverySent = calls.length;
    journal.close();
    journal = new ShowcaseJournal(path);
    for (const current of [
      { ...identity, actor: { ...identity.actor, accountId: 'other-person' } },
      { ...identity, actor: { ...identity.actor, clientId: 'other-client' } },
    ])
      expect(await review('completed', recoveryIntent, current)).toEqual({
        state: 'unavailable',
        code: 'sealed-identity-changed',
      });
    expect(calls).toHaveLength(recoverySent);
    const restoredReview = { ...acknowledged, state: 'paused' as const };
    reply = () => Response.json(restoredReview);
    expect(await review('completed', recoveryIntent)).toEqual({ state: 'acknowledged', value: restoredReview });
    expect(calls).toHaveLength(recoverySent + 1);
    expect(calls.at(-1)).toEqual(denied);
    expect(journal.action(recoveryActionKey)?.state).toBe('acknowledged');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test('preview, explicit review, partial apply, reopen, changed reimport and independent Library/Progress stay separately observable', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-lifecycle-'));
  const path = join(directory, 'showcase.sqlite');
  const journal = new ShowcaseJournal(path);
  const uploadId = '01900000-0000-4000-8000-000000000001';
  const changedId = '01900000-0000-4000-8000-000000000009';
  const targetId = '01900000-0000-4000-8000-000000000002';
  const reviewId = '01900000-0000-4000-8000-000000000003';
  const scoreReviewId = '01900000-0000-4000-8000-000000000004';
  const xml =
    '<vndb-export version="1.0"><vns><vn id="v123"><title>Original</title><vote>7.0</vote></vn></vns></vndb-export>';
  const changedXml = xml.replace('Original', 'Changed').replace('7.0', '8.2');
  const calls: { path: string; cache: RequestCache; language: string | null; method: string }[] = [];
  const client = createKernelClient(identity.origin, {
    headers: { authorization: 'Bearer owner' },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push({
        path,
        cache: request.cache,
        language: request.headers.get('accept-language'),
        method: request.method,
      });
      if (path.endsWith(':preview')) {
        const body = (await request.json()) as { xml: string };
        return Response.json({ uploadId: body.xml === changedXml ? changedId : uploadId, rows: 1, limits: {} });
      }
      if (path.endsWith(':review')) {
        const body = (await request.json()) as { action?: string };
        return Response.json(
          body.action === 'score'
            ? {
                reviewId: scoreReviewId,
                status: 'reviewed',
                targetId,
                action: 'vote',
                units: 14,
                question: {
                  id: 'q',
                  revision: 1,
                  grain: 'work',
                  meaning: 'enjoyment',
                  scale: { min: 0, max: 20, step: 1 },
                },
                currentVote: { state: 'absent' },
                consent: 'adopt-native-vote',
                sourceReason: 'exact native units',
                nativeAdmission: 'conditional',
              }
            : {
                reviewId,
                status: 'reviewed',
                targetId,
                state: 'playing',
                baseline: null,
                replace: false,
                action: 'state',
                progress: null,
              },
        );
      }
      if (path.endsWith(':apply')) {
        const body = (await request.json()) as {
          rows: { ordinal: number; reviewId?: string; scoreReviewId?: string }[];
        };
        return Response.json({
          uploadId,
          outcomes: body.rows.map((row) =>
            row.scoreReviewId
              ? { ordinal: row.ordinal, scoreReviewId: row.scoreReviewId, status: 'unavailable' }
              : { ordinal: row.ordinal, reviewId: row.reviewId, status: 'applied' },
          ),
          stopped: null,
        });
      }
      if (path.endsWith(':cancel')) return Response.json({ uploadId, state: 'cancelled' });
      if (request.method === 'DELETE') return Response.json({ uploadId: changedId, state: 'deleted' });
      if (path.endsWith('/libraryEntries'))
        return Response.json({
          libraryEntries: [
            {
              subjectId: targetId,
              state: 'playing',
              revision: 2,
              createdAt: '2026-11-06T00:00:00.000Z',
              updatedAt: '2026-11-06T00:00:00.000Z',
              activeProgressSession: { id: '01900000-0000-4000-8000-000000000005', amount: '0', unit: 'minute' },
            },
          ],
          next: null,
          viewerFacts: {
            state: 'current',
            question: {
              id: 'q',
              revision: 1,
              grain: 'work',
              meaning: 'enjoyment',
              scale: { min: 0, max: 20, displayStep: 1 },
            },
            rows: [],
          },
        });
      if (path.endsWith('/progressSessions'))
        return Response.json({
          progressSessions: [{ id: '01900000-0000-4000-8000-000000000005', amount: '0', unit: 'minute' }],
          next: null,
        });
      return Response.json({
        uploadId: path.includes(changedId) ? changedId : uploadId,
        state: 'active',
        expiresAt: '2099-01-01T00:00:00Z',
        total: 1,
        next: null,
        rows: [{ ordinal: 0, title: path.includes(changedId) ? 'Changed' : 'Original' }],
      });
    }) as typeof fetch,
  });
  try {
    const first = await runShowcasePersonalLifecycle({
      client,
      journal,
      identity,
      commands: [
        { kind: 'preview', xml },
        { kind: 'page', uploadId, language: 'ja' },
        {
          kind: 'review',
          intentId: 'state',
          uploadId,
          body: { ordinal: 0, action: 'state', targetId, state: 'playing', replace: false },
        },
        {
          kind: 'review',
          intentId: 'score',
          uploadId,
          body: {
            ordinal: 0,
            action: 'score',
            targetId,
            questionId: '00000000-0000-7000-8000-000000000001',
            questionRevision: 1,
            selection: { kind: 'vote', units: 14 },
            consent: 'adopt-native-vote',
          },
        },
        {
          kind: 'apply',
          intentId: 'confirm',
          uploadId,
          body: {
            rows: [
              { ordinal: 0, reviewId },
              { ordinal: 0, scoreReviewId },
            ],
          },
        },
        { kind: 'page', uploadId },
        { kind: 'preview', xml: changedXml },
        { kind: 'page', uploadId: changedId },
        { kind: 'library', language: 'zh-Hant' },
        { kind: 'progress', subjectId: targetId, language: 'zh-Hant' },
        { kind: 'cancel', intentId: 'stop', uploadId },
        { kind: 'delete', intentId: 'remove-changed', uploadId: changedId },
      ],
    });
    expect(first.map((step) => step.kind)).toEqual([
      'preview',
      'page',
      'review',
      'review',
      'apply',
      'page',
      'preview',
      'page',
      'library',
      'progress',
      'cancel',
      'delete',
    ]);
    expect(first[0]).toEqual({ kind: 'preview', value: { state: 'uploaded', uploadId, rows: 1 } });
    expect(first[2]?.kind === 'review' && first[2].value.state === 'acknowledged').toBe(true);
    expect(first[3]?.kind === 'review' && first[3].value.state === 'acknowledged').toBe(true);
    expect(first[4]).toMatchObject({
      kind: 'apply',
      value: {
        state: 'acknowledged',
        value: {
          uploadId,
          outcomes: [
            { ordinal: 0, reviewId, status: 'applied' },
            { ordinal: 0, scoreReviewId, status: 'unavailable' },
          ],
          stopped: null,
        },
      },
    });
    expect(first[6]).toEqual({ kind: 'preview', value: { state: 'uploaded', uploadId: changedId, rows: 1 } });
    expect(first[8]?.kind === 'library' && first[8].value.state === 'current').toBe(true);
    expect(first[9]?.kind === 'progress' && first[9].value.state === 'current').toBe(true);
    expect(first[10]).toMatchObject({
      kind: 'cancel',
      value: { state: 'acknowledged', value: { uploadId, state: 'cancelled' } },
    });
    expect(first[11]).toMatchObject({
      kind: 'delete',
      value: { state: 'acknowledged', value: { uploadId: changedId, state: 'deleted' } },
    });
    expect(calls.every((call) => call.cache === 'no-store')).toBe(true);
    expect(calls.find((call) => call.path === `/v1/libraryImports/vndb/${uploadId}`)?.language).toBe('ja');
    expect(calls.find((call) => call.path === '/v1/libraryEntries')?.language).toBe('zh-Hant');
    expect(calls.find((call) => call.path === '/v1/progressSessions')?.language).toBe('zh-Hant');
    expect(calls.some((call) => call.path.endsWith(':cancel') && call.method === 'POST')).toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/${changedId}`) && call.method === 'DELETE')).toBe(true);
    const sent = calls.length;
    expect(
      await runShowcasePersonalLifecycle({
        client,
        journal,
        identity: { ...identity, actor: { ...identity.actor, accountId: 'other-person' } },
        commands: [{ kind: 'cancel', intentId: 'stop', uploadId }],
      }),
    ).toEqual([{ kind: 'cancel', value: { state: 'unavailable', code: 'sealed-identity-changed' } }]);
    expect(calls).toHaveLength(sent);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
