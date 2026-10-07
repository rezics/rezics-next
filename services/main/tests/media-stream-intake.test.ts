import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import type { MediaStore, UploadRow } from '../src/modules/media/store.ts';
import { MAX_UPLOAD_BYTES } from '../src/modules/media/store.ts';
import { mediaRoutes, readMediaUploadBytes } from '../src/routes/media.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uploadId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const representationId = '00000000-0000-4000-8000-000000000003';
const revisionId = '00000000-0000-4000-8000-000000000004';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Sniffing accepts this header without invoking any image decoder.
const image = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);

function fixture() {
  const events: string[] = [];
  const state = {
    row: { id: uploadId, asset: assetId, status: 'reserved', mediaType: 'image/gif',
      byteLength: image.length, sha256: sha(image), quarantineKey: 'quarantine',
      objectNamespace: 'asset/', owner: `https://rezics.com/id/${assetId}`, expired: false,
      representation: null, principal: 'owner', reason: null, clearance: null,
      clearanceReason: null } as UploadRow | null,
    principal: 'owner' as string | null,
    authError: undefined as Error | undefined,
    settlements: 0, writes: 0, revisions: 0,
  };
  const fuseki = { query: async () => ({ boolean: true }) } as unknown as FusekiClient;
  const stored = new Map<string, Uint8Array>();
  const deps = {
    environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '0' } },
    account: { verify: async (request: Request, scopes: string[]) => {
      events.push('bearer');
      expect(scopes).toEqual(['work:edit']);
      if (state.authError) throw state.authError;
      if (request.headers.get('authorization') !== 'Bearer owner') throw new AccountAssertionDenied();
      return { issuer: 'https://account.test', subject: 'owner' };
    } },
    access: { activePrincipalId: async () => { events.push('principal'); return state.principal; } },
    media: {
      store: {
        readUpload: async () => { events.push('reservation'); return state.row ? { ...state.row } : null; },
        settleUpload: async (_id: string, verdict: Parameters<MediaStore['settleUpload']>[1]) => {
          state.settlements++;
          state.row!.status = verdict.status;
          state.row!.reason = verdict.status === 'rejected' ? verdict.reason : null;
          state.row!.representation = verdict.status === 'activated' ? representationId : null;
          return { reason: state.row!.reason, replayed: false };
        },
        recordAssetRevision: async () => {
          return { revision: revisionId, replayed: state.revisions++ > 0 };
        },
      },
      objects: () => ({
        put: async (bytes: Uint8Array) => { state.writes++; stored.set(sha(bytes), bytes.slice()); return sha(bytes); },
        get: async (digest: string) => stored.get(digest)!,
      }),
    },
  } as unknown as MainWorkDependencies;
  return { state, events, app: mediaRoutes(fuseki, deps) };
}

function intake(chunks: Uint8Array[] = [], onPull?: () => void, stalled = false, stuckCancel = false) {
  let pulls = 0, cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      onPull?.();
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (!stalled) controller.close();
    },
    cancel() { cancellations++; if (stuckCancel) return new Promise<void>(() => undefined); },
  }, { highWaterMark: 0 });
  return { body, pulls: () => pulls, cancellations: () => cancellations };
}

function request(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(`http://main.local/v1/media/uploads/${uploadId}/bytes`, {
    method: 'PUT', headers: { authorization: 'Bearer owner', ...headers }, body, signal,
  });
}

for (const [name, alter, status] of [
  ['missing bearer', () => undefined, 401],
  ['invalid bearer', () => undefined, 401],
  ['unavailable authentication', (f: ReturnType<typeof fixture>) => { f.state.authError = new AccountAssertionUnavailable(); }, 503],
  ['missing reservation', (f: ReturnType<typeof fixture>) => { f.state.row = null; }, 404],
  ['foreign reservation', (f: ReturnType<typeof fixture>) => { f.state.row!.principal = 'foreign'; }, 404],
  ['inactive principal', (f: ReturnType<typeof fixture>) => { f.state.principal = null; }, 404],
  ['expired reservation', (f: ReturnType<typeof fixture>) => { f.state.row!.expired = true; }, 409],
  ['expired status', (f: ReturnType<typeof fixture>) => { f.state.row!.status = 'expired'; }, 409],
] as const) {
  test(`media intake refuses ${name} before reading any body`, async () => {
    const f = fixture(); alter(f);
    const stream = intake([], undefined, true, true);
    const req = request(stream.body, { 'content-type': 'application/json', 'content-length': String(MAX_UPLOAD_BYTES + 1) });
    if (name === 'missing bearer') req.headers.delete('authorization');
    if (name === 'invalid bearer') req.headers.set('authorization', 'Bearer invalid');
    const response = await f.app.handle(req);
    expect(response.status).toBe(status);
    expect(stream.pulls()).toBe(0);
    expect(stream.cancellations()).toBe(1);
    expect(f.state.settlements).toBe(0);
    expect(f.state.writes).toBe(0);
  });
}

for (const contentType of ['application/octet-stream', 'application/json', 'multipart/form-data; boundary=media']) {
  test(`media intake admits chunked bytes without Content-Length and isolates ${contentType} parsing`, async () => {
    const f = fixture();
    const stream = intake([image.slice(0, 3), image.slice(3)], () => {
      expect(f.events.slice(0, 3)).toEqual(['bearer', 'principal', 'reservation']);
    });
    const req = request(stream.body, { 'content-type': contentType });
    const buffer = spyOn(req, 'arrayBuffer').mockImplementation(() => { throw new Error('unbounded body reader'); });
    try {
      const response = await f.app.handle(req);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: 'activated', representation: representationId, replayed: false });
      expect(buffer).not.toHaveBeenCalled();
      expect(f.state.settlements).toBe(1);
      expect(f.state.writes).toBe(2);
    } finally { buffer.mockRestore(); }
  });
}

for (const declared of [undefined, '1', String(image.length)]) {
  test(`media intake cancels the first excessive chunk with Content-Length ${declared}`, async () => {
    const f = fixture();
    const stream = intake([image.slice(0, 5), image, image], undefined, true, true);
    const response = await f.app.handle(request(stream.body, declared ? { 'content-length': declared } : {}));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'media_too_large' });
    expect(stream.pulls()).toBe(2);
    expect(stream.cancellations()).toBe(1);
    expect(f.state.settlements).toBe(0);
    expect(f.state.writes).toBe(0);
    // Transport failures leave the reservation usable.
    expect((await f.app.handle(request(intake([image]).body))).status).toBe(201);
  });
}

test('media intake checks declared reservation and absolute 8 MiB bounds before reading', async () => {
  for (const oversizedReservation of [false, true]) {
    const f = fixture();
    if (oversizedReservation) f.state.row!.byteLength = MAX_UPLOAD_BYTES * 2;
    const declared = oversizedReservation ? MAX_UPLOAD_BYTES + 1 : image.length + 1;
    const stream = intake([], undefined, true, true);
    expect((await f.app.handle(request(stream.body, { 'content-length': String(declared) }))).status).toBe(413);
    expect(stream.pulls()).toBe(0);
    expect(stream.cancellations()).toBe(1);
  }
  // An absent declaration must still obey the global bound.
  const stream = intake([new Uint8Array(MAX_UPLOAD_BYTES), new Uint8Array(1)], undefined, true, true);
  await expect(readMediaUploadBytes(request(stream.body), MAX_UPLOAD_BYTES * 2)).rejects.toThrow();
  expect(stream.pulls()).toBe(2);
  expect(stream.cancellations()).toBe(1);
});

test('media intake preserves durable size, digest and sniffing rejection', async () => {
  for (const [bytes, reason] of [
    [image.slice(1), 'size-mismatch'],
    [new Uint8Array(image.length), 'digest-mismatch'],
    [new Uint8Array(image.length).fill(7), 'format-rejected'],
  ] as const) {
    const f = fixture();
    if (reason === 'format-rejected') f.state.row!.sha256 = sha(bytes);
    const response = await f.app.handle(request(intake([bytes]).body));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: 'rejected', reason });
    const retry = intake([], undefined, true, true);
    expect((await f.app.handle(request(retry.body))).status).toBe(422);
    expect(retry.pulls()).toBe(0);
    expect(retry.cancellations()).toBe(1);
    expect(f.state.settlements).toBe(1);
  }
});

test('media intake replays activated uploads and repairs the revision stage without reading a body', async () => {
  const f = fixture();
  f.state.row!.status = 'activated'; f.state.row!.representation = representationId;
  for (const status of [201, 200]) {
    const stream = intake([], undefined, true, true);
    const response = await f.app.handle(request(stream.body, { 'content-length': String(MAX_UPLOAD_BYTES + 1) }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status: 'activated', representation: representationId, revision: revisionId });
    expect(stream.pulls()).toBe(0);
    expect(stream.cancellations()).toBe(1);
  }
  expect(f.state.settlements).toBe(0);
  expect(f.state.writes).toBe(0);
});

test('media intake returns 408 and cancels a stalled transfer even if cancellation stalls', async () => {
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
    nativeTimeout(callback, ms === 30_000 ? 5 : ms)) as typeof setTimeout);
  try {
    const f = fixture(), stream = intake([], undefined, true, true);
    const response = await f.app.handle(request(stream.body));
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: 'media_upload_timeout' });
    expect(stream.cancellations()).toBe(1);
    expect(f.state.settlements).toBe(0);
    expect(f.state.writes).toBe(0);
    expect((await f.app.handle(request(intake([image]).body))).status).toBe(201);
  } finally { timer.mockRestore(); }
});

test('media intake uses one total deadline despite progress or empty chunks', async () => {
  let cancellations = 0, pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(10);
      // Cancellation may have closed the controller during the delay.
      try { controller.enqueue(++pulls % 2 ? new Uint8Array() : new Uint8Array([1])); } catch { /* closed */ }
    },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  await expect(readMediaUploadBytes(request(body), image.length, 35)).rejects.toThrow();
  expect(pulls).toBeLessThan(image.length);
  expect(cancellations).toBe(1);
});

test('media intake deadline also bounds synchronous empty-chunk floods', async () => {
  const stream = intake([], undefined, true, true);
  let cancellations = 0;
  const flood = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  await expect(readMediaUploadBytes(request(flood), image.length, 5)).rejects.toThrow();
  expect(cancellations).toBe(1);
  // An already-aborted transfer reads nothing and still cancels promptly.
  const abort = new AbortController(); abort.abort();
  await expect(readMediaUploadBytes(request(stream.body, {}, abort.signal), image.length)).rejects.toThrow();
  expect(stream.pulls()).toBe(0);
  expect(stream.cancellations()).toBe(1);
});

test('media intake rejects malformed Content-Length only after admission', async () => {
  for (const declared of ['-1', 'NaN', '1e4', '9007199254740992']) {
    const f = fixture(), stream = intake([], undefined, true, true);
    expect((await f.app.handle(request(stream.body, { 'content-length': declared }))).status).toBe(400);
    expect(f.events).toEqual(['bearer', 'principal', 'reservation']);
    expect(stream.pulls()).toBe(0);
    expect(stream.cancellations()).toBe(1);
  }
});

test('media intake aborts immediately and does not settle partial bytes', async () => {
  const f = fixture(), abort = new AbortController();
  const stream = intake([], () => abort.abort(), true, true);
  expect((await f.app.handle(request(stream.body, {}, abort.signal))).status).toBe(400);
  expect(stream.cancellations()).toBe(1);
  expect(f.state.settlements).toBe(0);
});

for (const change of ['expiry', 'principal', 'bearer', 'settlement'] as const) {
  test(`media intake rechecks ${change} after transfer`, async () => {
    const f = fixture();
    const stream = intake([image], () => {
      if (change === 'expiry') f.state.row!.expired = true;
      if (change === 'principal') f.state.principal = null;
      if (change === 'bearer') f.state.authError = new AccountAssertionDenied();
      if (change === 'settlement') { f.state.row!.status = 'rejected'; f.state.row!.reason = 'size-mismatch'; }
    });
    const response = await f.app.handle(request(stream.body));
    expect(response.status).toBe({ expiry: 409, principal: 404, bearer: 401, settlement: 422 }[change]);
    expect(f.state.settlements).toBe(0);
    expect(f.state.writes).toBe(0);
  });
}
