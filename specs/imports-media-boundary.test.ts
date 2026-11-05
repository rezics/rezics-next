import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  MediaImportAcceptedSchema,
  type MediaImportAccepted,
  type MediaImportRequest,
} from '@rezics/definitions/media-import';
import { convertBangumi } from '../packages/conversion/src/bangumi.ts';
import { convertOpenLibrary } from '../packages/conversion/src/open-library.ts';
import { processImportedMedia } from '../services/kernel/src/content/media-import-job.ts';
import { processImage } from '../services/kernel/src/content/image-job.ts';
import { CONTENT_QUEUES, CONTENT_WORKFLOWS } from '../services/kernel/src/content/work-contract.ts';
import type { SourceFault } from '../services/kernel/test/imports/media-boundary.ts';
import { loadMediaBoundaryDriver, type MediaBoundaryDriver } from './imports-media-boundary-driver.ts';

const { Errors } = createRequire(import.meta.resolve('@rezics/definitions/media-import'))('typebox/schema') as {
  Errors(schema: unknown, value: unknown): [unknown, Iterable<unknown>];
};
// Production's 15s source deadline remains active; wall time is not a cost oracle.
setDefaultTimeout(30_000);
const SOURCE_URL = 'https://lain.bgm.tv/pic/cover/l/ab/cd/42.jpg';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function scenario(action: (d: MediaBoundaryDriver) => Promise<void>) {
  const d = await loadMediaBoundaryDriver();
  try {
    await action(d);
  } finally {
    await d.close();
  }
}
function intent(d: MediaBoundaryDriver, sourceUrl: string): MediaImportRequest {
  const converted = convertBangumi(
    {
      external_id: '42',
      record_revision: 'native:7',
      record: { id: 42, type: 1, name: 'Book', summary: 'Catalogue summary', images: { large: sourceUrl } },
    },
    { source: 'bangumi', subjectId: d.containerId },
  );
  expect(converted.proposals.some((p) => p.op === 'propose' && p.rights?.license === 'CC-BY-SA-3.0')).toBe(true);
  const request = converted.mediaImportIntents[0]!;
  expect(checkMediaImportRequest(request)).toEqual([]);
  return request;
}
async function submit(d: MediaBoundaryDriver, request: MediaImportRequest, key = 'bangumi:42:cover') {
  const response = await d.request(request, key);
  expect(response.status).toBe(202);
  expect([...Errors(MediaImportAcceptedSchema, response.body)[1]]).toEqual([]);
  const accepted = response.body as MediaImportAccepted;
  expect(accepted.media).toMatchObject({ containerId: d.containerId, purpose: 'cover', state: 'reserved' });
  return accepted.media.id;
}
const drain = (d: MediaBoundaryDriver, id: string, redeliver = false) =>
  d.boundary.drain({ mediaIds: [id], maxJobs: 16, signal: new AbortController().signal, redeliver });

test('registered content jobs fetch encoded source bytes and publish actual Sharp derivatives', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const request = intent(d, source.url);
    const id = await submit(d, request);
    expect((await d.boundary.observe(id)).row.state).toBe('reserved');
    await drain(d, id);
    const native = await d.boundary.observe(id);
    const status = await d.status(id);
    expect(status.status).toBe(200);
    expect(checkMediaImportStatus(status.body)).toEqual([]);
    expect(status.body.media.state).toBe('available');
    expect(native.transitions).toEqual(['reserved', 'uploaded', 'available']);
    expect(native.row).toMatchObject({
      id,
      state: 'available',
      purpose: 'cover',
      uploaderId: d.importerId,
      sourceUrl: source.url,
      credit: request.credit,
      provenance: request.provenance,
    });
    // Native media.sha256 measures the original; derivative hashes measure reencoded objects.
    expect(native.original).toEqual(source.bytes);
    expect(native.row.sha256).toBe(digest(source.bytes));
    expect(status.body.media.sha256).toBe(native.row.sha256);
    expect(native.variants.length).toBeGreaterThan(0);
    expect(native.variants.length).toBeLessThanOrEqual(12);
    for (const variant of native.variants) {
      expect(variant.sha256).toBe(digest(variant.bytes));
      expect(variant.sha256).not.toBe(digest(source.bytes));
      expect(variant.byteCount).toBe(variant.bytes.byteLength);
      expect(['avif', 'webp']).toContain(variant.format);
      expect(variant.width * variant.height).toBeLessThanOrEqual(40_000_000);
    }
    const capture = await d.boundary.capture();
    expect(capture.registrations).toEqual(
      expect.arrayContaining([
        { name: CONTENT_WORKFLOWS.importFromUrl, queue: CONTENT_QUEUES.importFromUrl, handler: processImportedMedia },
        { name: CONTENT_WORKFLOWS.image, queue: CONTENT_QUEUES.image, handler: processImage },
      ]),
    );
    expect(capture.registrations).toHaveLength(2);
    expect(capture.sourceRequests.map((r) => r.url)).toEqual([source.url]);
    expect(capture.sourceRequests[0]!.bytes).toBe(source.bytes.byteLength);
    expect(capture.sourceRequests[0]!.headers.has('authorization')).toBe(false);
    expect(capture.sourceRequests[0]!.headers.has('cookie')).toBe(false);
    expect(capture.liveInternetRequests).toEqual([]);
    expect(capture.peakBufferedSourceBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(capture.executedJobs).toBeGreaterThanOrEqual(2);
    expect(capture.executedJobs).toBeLessThanOrEqual(16);
  }));

test('cover credit stays structured and unknown independently of catalogue metadata CC licensing', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const request = intent(d, source.url);
    const id = await submit(d, request);
    await drain(d, id);
    const native = await d.boundary.observe(id);
    expect(native.row.credit).toEqual({
      rightsHolder: '(c) rights holder',
      via: { name: 'Bangumi', url: 'https://bgm.tv/subject/42' },
      license: 'LicenseRef-unknown',
      obligations: [],
    });
    expect(native.row.provenance).toEqual(request.provenance);
    expect(native.fence).toMatchObject({ source: 'bangumi', external_id: '42', field_group: 'cover' });
    expect(native.row.purpose).toBe('cover');
    const disclosure = await d.disclose(id);
    expect(disclosure.status).toBe(200);
    expect(disclosure.headers.has('location')).toBe(false);
    expect(disclosure.url).not.toBe(source.url);
    expect(native.variants.some((v) => digest(disclosure.bytes) === v.sha256)).toBe(true);
    // Provenance may cite the source. It must not become a media delivery hotlink.
    expect((await d.status(id)).body.media).not.toHaveProperty('sourceUrl');
  }));

test('duplicate native event delivery uses one workflow identity and one committed effect', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const id = await submit(d, intent(d, source.url));
    await drain(d, id);
    const before = await d.boundary.observe(id);
    const capture = await d.boundary.capture();
    await drain(d, id, true);
    expect(await d.boundary.observe(id)).toEqual(before);
    const after = await d.boundary.capture();
    expect(after.sourceRequests).toEqual(capture.sourceRequests);
    for (const name of [CONTENT_WORKFLOWS.importFromUrl, CONTENT_WORKFLOWS.image]) {
      const calls = after.calls.filter((c) => c.mediaId === id && c.name === name);
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((c) => c.workflowId)).size).toBe(1);
    }
  }));

test('native Open Library source host uses the same registered content boundary', () =>
  scenario(async (d) => {
    const converted = convertOpenLibrary(
      {
        external_id: '/works/OL42W',
        record_revision: '7',
        record: {
          type: { key: '/type/work' },
          key: '/works/OL42W',
          revision: 7,
          last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05' },
          title: 'Book',
          covers: [42],
        },
      },
      { source: 'openlibrary', subjectId: d.containerId },
    );
    const request = converted.mediaImportIntents[0]!;
    expect(checkMediaImportRequest(request)).toEqual([]);
    expect(request.sourceUrl).toBe('https://covers.openlibrary.org/b/id/42-L.jpg');
    const source = await d.boundary.source(request.sourceUrl);
    expect(source.url).toBe(request.sourceUrl);
    const id = await submit(d, request, 'openlibrary:42:cover');
    await drain(d, id);
    const native = await d.boundary.observe(id);
    expect(native.row).toMatchObject({
      state: 'available',
      uploaderId: d.importerId,
      credit: request.credit,
      provenance: request.provenance,
    });
    expect(native.row.credit.license).toBe('LicenseRef-unknown');
    expect((await d.boundary.capture()).sourceRequests.map((r) => r.url)).toEqual([request.sourceUrl]);
  }));

async function rejected(d: MediaBoundaryDriver, fault: SourceFault, code: string) {
  const source = await d.boundary.source(SOURCE_URL, fault);
  const id = await submit(d, intent(d, source.url));
  await drain(d, id);
  const native = await d.boundary.observe(id);
  expect(native.row.state).toBe('rejected');
  expect(native.transitions).toEqual(
    fault === 'corrupt-image' || fault === 'over-40-megapixels'
      ? ['reserved', 'uploaded', 'rejected']
      : ['reserved', 'rejected'],
  );
  expect(native.variants).toEqual([]);
  const status = await d.status(id);
  expect(checkMediaImportStatus(status.body)).toEqual([]);
  expect(status.body.media).toMatchObject({ state: 'rejected', rejection: { code } });
  expect((await d.disclose(id)).status).not.toBe(200);
  const capture = await d.boundary.capture();
  expect(capture.liveInternetRequests).toEqual([]);
  expect(capture.sourceRequests.length).toBeGreaterThan(0);
  expect(capture.sourceRequests.length).toBeLessThanOrEqual(4);
  if (fault === 'stream-over-20-mib') {
    expect(capture.sourceRequests[0]!.responseHeaders.has('content-length')).toBe(false);
    expect(capture.sourceRequests[0]!.bytes).toBeGreaterThan(20 * 1024 * 1024);
  }
  expect(capture.sourceRequests.every((r) => new URL(r.url).hostname === 'lain.bgm.tv')).toBe(true);
}
test('redirect to an unconfigured host rejects without an available media ID', () =>
  scenario((d) => rejected(d, 'redirect-denied-host', 'source-url')));
test('redirect to private IP rejects through the production URL checks', () =>
  scenario((d) => rejected(d, 'redirect-private-ip', 'source-url')));
test('a fourth redirect rejects at the production redirect cap', () =>
  scenario((d) => rejected(d, 'redirect-loop', 'source-redirect')));
test('streamed source bytes beyond 20 MiB reject without trusting content length', () =>
  scenario((d) => rejected(d, 'stream-over-20-mib', 'source-bytes')));
test('the production source deadline rejects a stalled external response', () =>
  scenario((d) => rejected(d, 'timeout', 'source-timeout')));
test('Sharp rejects encoded input above 40 megapixels', () =>
  scenario((d) => rejected(d, 'over-40-megapixels', 'image-rejected')));
test('Sharp rejects corrupt encoded image data', () => scenario((d) => rejected(d, 'corrupt-image', 'image-rejected')));

test('unconfigured source hosts are rejected before any source HTTP request', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const request = { ...intent(d, source.url), sourceUrl: 'https://denied.invalid/cover.png' };
    const response = await d.request(request, 'bangumi:42:denied');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect([...Errors(MediaImportAcceptedSchema, response.body)[1]].length).toBeGreaterThan(0);
    expect((await d.boundary.capture()).sourceRequests).toEqual([]);
  }));

test('object-store failure leaves actual recoverable state and retries registered work', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const id = await submit(d, intent(d, source.url));
    d.boundary.failNextPut();
    await expect(drain(d, id)).rejects.toThrow();
    expect(['reserved', 'uploaded']).toContain((await d.boundary.observe(id)).row.state);
    expect((await d.disclose(id)).status).not.toBe(200);
    await drain(d, id, true);
    expect((await d.boundary.observe(id)).row.state).toBe('available');
  }));

test('cancelled bounded drain leaves a real reservation recoverable by registered jobs', () =>
  scenario(async (d) => {
    const source = await d.boundary.source(SOURCE_URL);
    const id = await submit(d, intent(d, source.url));
    const controller = new AbortController();
    controller.abort();
    await expect(d.boundary.drain({ mediaIds: [id], maxJobs: 16, signal: controller.signal })).rejects.toThrow();
    expect((await d.boundary.observe(id)).row.state).toBe('reserved');
    await drain(d, id);
    expect((await d.boundary.observe(id)).row.state).toBe('available');
  }));
