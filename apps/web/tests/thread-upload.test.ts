import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const session = await import('../src/session/query');
const { resumeReplyImageUpload, uploadReplyImage, uploadAvatar, UploadRefusal } = await import('../src/threads/upload');
const { ReplyImageUploadRecovery } = await import('../src/threads/media-upload-recovery');

const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const mediaPath = `/media/${mediaId}`;
const file = new File(['original image bytes'], 'chart.png', { type: 'image/png' });
const signal = () => new AbortController().signal;
const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
const originalTimeout = globalThis.setTimeout;
const closeBitmap = mock(() => {});
const decode = mock(async (_file: Blob) => ({ width: 7, height: 5, close: closeBitmap }));
const calls: { path: string; init: RequestInit }[] = [];

function media(state: string, id = mediaId): Response {
  return Response.json({
    media: { id, state, mediaType: file.type, byteCount: file.size },
  });
}

function intercept(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    return handler(path, init);
  }) as typeof fetch);
}

async function refusal(result: Promise<unknown>): Promise<InstanceType<typeof UploadRefusal>> {
  const failure = await result.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UploadRefusal);
  return failure as InstanceType<typeof UploadRefusal>;
}

// Advance only the upload's backoff clock, keeping bounded polling tests local and immediate.
function fastBackoff() {
  let now = 0;
  const waits: number[] = [];
  spyOn(Date, 'now').mockImplementation(() => now);
  spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    waits.push(delay ?? 0);
    now += delay ?? 0;
    return originalTimeout(callback, 0, ...args);
  });
  return { waits, advance: (ms: number) => (now += ms) };
}

beforeEach(() => {
  spyOn(session, 'sessionCsrfToken').mockReturnValue('site-csrf');
  calls.length = 0;
  closeBitmap.mockClear();
  decode.mockReset();
  decode.mockImplementation(async () => ({ width: 7, height: 5, close: closeBitmap }));
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: decode });
});

afterEach(() => {
  mock.restore();
  if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap);
  else Reflect.deleteProperty(globalThis, 'createImageBitmap');
});

test('Keep the original post-image reservation through uncertain upload processing', async () => {
  for (const mode of ['completion-refused', 'completion-lost', 'poll-lost', 'rate-limited', 'dimensions'] as const) {
    calls.length = 0;
    decode.mockImplementation(async () => ({ width: mode === 'dimensions' ? 0 : 7, height: 5, close: closeBitmap }));
    intercept((_path, init) => {
      if (init.method === 'POST') return media('reserved');
      if (init.method === 'PUT') {
        if (mode === 'completion-refused')
          return Response.json({ privateMetadata: 'not for callers' }, { status: 503 });
        if (mode === 'completion-lost') throw new Error('lost completion response with private storage key');
        return new Response(null, { status: 204 });
      }
      if (mode === 'poll-lost') throw new Error('private processing error');
      if (mode === 'rate-limited') return new Response(null, { status: 429, headers: { 'retry-after': '7' } });
      return media('available');
    });

    const failure = await refusal(uploadReplyImage('original-thread', file, signal()));
    expect(failure.mediaId).toBe(mediaId);
    expect(failure.retryAfter).toBe(mode === 'rate-limited' ? 7 : undefined);
    expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
      name: 'UploadRefusal',
      reason: mode === 'rate-limited' ? 'rate-limited' : 'unavailable',
      mediaId,
    });
    expect(JSON.parse(JSON.stringify(failure))).not.toHaveProperty('privateMetadata');
    expect(failure.message).toBe(failure.reason);
    expect(failure.cause).toBeUndefined();
    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
      ['POST', '/media'],
      ['PUT', mediaPath],
      ...(['completion-refused', 'completion-lost'].includes(mode) ? [] : [['GET', mediaPath]]),
    ]);
  }
});

test('manual resume reads one original reservation and uses the original File for preview dimensions', async () => {
  let reads = 0;
  const { waits } = fastBackoff();
  intercept((_path, init) => {
    if (init.method === 'POST') return media('reserved');
    if (init.method === 'PUT') throw new Error('completion response lost');
    reads += 1;
    return media(reads === 1 ? 'uploaded' : 'available');
  });

  const failure = await refusal(uploadReplyImage({ containerId: 'original-thread' }, file, signal()));
  expect(decode).not.toHaveBeenCalled();
  const resumed = await resumeReplyImageUpload(failure.mediaId!, file, signal());
  expect(resumed).toEqual({ src: mediaId, width: 7, height: 5 });
  expect(decode).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledWith(file);
  expect(closeBitmap).toHaveBeenCalledTimes(1);
  expect(waits).toEqual([250]);
  expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
    ['POST', '/media'],
    ['PUT', mediaPath],
    ['GET', mediaPath],
    ['GET', mediaPath],
  ]);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    containerId: 'original-thread',
    purpose: 'post-image',
    mediaType: file.type,
    byteCount: file.size,
  });
  expect(await (calls[1]!.init.body as Blob).text()).toBe(await file.text());
  for (const { init } of calls) {
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe(init.method === 'GET' ? null : 'site-csrf');
  }
});

test('retrying a lost PUT resumes reserved bytes or observes accepted bytes without another reservation', async () => {
  let state = 'reserved';
  let puts = 0;
  let firstPutAccepted = false;
  intercept((_path, init) => {
    if (init.method === 'POST') return media('reserved');
    if (init.method === 'PUT') {
      puts += 1;
      if (puts === 1) {
        state = firstPutAccepted ? 'uploaded' : 'reserved';
        throw new Error('lost PUT response');
      }
      state = 'available';
      return new Response(null, { status: 204 });
    }
    if (state === 'uploaded') {
      state = 'available';
      return media('uploaded');
    }
    return media(state);
  });

  for (const accepted of [false, true]) {
    calls.length = 0;
    state = 'reserved';
    puts = 0;
    firstPutAccepted = accepted;
    const recovery = new ReplyImageUploadRecovery(() => ({
      target: { containerId: 'original-thread' },
      session: { subject: 'writer', csrfToken: 'site-csrf' },
    }));
    expect(await refusal(recovery.upload(file, signal()))).toMatchObject({ reason: 'unavailable', mediaId });
    expect(calls.map(({ init }) => init.method)).toEqual(['POST', 'PUT']);
    expect(await recovery.upload(file, signal())).toEqual({ src: mediaId, width: 7, height: 5 });
    expect(calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1);
    expect(calls.filter(({ init }) => init.method === 'PUT')).toHaveLength(accepted ? 1 : 2);
    expect(calls.filter(({ init }) => init.method !== 'POST').every(({ path }) => path === mediaPath)).toBe(true);
    for (const { init } of calls.filter(({ init }) => init.method === 'PUT'))
      expect(await (init.body as Blob).text()).toBe(await file.text());
  }
});

test('processing timeout keeps the real ID and resume preserves the existing read, time and backoff bounds', async () => {
  const { waits, advance } = fastBackoff();
  let slowRead = false;
  intercept((_path, init) => {
    if (init.method === 'POST') return media('reserved');
    if (init.method === 'PUT') return new Response(null, { status: 204 });
    if (slowRead) advance(59_751);
    return media('uploaded');
  });

  for (const operation of [
    () => uploadReplyImage('original-thread', file, signal()),
    () => resumeReplyImageUpload(mediaId, file, signal()),
  ]) {
    calls.length = 0;
    waits.length = 0;
    expect(await refusal(operation())).toMatchObject({ reason: 'unavailable', mediaId });
    expect(calls.filter(({ init }) => init.method === 'GET')).toHaveLength(32);
    expect(waits).toEqual([250, 500, 1_000, ...Array(28).fill(2_000)]);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(60_000);
  }
  calls.length = 0;
  waits.length = 0;
  slowRead = true;
  expect(await refusal(resumeReplyImageUpload(mediaId, file, signal()))).toMatchObject({
    reason: 'unavailable',
    mediaId,
  });
  expect(calls.map(({ init }) => init.method)).toEqual(['GET']);
  expect(waits).toEqual([]);
  expect(decode).not.toHaveBeenCalled();
});

test('rejected, missing, expired, unavailable and mismatched reservations never become successful resumed images', async () => {
  for (const outcome of ['rejected', 404, 410, 503, 'mismatched'] as const) {
    calls.length = 0;
    intercept(() =>
      typeof outcome === 'number'
        ? new Response(null, { status: outcome })
        : media(
            outcome === 'rejected' ? 'rejected' : 'available',
            outcome === 'mismatched' ? 'another-reservation' : mediaId,
          ),
    );
    const failure = await refusal(resumeReplyImageUpload(mediaId, file, signal()));
    expect(failure).toMatchObject({ reason: outcome === 'rejected' ? 'rejected' : 'unavailable', mediaId });
    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([['GET', mediaPath]]);
  }
  expect(decode).not.toHaveBeenCalled();
});

test('failures before a native reservation never invent an ID, and avatar uploads retain their actual ID', async () => {
  const invalid = new File(['text'], 'note.txt', { type: 'text/plain' });
  intercept(() => new Response(null, { status: 503 }));
  expect(await refusal(uploadReplyImage('thread', invalid, signal()))).toMatchObject({
    reason: 'type',
    mediaId: undefined,
  });
  expect(calls).toHaveLength(0);
  expect(await refusal(uploadReplyImage('thread', file, signal()))).toMatchObject({
    reason: 'unavailable',
    mediaId: undefined,
  });
  expect(calls.map(({ init }) => init.method)).toEqual(['POST']);

  calls.length = 0;
  intercept((_path, init) => (init.method === 'POST' ? media('reserved') : new Response(null, { status: 503 })));
  expect(await refusal(uploadAvatar('original-account', file, signal()))).toMatchObject({
    reason: 'unavailable',
    mediaId,
  });
  expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ containerId: 'original-account', purpose: 'avatar' });
  expect(calls.map(({ init }) => init.method)).toEqual(['POST', 'PUT']);
});

test('abort remains cancellation before resume, during byte upload and while waiting to resume', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  intercept(() => {
    throw new Error('must not fetch');
  });
  await expect(resumeReplyImageUpload(mediaId, file, cancelled.signal)).rejects.toBe(cancelled.signal.reason);
  expect(calls).toHaveLength(0);

  const uploading = new AbortController();
  intercept((_path, init) => {
    if (init.method === 'POST') return media('reserved');
    uploading.abort();
    throw new Error('transport failed during cancellation');
  });
  const uploadAbort = await uploadReplyImage('original-thread', file, uploading.signal).catch((error) => error);
  expect(uploadAbort).toBe(uploading.signal.reason);
  expect(calls.map(({ init }) => init.method)).toEqual(['POST', 'PUT']);

  calls.length = 0;
  const resuming = new AbortController();
  intercept(() => media('uploaded'));
  spyOn(globalThis, 'setTimeout').mockImplementation(() => originalTimeout(() => resuming.abort(), 0));
  const resumeAbort = await resumeReplyImageUpload(mediaId, file, resuming.signal).catch((error) => error);
  expect(resumeAbort).toBe(resuming.signal.reason);
  expect(calls.map(({ path, init }) => [init.method, path])).toEqual([['GET', mediaPath]]);
  expect(decode).not.toHaveBeenCalled();
});

test('one episode shares a disclosed future container and repeats the exact uncertain reservation', async () => {
  const context = {
    target: { newThread: { boardId: 'board', idempotencyKey: 'draft' } },
    session: { subject: 'writer', csrfToken: 'site-csrf' },
  };
  const recovery = new ReplyImageUploadRecovery(() => context);
  let first = true;
  let lose = true;
  intercept((_path, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.newThread) {
        if (!first) return Response.json({}, { status: 409 });
        first = false;
        return Response.json({
          media: {
            id: mediaId,
            state: 'reserved',
            mediaType: file.type,
            byteCount: file.size,
            containerId: 'private-thread',
          },
        });
      }
      if (lose) {
        lose = false;
        throw new Error('reservation response lost');
      }
      return media('reserved');
    }
    return init.method === 'PUT' ? new Response(null, { status: 204 }) : media('available');
  });
  await recovery.upload(file, signal());
  const second = new File([await file.text()], 'second.png', { type: file.type });
  expect(await refusal(recovery.upload(second, signal()))).toMatchObject({ reason: 'unavailable', mediaId: undefined });
  const uncertain = calls.at(-1)!.init;
  await recovery.upload(second, signal());
  const posts = calls.filter(({ init }) => init.method === 'POST');
  expect(JSON.parse(String(posts[1]!.init.body))).toMatchObject({ containerId: 'private-thread' });
  expect(posts[2]!.init.body).toBe(uncertain.body);
  expect(new Headers(posts[2]!.init.headers).get('idempotency-key')).toBe(
    new Headers(uncertain.headers).get('idempotency-key'),
  );
  expect(posts.filter(({ init }) => JSON.parse(String(init.body)).newThread)).toHaveLength(1);
});

test('unknown 409 identity stays unknown across exact retries and independent composers', async () => {
  const context = {
    target: { newThread: { boardId: 'board', idempotencyKey: 'same-key' } },
    session: { subject: 'writer', csrfToken: 'site-csrf' },
  };
  intercept(() => Response.json({}, { status: 409 }));
  const one = new ReplyImageUploadRecovery(() => context);
  const two = new ReplyImageUploadRecovery(() => context);
  await refusal(one.upload(file, signal()));
  await refusal(one.upload(file, signal()));
  await refusal(two.upload(file, signal()));
  expect(calls).toHaveLength(3);
  expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
  expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(
    new Headers(calls[1]!.init.headers).get('idempotency-key'),
  );
  for (const { init } of calls) expect(JSON.parse(String(init.body))).not.toHaveProperty('containerId');
});

test('retired and aborted late reservations cannot refill recovery identity, including ABA', async () => {
  const initial = {
    target: { newThread: { boardId: 'board', idempotencyKey: 'old-key' } },
    session: { subject: 'writer', csrfToken: 'site-csrf' },
  };
  let context = initial;
  const recovery = new ReplyImageUploadRecovery(() => context);
  let resolve!: (response: Response) => void;
  intercept(
    () =>
      new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  const pending = recovery.upload(file, signal()).catch((error) => error);
  context = { ...initial, session: { subject: 'another', csrfToken: 'new' } };
  recovery.invalidate();
  context = initial;
  resolve(
    Response.json({
      containerId: 'old-private',
      media: { id: mediaId, state: 'reserved', mediaType: file.type, byteCount: file.size },
    }),
  );
  await pending;
  expect(calls).toHaveLength(1);
  recovery.clear();
  intercept(() => Response.json({}, { status: 409 }));
  await refusal(recovery.upload(file, signal()));
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty('containerId');
});

test('reply stage observations follow actual transport boundaries and known-media resume never reserves again', async () => {
  const stages: string[] = [];
  const recovery = new ReplyImageUploadRecovery(() => ({
    target: 'original-thread',
    session: { subject: 'writer', csrfToken: 'site-csrf' },
  }));
  let lost = true;
  intercept((_path, init) => {
    if (init.method === 'POST') {
      expect(stages.at(-1)).toBe('reservation');
      return media('reserved');
    }
    if (init.method === 'PUT') {
      expect(stages.at(-1)).toBe('transfer');
      if (lost) throw new Error('lost byte receipt');
      return new Response(null, { status: 204 });
    }
    expect(stages.at(-1)).toBe('processing');
    return media(lost ? 'reserved' : 'available');
  });
  expect(await refusal(recovery.upload(file, signal(), (stage) => stages.push(stage)))).toMatchObject({ mediaId });
  expect(stages).toEqual(['reservation', 'transfer']);
  lost = false;
  stages.length = 0;
  await recovery.upload(file, signal(), (stage) => stages.push(stage));
  expect(stages).toEqual(['processing']);
  expect(calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1);
});

test('disclosed future-thread 409 retains its admitted container command through an uncertain response', async () => {
  const recovery = new ReplyImageUploadRecovery(() => ({
    target: { newThread: { boardId: 'board', idempotencyKey: 'draft' } },
    session: { subject: 'writer', csrfToken: 'site-csrf' },
  }));
  let lose = true;
  intercept((_path, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.newThread) return Response.json({ containerId: 'disclosed-container' }, { status: 409 });
      if (lose) {
        lose = false;
        throw new Error('lost admitted reserve');
      }
      return media('reserved');
    }
    return init.method === 'PUT' ? new Response(null, { status: 204 }) : media('available');
  });
  await refusal(recovery.upload(file, signal()));
  await recovery.upload(file, signal());
  expect(calls[2]!.init.body).toBe(calls[1]!.init.body);
  expect(new Headers(calls[2]!.init.headers).get('idempotency-key')).toBe(
    new Headers(calls[1]!.init.headers).get('idempotency-key'),
  );
  expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ containerId: 'disclosed-container' });
});

test('failing reservation and transfer keep Retry-After observed before body cleanup', async () => {
  let now = 1_000;
  spyOn(Date, 'now').mockImplementation(() => now);
  const date = 'Sat, 31 Oct 2026 00:01:00 GMT';
  let step: 'limit' | 'unavailable' | 'invalid' = 'limit';
  intercept((_path, init) => {
    const later = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('private-body'));
        },
        cancel() {
          now += 4_000;
        },
      });
    if (step === 'invalid') return new Response(null, { status: 429, headers: { 'retry-after': 'later' } });
    if (init.method === 'POST' && step === 'limit')
      return new Response(later(), { status: 429, headers: { 'retry-after': '7200' } });
    if (init.method === 'POST') return media('reserved');
    return new Response(later(), { status: 503, headers: { 'retry-after': date } });
  });

  const limited = await refusal(uploadAvatar('original-account', file, signal()));
  expect(limited).toMatchObject({
    reason: 'rate-limited',
    retryAfter: 3600,
    retryAfterHeader: '7200',
    responseTime: 1_000,
    mediaId: undefined,
  });

  step = 'unavailable';
  now = 6_000;
  const paused = await refusal(uploadAvatar('original-account', file, signal()));
  expect(paused).toMatchObject({
    reason: 'unavailable',
    retryAfterHeader: date,
    responseTime: 6_000,
    mediaId,
  });
  expect(paused.retryAfter).toBeUndefined();

  step = 'invalid';
  now = 10_000;
  const ignored = await refusal(uploadAvatar('original-account', file, signal()));
  expect(ignored).toMatchObject({ reason: 'rate-limited', retryAfterHeader: 'later', responseTime: 10_000 });
  expect(ignored.retryAfter).toBeUndefined();
});
