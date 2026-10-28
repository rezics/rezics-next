import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { checkMediaImportStatus, type MediaImportRequest } from '@rezics/definitions/media-import';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import type { SourceFault } from './media-boundary.ts';

const cap = 20 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = (r: number, g: number, b: number) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

test('distinct supplied provider pixels survive native imports, editor selection and public variant serving', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    // The durable importer journal is real SQLite on tmpfs, never a fake receipt store.
    expect(statfsSync(dirname(runtime.importer.session.store.database.filename)).type).toBe(0x01021994);
    const observer = await openApiObserver(runtime);
    const boundary = runtime.mediaBoundary;
    const urls = ['https://lain.bgm.tv/distinct-red.png', 'https://lain.bgm.tv/distinct-blue.png'];
    const originals = [new Uint8Array(await png(220, 20, 20)), new Uint8Array(await png(20, 20, 220))];
    expect(digest(originals[0]!)).not.toBe(digest(originals[1]!));
    for (const [index, url] of urls.entries()) {
      // A Buffer's slice aliases its caller. Both the input and returned bytes
      // are mutated before HTTP fetch to prove the fixture owns its source copy.
      const caller = Buffer.from(originals[index]!);
      const source = await boundary.source(url, undefined, caller);
      expect(source).toEqual({ url, bytes: originals[index]! });
      expect(source.bytes.buffer.byteLength).toBe(source.bytes.byteLength);
      caller.fill(0);
      source.bytes.fill(0);
    }

    const mediaIds: string[] = [];
    const servedDigests = new Map<string, string>();
    let subjectId: string | undefined;
    for (const [index, url] of urls.entries()) {
      await runtime.run({
        source: 'bangumi',
        snapshot: `distinct-${index}`,
        converterRevision: 'distinct-pixels@1',
        bytes: new TextEncoder().encode(
          JSON.stringify({ id: 42, type: 1, name: 'Distinct cover', images: { large: url } }) + '\n',
        ),
      });
      const view = await observer.read('bangumi', '42');
      const proposal = view.proposals.find((p) => p.fieldGroup === 'cover' && !view.retracted.includes(p.id));
      expect(proposal?.statement?.value.type).toBe('value');
      const id = String(proposal!.statement!.value.content);
      expect(mediaIds).not.toContain(id);
      mediaIds.push(id);
      subjectId ??= proposal!.subjectId;
      expect(proposal!.subjectId).toBe(subjectId);
      // A normal editor accepts and adopts the actual imported candidate.
      await observer.adopt('bangumi', '42', 'schema:image', id);
      expect((await observer.read('bangumi', '42')).adopted['schema:image']).toBe(id);

      const captured = runtime.captures.find(
        (c) => new URL(c.request.url).pathname === '/v1/media:importFromUrl' && JSON.parse(c.body).sourceUrl === url,
      );
      expect(captured).toBeDefined();
      const intent = JSON.parse(captured!.body) as MediaImportRequest;
      expect(captured!.request.headers.has('cookie')).toBe(false);
      const actor = await runtime.identity.access.authenticate(
        captured!.request.headers.get('authorization')!.slice(7),
        { pool: runtime.database.pool, deadline: Date.now() + 10_000 },
      );
      expect(actor.kind).toBe('account');
      expect(actor.accountId).toBe(runtime.bulk.accountId);
      const native = await boundary.observe(id);
      expect(native.row).toMatchObject({
        id,
        containerId: subjectId,
        uploaderId: runtime.bulk.accountId,
        purpose: 'cover',
        state: 'available',
        sourceUrl: url,
        credit: intent.credit,
        provenance: intent.provenance,
      });
      expect(native.row.credit).toMatchObject({
        rightsHolder: '(c) rights holder',
        via: { name: 'Bangumi', url: 'https://bgm.tv/subject/42' },
        license: 'LicenseRef-unknown',
      });
      expect(native.row.provenance).toMatchObject({ source: 'bangumi', external_id: '42', field_group: 'cover' });
      expect(native.transitions).toEqual(['reserved', 'uploaded', 'available']);
      expect(native.original).toEqual(originals[index]!);
      expect(native.row.sha256).toBe(digest(originals[index]!));
      const status = await runtime.request(`/v1/media/${id}:importStatus`, undefined, runtime.bulk.bearer);
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(checkMediaImportStatus(body)).toEqual([]);
      expect(body.media).toMatchObject({ id, state: 'available', sha256: digest(originals[index]!) });
      expect(body.media).not.toHaveProperty('sourceUrl');
      expect(native.variants.length).toBeGreaterThan(0);
      expect(native.variants.length).toBeLessThanOrEqual(12);
      for (const variant of native.variants) {
        const slot = `${variant.format}-${variant.width}`;
        const response = await runtime.request(`/v1/media/${id}:authorizeDownload?variant=${slot}`);
        expect(response.status).toBe(200);
        expect(response.headers.has('location')).toBe(false);
        const decision = await response.json();
        expect(decision).toMatchObject({ allowed: true, key: variant.key, sha256: variant.sha256 });
        expect(decision.key).toBe(`m/${id}/${slot}`);
        expect(JSON.stringify(decision)).not.toContain(url);
        const served = await boundary.configuration.storage.get(decision.key);
        expect(served).toEqual(variant.bytes);
        expect(digest(served!)).toBe(variant.sha256);
        expect(digest(served!)).not.toBe(digest(originals[index]!));
        const pixels = await sharp(served!).resize(1, 1).removeAlpha().raw().toBuffer();
        expect(pixels[index === 0 ? 0 : 2]!).toBeGreaterThan(180);
        expect(pixels[index === 0 ? 2 : 0]!).toBeLessThan(60);
        if (index === 0) servedDigests.set(slot, digest(served!));
        else {
          expect(servedDigests.has(slot)).toBe(true);
          expect(digest(served!)).not.toBe(servedDigests.get(slot)!);
        }
      }
      for (const bearer of [undefined, runtime.identity.ordinary.bearer]) {
        const response = await runtime.request(`/v1/media/${id}:authorizeDownload?variant=original`, undefined, bearer);
        expect(response.status).toBe(404);
        expect(await response.json()).not.toHaveProperty('key');
      }
    }
    const capture = await boundary.capture();
    expect(capture.sourceRequests.map((r) => r.url)).toEqual(urls);
    expect(capture.sourceRequests.map((r) => r.bytes)).toEqual(originals.map((b) => b.byteLength));
    expect(capture.sourceRequests.every((r) => !r.headers.has('authorization') && !r.headers.has('cookie'))).toBe(true);
    expect(capture.liveInternetRequests).toEqual([]);
    expect(capture.peakBufferedSourceBytes).toBeLessThanOrEqual(cap);
    expect(capture.sourceInputBackings.every((size) => size <= cap)).toBe(true);
    for (const id of mediaIds) {
      expect(capture.calls.filter((c) => c.mediaId === id).map((c) => c.name)).toEqual(
        expect.arrayContaining(['content.importFromUrl', 'content.image']),
      );
    }

    // Configuration rejects unsafe retention and ambiguity before any source I/O.
    const safe = originals[0]!;
    const unused = 'https://lain.bgm.tv/unused.png';
    await expect(boundary.source('http://lain.bgm.tv/unused.png', undefined, safe)).rejects.toThrow();
    await expect(boundary.source('https://denied.invalid/unused.png', undefined, safe)).rejects.toThrow();
    await expect(boundary.source(unused, undefined, new Uint8Array())).rejects.toThrow();
    const oversized = new Uint8Array(cap + 1);
    await expect(boundary.source(unused, undefined, oversized)).rejects.toThrow();
    await expect(boundary.source(unused, undefined, oversized.subarray(0, safe.length))).rejects.toThrow();
    await expect(boundary.source(unused, undefined, new Uint8Array(new SharedArrayBuffer(128)))).rejects.toThrow();
    await expect(
      boundary.source(unused, undefined, new Uint8Array(new ArrayBuffer(128, { maxByteLength: cap + 1 }))),
    ).rejects.toThrow();
    const faults: SourceFault[] = [
      'redirect-denied-host',
      'redirect-private-ip',
      'redirect-loop',
      'stream-over-20-mib',
      'timeout',
      'over-40-megapixels',
      'corrupt-image',
    ];
    for (const fault of faults) await expect(boundary.source(unused, fault, safe)).rejects.toThrow();
    const normal = await boundary.source(unused);
    expect(normal.bytes).toEqual(new Uint8Array(await png(19, 81, 143)));
    expect((await boundary.capture()).sourceRequests).toEqual(capture.sourceRequests);
  } finally {
    await runtime.close();
  }
}, 600_000);
