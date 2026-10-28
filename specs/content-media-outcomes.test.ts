import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Completion,
  ContentMediaDriver,
  ImageFixture,
  Media,
  Persona,
  ReferenceCommand,
  Reservation,
} from './content-media-driver';

setDefaultTimeout(60_000);
let driver: ContentMediaDriver;
beforeEach(async () => {
  const location = process.env.CONTENT_MEDIA_DRIVER;
  if (!location) throw new Error('Content media outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('CONTENT_MEDIA_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('CONTENT_MEDIA_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createContentMediaDriver !== 'function')
    throw new Error('Expected createContentMediaDriver factory');
  driver = await binding.createContentMediaDriver();
  await driver.setTime('2030-01-02T00:00:00.000Z');
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let serial = 0;
const requestId = () => `media-request-${++serial}`;
async function reservation(patch: Partial<Reservation> = {}): Promise<Reservation> {
  const source = await driver.source('landscape');
  expect(source.sha256).toBe(digest(source.bytes));
  return {
    requestId: requestId(),
    containerId: driver.containers.thread.id,
    purpose: 'post-image',
    type: source.type,
    length: source.bytes.length,
    sha256: source.sha256,
    ...patch,
  };
}
async function reserve(patch: Partial<Reservation> = {}, as: Persona = 'author') {
  const input = await reservation(patch);
  const result = await driver.reserve(as, input);
  expect(result.outcome).toBe('permitted');
  if (result.outcome !== 'permitted') throw new Error('Reservation positive control failed');
  return { media: result.media, input };
}
async function uploaded(kind: ImageFixture = 'landscape') {
  const source = await driver.source(kind);
  expect(source.sha256).toBe(digest(source.bytes));
  const { media, input } = await reserve({ type: source.type, length: source.bytes.length, sha256: source.sha256 });
  await driver.placeOriginal(media.id, source.bytes);
  const completion: Completion = {
    requestId: requestId(),
    reservationRequestId: input.requestId,
    containerId: input.containerId,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  };
  expect(await driver.complete('worker', completion)).toBe('permitted');
  expect((await row(media.id))?.state).toBe('uploaded');
  return { media, input, completion, source };
}
async function available(kind: ImageFixture = 'landscape') {
  const fixture = await uploaded(kind);
  expect(await driver.process('job', fixture.media.id)).toBe('permitted');
  expect((await row(fixture.media.id))?.state).toBe('available');
  return fixture;
}
async function row(id: string) {
  return (await driver.inspect()).media.find((media) => media.id === id);
}
function reference(media: Media, patch: Partial<ReferenceCommand> = {}): ReferenceCommand {
  return {
    requestId: requestId(),
    containerId: media.containerId,
    kind: 'post',
    document: {
      version: 'rezics-document-v1',
      profile: 'text',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { id: 'body' }, content: [{ type: 'text', text: 'Image reference' }] }],
      },
    },
    mediaIds: [media.id],
    ...patch,
  };
}
async function unchanged(action: () => Promise<unknown>, expected: unknown = 'denied') {
  const before = await driver.inspect();
  expect(await action()).toEqual(expected);
  expect(await driver.inspect()).toEqual(before);
}
function keysFor(snapshot: Awaited<ReturnType<ContentMediaDriver['inspect']>>, id: string) {
  return snapshot.storage.filter((item) => item.key.startsWith(`m/${id}/`));
}

test('parent anchored reservation copies container route and replays one stable row and effect', async () => {
  const { media, input } = await reserve();
  expect(media).toMatchObject({
    containerId: input.containerId,
    uploaderId: driver.authorId,
    route: driver.containers.thread.route,
    partition: driver.containers.thread.partition,
    purpose: input.purpose,
    type: input.type,
    length: input.length,
    sha256: input.sha256,
    state: 'reserved',
    claimedAt: null,
    erased: false,
  });
  expect(media.key).toBe(`m/${media.id}/original`);
  expect(await driver.reservationEvidence(input.requestId)).toEqual({
    action: 'media:create',
    anchorId: input.containerId,
    partition: media.partition,
    anchored: true,
    authoritativeTime: '2030-01-02T00:00:00.000Z',
    newObjectGrant: false,
  });
  const before = await driver.inspect();
  expect(await driver.reserve('author', input)).toEqual({ outcome: 'permitted', media });
  expect(await driver.inspect()).toEqual(before);
  expect(before.media).toHaveLength(1);
  expect(before.receipts.filter((item) => item.requestId === input.requestId)).toEqual([
    { requestId: input.requestId, effects: 1 },
  ]);
});

test('anonymous suspended unrelated and missing-container reservations have no effect', async () => {
  const input = await reservation();
  for (const as of ['anonymous', 'suspended'] as const) {
    await unchanged(() => driver.reserve(as, { ...input, requestId: requestId() }), { outcome: 'denied' });
  }
  await unchanged(() => driver.reserve('author', { ...input, containerId: 'missing-container' }), {
    outcome: 'denied',
  });
});

test('wrong purpose oversize type length and malformed digest reservations are invalid', async () => {
  for (const patch of [
    { purpose: 'unknown' },
    { length: 20 * 1024 * 1024 + 1 },
    { type: 'application/x-executable' },
    { length: -1 },
    { length: 1.5 },
    { sha256: 'not-sha256' },
  ]) {
    const input = await reservation(patch);
    await unchanged(() => driver.reserve('author', input), { outcome: 'invalid' });
  }
  const { media } = await reserve({ sha256: undefined });
  expect(media.sha256).toBeNull();
});

test('trusted completion binds actual bytes owner reservation request and container', async () => {
  const { media, input } = await reserve();
  const source = await driver.source('landscape');
  await driver.placeOriginal(media.id, source.bytes);
  const command: Completion = {
    requestId: requestId(),
    reservationRequestId: input.requestId,
    containerId: media.containerId,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  };
  for (const as of ['author', 'other', 'other-worker', 'moderator', 'anonymous', 'suspended'] as const) {
    await unchanged(() => driver.complete(as, command, { trusted: true, worker: true, uploaderId: driver.authorId }));
  }
  for (const patch of [
    { containerId: driver.containers.sibling.id },
    { reservationRequestId: 'unrelated-request' },
    { byteCount: source.bytes.length + 1 },
    { sha256: '0'.repeat(64) },
  ]) {
    await unchanged(() => driver.complete('worker', { ...command, ...patch }));
  }
  expect(await driver.complete('worker', command)).toBe('permitted');
  expect(await row(media.id)).toMatchObject({ state: 'uploaded', sha256: source.sha256, length: source.bytes.length });
});

test('media specification uses uploader BFF tokens instead of a separate Worker actor', async () => {
  const { media, input } = await reserve();
  const author = await driver.authenticationEvidence('author', input.requestId);
  const source = await driver.source('landscape');
  await driver.placeOriginal(media.id, source.bytes);
  const completion: Completion = {
    requestId: requestId(),
    reservationRequestId: input.requestId,
    containerId: media.containerId,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  };
  await unchanged(() => driver.complete('other-worker', completion, { uploaderId: author.sub }));
  const other = await driver.authenticationEvidence('other-worker', completion.requestId);
  expect(await driver.complete('worker', completion)).toBe('permitted');
  const worker = await driver.authenticationEvidence('worker', completion.requestId);
  expect(author.sub).toBe(media.uploaderId);
  expect(worker.sub).toBe(author.sub);
  expect(worker.clientId).toBe(worker.registeredWebsiteClientId);
  expect(worker.clientId).toBe('rezics-website');
  expect(worker.scopes).toContain('media:complete');
  expect(author.scopes).not.toContain('media:complete');
  expect(other.sub).toBeTruthy();
  expect(other.sub).not.toBe(worker.sub);
  expect(other.clientId).toBe(worker.clientId);
  expect(other.registeredWebsiteClientId).toBe(worker.registeredWebsiteClientId);
  expect(other.scopes.slice().sort()).toEqual(worker.scopes.slice().sort());
});

test('completion without declared digest records actual digest and repeated transitions cannot regress', async () => {
  const source = await driver.source('tiny');
  const { media, input } = await reserve({ sha256: undefined, type: source.type, length: source.bytes.length });
  await driver.placeOriginal(media.id, source.bytes);
  const completion: Completion = {
    requestId: requestId(),
    reservationRequestId: input.requestId,
    containerId: media.containerId,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  };
  expect(await driver.complete('worker', completion)).toBe('permitted');
  expect((await row(media.id))?.sha256).toBe(source.sha256);
  const uploadedState = await driver.inspect();
  expect(await driver.complete('worker', completion)).toBe('permitted');
  expect(await driver.inspect()).toEqual(uploadedState);
  expect(await driver.process('job', media.id)).toBe('permitted');
  const before = await driver.inspect();
  await driver.complete('worker', completion);
  await driver.process('job', media.id);
  expect(await driver.inspect()).toEqual(before);
  await unchanged(() => driver.complete('worker', { ...completion, requestId: requestId(), sha256: 'f'.repeat(64) }));
});

test('illegal processing and unauthorized jobs cannot change state', async () => {
  const reserved = await reserve();
  await unchanged(() => driver.process('job', reserved.media.id));
  const { media } = await uploaded();
  for (const as of ['author', 'other', 'anonymous', 'suspended', 'moderator', 'worker', 'other-worker'] as const) {
    await unchanged(() => driver.process(as, media.id));
    const before = await driver.inspect();
    expect((await driver.collect(as, media.partition)).outcome).toBe('denied');
    expect(await driver.inspect()).toEqual(before);
  }
});

test('post and revision commands claim inside their own partition transaction', async () => {
  for (const kind of ['post', 'revision'] as const) {
    const { media } = await available('tiny');
    const command = reference(media, { kind });
    expect(await driver.reference('author', command)).toBe('permitted');
    expect((await row(media.id))?.claimedAt).toBe('2030-01-02T00:00:00.000Z');
    const snapshot = await driver.inspect();
    expect(snapshot.references.find((item) => item.commandId === command.requestId)).toEqual({
      commandId: command.requestId,
      mediaIds: [media.id],
      partition: media.partition,
    });
    expect(await driver.reference('author', command)).toBe('permitted');
    expect(await driver.inspect()).toEqual(snapshot);
  }
});

test('failed post and revision roll back claims receipts and all effects', async () => {
  for (const kind of ['post', 'revision'] as const) {
    const { media } = await available('tiny');
    const before = await driver.inspect();
    await driver.failReferenceCommit();
    await expect(driver.reference('author', reference(media, { kind }))).rejects.toThrow(/\(503\): .*overloaded/);
    expect(await driver.inspect()).toEqual(before);
    expect((await row(media.id))?.claimedAt).toBeNull();
  }
});

test('cross-container same-partition and cross-route references are denied atomically', async () => {
  const { media } = await available('tiny');
  expect(driver.containers.sibling.partition).toBe(media.partition);
  expect(driver.containers.remote.route).not.toBe(media.route);
  for (const container of [driver.containers.sibling, driver.containers.remote]) {
    await unchanged(() => driver.reference('author', reference(media, { containerId: container.id })));
  }
});

test('another authorized uploader and moderator cannot claim or impersonate owner', async () => {
  const { media } = await available('tiny');
  await driver.grantParent('other', media.containerId);
  for (const as of ['other', 'moderator', 'anonymous', 'suspended'] as const) {
    await unchanged(() => driver.reference(as, reference(media)));
    await unchanged(
      () => driver.reference(as, reference(media, { untrusted: { uploaderId: driver.authorId } })),
      'invalid',
    );
  }
});

test('reserved uploaded rejected erased and forged available references are denied', async () => {
  const fixtures = [(await reserve()).media, (await uploaded('tiny')).media];
  const bad = await uploaded('malformed');
  expect(await driver.process('job', bad.media.id)).toBe('permitted');
  expect((await row(bad.media.id))?.state).toBe('rejected');
  fixtures.push(bad.media);
  const erased = await available('tiny');
  await driver.erase(erased.media.id);
  expect((await row(erased.media.id))?.erased).toBe(true);
  fixtures.push(erased.media);
  for (const media of fixtures) {
    await unchanged(() => driver.reference('author', reference(media)));
    await unchanged(
      () =>
        driver.reference(
          'author',
          reference(media, {
            untrusted: { state: 'available', claimedAt: '2000-01-01T00:00:00Z' },
          }),
        ),
      'invalid',
    );
  }
});

test('a mixed valid and not-ready reference list cannot leave a partial claim', async () => {
  const valid = await available('tiny');
  const pending = await uploaded('tiny');
  for (const kind of ['post', 'revision'] as const) {
    await unchanged(() =>
      driver.reference(
        'author',
        reference(valid.media, {
          kind,
          mediaIds: [valid.media.id, pending.media.id],
        }),
      ),
    );
    expect((await row(valid.media.id))?.claimedAt).toBeNull();
  }
});

test('collection removes exactly 24-hour unclaimed objects but preserves younger and claimed objects', async () => {
  const old = await available('tiny');
  const young = await available('tiny');
  const claimed = await available('tiny');
  await driver.setCreatedAt(old.media.id, '2030-01-01T00:00:00.000Z');
  await driver.setCreatedAt(young.media.id, '2030-01-01T00:00:01.000Z');
  await driver.setCreatedAt(claimed.media.id, '2029-12-30T00:00:00.000Z');
  expect(await driver.reference('author', reference(claimed.media))).toBe('permitted');
  const before = await driver.inspect();
  const run = await driver.collect('job', old.media.partition);
  expect(run.outcome).toBe('permitted');
  expect(run.selections.length).toBeGreaterThan(0);
  for (const selection of run.selections)
    expect(selection).toEqual({ partition: old.media.partition, bound: true, globalScan: false });
  const after = await driver.inspect();
  expect(await row(old.media.id)).toBeUndefined();
  expect(keysFor(after, old.media.id)).toEqual([]);
  for (const media of [young.media, claimed.media]) {
    expect(await row(media.id)).toBeDefined();
    expect(keysFor(after, media.id)).toEqual(keysFor(before, media.id));
  }
  expect((await driver.collect('job', old.media.partition)).outcome).toBe('permitted');
  expect(await driver.inspect()).toEqual(after);
});

test('storage deletion failure preserves retryability and a rerun removes every key', async () => {
  const { media } = await available('tiny');
  await driver.setCreatedAt(media.id, '2030-01-01T00:00:00.000Z');
  const before = await driver.inspect();
  expect(keysFor(before, media.id).length).toBeGreaterThan(1);
  await driver.failNextStorageDelete(media.key);
  await driver.collect('job', media.partition);
  expect(keysFor(await driver.inspect(), media.id).some((item) => item.key === media.key)).toBe(true);
  await driver.collect('job', media.partition);
  expect(keysFor(await driver.inspect(), media.id)).toEqual([]);
  expect(await row(media.id)).toBeUndefined();
  const after = await driver.inspect();
  await driver.collect('job', media.partition);
  expect(await driver.inspect()).toEqual(after);
});

test('partition collection includes unclaimed reserved uploaded and rejected rows without touching another partition', async () => {
  const reserved = await reserve();
  const uploadedMedia = await uploaded('tiny');
  const rejected = await uploaded('malformed');
  await driver.process('job', rejected.media.id);
  const remote = await reserve({ containerId: driver.containers.remote.id });
  expect(remote.media.partition).not.toBe(reserved.media.partition);
  for (const { media } of [reserved, uploadedMedia, rejected, remote]) {
    await driver.setCreatedAt(media.id, '2030-01-01T00:00:00.000Z');
  }
  expect((await driver.collect('job', reserved.media.partition)).outcome).toBe('permitted');
  for (const { media } of [reserved, uploadedMedia, rejected]) {
    expect(await row(media.id)).toBeUndefined();
    expect(keysFor(await driver.inspect(), media.id)).toEqual([]);
  }
  expect(await row(remote.media.id)).toBeDefined();
  const run = await driver.collect('job', remote.media.partition);
  expect(run.outcome).toBe('permitted');
  expect(run.selections.length).toBeGreaterThan(0);
  for (const selection of run.selections)
    expect(selection).toEqual({ partition: remote.media.partition, bound: true, globalScan: false });
  expect(await row(remote.media.id)).toBeUndefined();
});

test('claim racing collection cannot commit a reference to deleted available bytes', async () => {
  for (const first of ['claim', 'collection'] as const) {
    const { media } = await available('tiny');
    await driver.setCreatedAt(media.id, '2030-01-01T00:00:00.000Z');
    const command = reference(media);
    const result = await driver.raceClaimCollection(command, media.id, first);
    const snapshot = await driver.inspect();
    const committed = snapshot.references.find((item) => item.commandId === command.requestId);
    if (first === 'claim') expect(result.claim).toBe('permitted');
    if (result.claim === 'permitted') {
      expect(committed?.mediaIds).toContain(media.id);
      expect((await row(media.id))?.claimedAt).not.toBeNull();
      expect((await row(media.id))?.state).toBe('available');
      expect(keysFor(snapshot, media.id).length).toBeGreaterThan(1);
      expect((await driver.download('anonymous', media.id, 'derivative')).outcome).toBe('permitted');
    } else {
      expect(committed).toBeUndefined();
      expect(snapshot.receipts.some((item) => item.requestId === command.requestId && item.effects > 0)).toBe(false);
    }
  }
});

async function assertOutputs(kind: ImageFixture, widths: number[]) {
  const { media, source } = await available(kind);
  const outputs = await driver.derivatives(media.id);
  expect(outputs).toHaveLength(widths.length * 2);
  const actual: string[] = [];
  for (const output of outputs) {
    expect(output.key.startsWith(`m/${media.id}/`)).toBe(true);
    expect(output.key).not.toBe(media.key);
    expect(digest(output.bytes)).not.toBe(source.sha256);
    const decoded = await driver.decode(output.bytes);
    expect(decoded.width).toBeLessThanOrEqual(source.orientedWidth);
    expect(decoded.height).toBe(Math.round((source.orientedHeight * decoded.width) / source.orientedWidth));
    expect(decoded.metadata).toEqual([]);
    actual.push(`${decoded.format}:${decoded.width}`);
  }
  expect(actual.sort()).toEqual(widths.flatMap((width) => [`avif:${width}`, `webp:${width}`]).sort());
  const evidence = await driver.processingEvidence(media.id);
  expect(evidence.sharpVersion).toMatch(/^0\.35\./);
  expect(evidence).toMatchObject({ limitInputPixels: 40_000_000, failOn: 'warning', autoOrient: true });
  return source;
}

test('real Sharp produces every AVIF and WebP ladder width without upscaling', async () => {
  const source = await assertOutputs('landscape', [320, 640, 960, 1280, 1920, 2560]);
  expect([source.orientedWidth, source.orientedHeight]).toEqual([3000, 1500]);
});

test('EXIF orientation determines ladder bounds and GPS EXIF XMP are stripped', async () => {
  const source = await assertOutputs('oriented-gps', [320, 640]);
  expect([source.orientedWidth, source.orientedHeight]).toEqual([800, 1200]);
  expect(source.metadata).toEqual(expect.arrayContaining(['exif', 'gps', 'xmp']));
});

test('tiny image receives sanitized source-width outputs in both formats', async () => {
  const source = await assertOutputs('tiny', [127]);
  expect([source.orientedWidth, source.orientedHeight]).toEqual([127, 61]);
  expect(source.metadata).toEqual(expect.arrayContaining(['exif', 'gps']));
});

test('over-pixel truncated and malformed images reject retaining digest decision but no sample', async () => {
  for (const kind of ['over-pixel', 'truncated', 'malformed'] as const) {
    const { media, source, completion } = await uploaded(kind);
    expect(await driver.process('job', media.id)).toBe('permitted');
    const rejected = await row(media.id);
    expect(rejected).toMatchObject({ state: 'rejected', sha256: source.sha256, claimedAt: null });
    expect(rejected?.decision).toBeTruthy();
    expect(await driver.derivatives(media.id)).toEqual([]);
    expect(keysFor(await driver.inspect(), media.id)).toEqual([]);
    const before = await driver.inspect();
    await driver.process('job', media.id);
    await driver.complete('worker', completion);
    expect(await driver.inspect()).toEqual(before);
  }
});

test('public download allows only sanitized available derivative and original only to uploader', async () => {
  const { media } = await available('tiny');
  expect(await driver.download('anonymous', media.id, 'derivative')).toEqual({ outcome: 'denied' });
  expect(await driver.reference('author', reference(media))).toBe('permitted');
  const derivatives = await driver.derivatives(media.id);
  for (const as of ['anonymous', 'other', 'moderator'] as const) {
    const decision = await driver.download(as, media.id, 'derivative');
    expect(decision.outcome).toBe('permitted');
    if (decision.outcome !== 'permitted') throw new Error('Public derivative positive control failed');
    expect(decision.representation).toBe('derivative');
    const output = derivatives.find((item) => item.key === decision.key);
    expect(output).toBeDefined();
    expect(decision.sha256).toBe(digest(output!.bytes));
    expect(await driver.download(as, media.id, 'original')).toEqual({ outcome: 'denied' });
  }
  expect(await driver.download('author', media.id, 'original')).toMatchObject({
    outcome: 'permitted',
    representation: 'original',
    key: media.key,
  });
});

test('uploaded and rejected objects are hidden from everyone except uploader', async () => {
  const ready = await uploaded('tiny');
  const bad = await uploaded('malformed');
  await driver.process('job', bad.media.id);
  for (const { media } of [ready, bad]) {
    for (const as of ['anonymous', 'other', 'moderator'] as const) {
      for (const representation of ['original', 'derivative'] as const) {
        expect(await driver.download(as, media.id, representation)).toEqual({ outcome: 'denied' });
      }
    }
  }
  expect((await driver.download('author', ready.media.id, 'original')).outcome).toBe('permitted');
  // Rejected sample was deleted; uploader visibility does not recreate bytes.
  expect((await row(bad.media.id))?.decision).toBeTruthy();
});

test('parent visibility revocation rechecks even conditional download authorization', async () => {
  const { media } = await available('tiny');
  expect(await driver.reference('author', reference(media))).toBe('permitted');
  const decision = await driver.download('anonymous', media.id, 'derivative');
  expect(decision.outcome).toBe('permitted');
  if (decision.outcome !== 'permitted') throw new Error('Download positive control failed');
  expect((await driver.download('anonymous', media.id, 'derivative', { ifNoneMatch: decision.sha256 })).outcome).toBe(
    'permitted',
  );
  for (const visibility of ['private', 'taken-down'] as const) {
    await driver.setParentVisibility(visibility);
    for (const as of ['anonymous', 'other'] as const) {
      expect(await driver.download(as, media.id, 'derivative')).toEqual({ outcome: 'denied' });
      expect(await driver.download(as, media.id, 'derivative', { ifNoneMatch: decision.sha256 })).toEqual({
        outcome: 'denied',
      });
    }
  }
});

test('reserve replay revokes only parent media:create before receipt lookup', async () => {
  const fixture = await uploaded('tiny');
  const snapshot = await driver.inspect();
  await driver.revokeMediaCreate(fixture.media.containerId);
  expect(await driver.inspect()).toEqual(snapshot);
  await unchanged(() => driver.reserve('author', fixture.input), { outcome: 'denied' });
  // Completion has independent scope/authority, even after creation is revoked.
  await unchanged(() => driver.complete('worker', fixture.completion), 'permitted');
});

test('reservation completion and reference replay denial revoke each commands actual authority', async () => {
  const fixture = await uploaded('tiny');
  const before = await driver.authenticationEvidence('worker', fixture.completion.requestId);
  const snapshot = await driver.inspect();
  await driver.removeWebsiteCompletionScope();
  expect(await driver.inspect()).toEqual(snapshot);
  await unchanged(() => driver.complete('worker', fixture.completion));
  const after = await driver.authenticationEvidence('worker', fixture.completion.requestId);
  expect(after.sub).toBe(before.sub);
  expect(after.clientId).toBe(before.clientId);
  expect(after.registeredWebsiteClientId).toBe(before.registeredWebsiteClientId);
  expect(after.scopes).not.toContain('media:complete');
  expect(after.scopes.slice().sort()).toEqual(before.scopes.filter((scope) => scope !== 'media:complete').sort());
  await unchanged(async () => (await driver.reserve('author', fixture.input)).outcome, 'permitted');
});

test('reference replays revoke only actual post and revision command authority before receipt lookup', async () => {
  for (const kind of ['post', 'revision'] as const) {
    const fixture = await available('tiny');
    const command = reference(fixture.media, { kind });
    expect(await driver.reference('author', command)).toBe('permitted');
    const snapshot = await driver.inspect();
    await driver.revokeReferenceAuthority(fixture.media.containerId, kind);
    expect(await driver.inspect()).toEqual(snapshot);
    await unchanged(() => driver.reference('author', command));
    await unchanged(() => driver.complete('worker', fixture.completion), 'permitted');
  }
});
