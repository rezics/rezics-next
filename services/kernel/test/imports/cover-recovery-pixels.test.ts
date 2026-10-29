import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import type { CoverSummary } from '../../src/semantic/summaries.ts';
import { openCoverRecovery, isCover, type CoverRecovery } from './cover-native-recovery-fixture.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function mediaOf(command: BatchCommand) {
  if (command.op !== 'propose' || command.statement.value.type !== 'value' ||
      typeof command.statement.value.content !== 'string') throw new Error('Missing native cover reference');
  return command.statement.value.content;
}
function boundCover(f: CoverRecovery) {
  expect(f.covers()).toHaveLength(1);
  const bound = f.covers()[0]!;
  const command = (JSON.parse(bound.bytes) as BatchWriteRequest).commands[0]!;
  expect(isCover(command)).toBe(true);
  expect(command.key).toBe(bound.key);
  return { bound, command, media: mediaOf(command) };
}
function localAck(f: CoverRecovery, key: string) {
  return f.importer.session.store.database.query(
    'SELECT acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?',
  ).get(f.owner.source, f.owner.external_id, key) as { acknowledgement: string };
}
async function pixels(bytes: Uint8Array, channel: number) {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(3);
  expect(info.width).toBeGreaterThan(0);
  expect(info.height).toBeGreaterThan(0);
  const means = [0, 0, 0];
  for (let i = 0; i < data.length; i++) means[i % 3]! += data[i]! / (info.width * info.height);
  expect(means[channel]!).toBeGreaterThan(200);
  for (const other of [0, 1, 2].filter((value) => value !== channel)) expect(means[other]!).toBeLessThan(40);
}
async function nativeImage(f: CoverRecovery, media: string, version: number, bytes: Uint8Array) {
  const observed = await f.runtime.mediaBoundary.observe(media);
  expect(observed.row).toMatchObject({ id: media, containerId: f.subject(), purpose: 'cover',
    state: 'available', sourceUrl: f.urls[version], sha256: digest(bytes) });
  expect(observed.transitions).toEqual(['reserved', 'uploaded', 'available']);
  expect(observed.original).toEqual(bytes);
  await pixels(observed.original!, version);
  expect(observed.row.credit).toMatchObject({ rightsHolder: '(c) rights holder',
    via: { name: 'Bangumi', url: `https://bgm.tv/subject/${f.owner.external_id}` }, license: 'LicenseRef-unknown' });
  expect(observed.row.provenance).toMatchObject({ ...f.owner, field_group: 'cover' });
  const references = JSON.stringify(observed.row.provenance.references);
  expect(references).toContain(f.urls[version]!);
  expect(references).toContain(`https://bgm.tv/subject/${f.owner.external_id}`);
  expect(f.pending).toContain(media);
  expect(f.resolved).toContain(media);
  expect(observed.variants.length).toBeGreaterThan(0);
  return observed;
}
type SubjectBody = {
  subject: { id: string; statements: Record<string, unknown[]> };
  summary: { cover: CoverSummary | null };
};
async function published(f: CoverRecovery, media: string, version: number, bytes: Uint8Array) {
  const native = await nativeImage(f, media, version, bytes);
  const response = await f.runtime.request(`/v1/subjects/${f.subject()}`);
  expect(response.status).toBe(200);
  expect(response.headers.has('location')).toBe(false);
  const subject = await response.json() as SubjectBody;
  const page = await f.runtime.request('/v1/pages:read', { target: { subject: f.subject() } });
  expect(page.status).toBe(200);
  const body = await page.json() as { subject: string; reads: Record<string, { status: number; body: SubjectBody }> };
  expect(body.subject).toBe(f.subject());
  const read = Object.values(body.reads).find((entry) => entry.body?.subject?.id === f.subject());
  expect(read?.status).toBe(200);
  const hashes: string[] = [];
  for (const surface of [subject, read!.body]) {
    expect(surface.subject.id).toBe(f.subject());
    expect(surface.subject.statements['schema:name']!.length).toBeGreaterThan(0);
    expect(surface.subject.statements['schema:abstract']!.length).toBeGreaterThan(0);
    expect(surface.summary.cover?.media).toBe(media);
    expect(surface.summary.cover?.credit).toEqual(native.row.credit);
    const references = JSON.stringify(surface.subject.statements['schema:image']);
    expect(references).toContain(f.urls[version]!);
    expect(references).toContain(`https://bgm.tv/subject/${f.owner.external_id}`);
    expect(surface.summary.cover!.variants.length).toBeGreaterThan(0);
    for (const variant of surface.summary.cover!.variants) {
      const authorized = await f.runtime.request(`/v1/media/${media}:authorizeDownload?variant=${variant.format}-${variant.width}`);
      expect(authorized.status).toBe(200);
      expect(authorized.headers.has('location')).toBe(false);
      const decision = await authorized.json() as { allowed: boolean; key: string };
      expect(decision.allowed).toBe(true);
      const actual = native.variants.find((entry) => entry.format === variant.format && entry.width === variant.width)!;
      expect(actual).toBeDefined();
      expect(decision.key).toBe(actual.key);
      expect(decision.key).not.toBe(f.urls[version]!);
      const stored = await f.runtime.mediaBoundary.configuration.storage.get(decision.key);
      expect(stored).not.toBeNull();
      expect(stored).toEqual(actual.bytes);
      expect(digest(stored!)).toBe(actual.sha256);
      expect(actual.byteCount).toBe(stored!.byteLength);
      await pixels(stored!, version);
      hashes.push(digest(stored!));
    }
  }
  const original = await f.runtime.request(`/v1/media/${media}:authorizeDownload?variant=original`);
  expect(original.status).toBe(404);
  expect(await original.json()).toMatchObject({ status: 404, code: 'not_found' });
  return hashes;
}
async function replay(f: CoverRecovery, version: number) {
  const bindings = f.covers();
  const acks = structuredClone(f.acknowledgements);
  const receipts = await Promise.all(acks.map((ack) => f.runtime.receipt(ack.command.key)));
  const pending = [...f.pending];
  const capture = await f.runtime.mediaBoundary.capture();
  const media = await Promise.all(pending.map((id) => f.runtime.mediaBoundary.observe(id)));
  expect((await f.run(version)).status).toBe('committed');
  await f.reopen();
  expect((await f.run(version)).status).toBe('committed');
  expect(f.covers()).toEqual(bindings);
  expect(f.acknowledgements).toEqual(acks);
  expect(f.pending).toEqual(pending);
  expect(await Promise.all(acks.map((ack) => f.runtime.receipt(ack.command.key)))).toEqual(receipts);
  expect(await f.runtime.mediaBoundary.capture()).toEqual(capture);
  expect(await Promise.all(pending.map((id) => f.runtime.mediaBoundary.observe(id)))).toEqual(media);
}

test('actual interrupted cover replacement recovers exact acknowledged media and serves distinct recovered and subsequent replacement pixels', async () => {
  const f = await openCoverRecovery();
  try {
    // Factory defaults already exist. Override their exact allowed URLs before any import.
    const sources: Uint8Array[] = [];
    for (const [version, background] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
      const bytes = new Uint8Array(await sharp({ create: { width: 24, height: 16, channels: 3, background } }).png().toBuffer());
      sources.push(bytes);
      expect((await f.runtime.mediaBoundary.source(f.urls[version]!, undefined, bytes)).bytes).toEqual(bytes);
    }
    expect(new Set(sources.map(digest)).size).toBe(3);
    expect((await f.run(0)).status).toBe('committed');
    for (const property of ['schema:name', 'schema:abstract']) {
      const candidate = (await f.listing(property)).candidates.find((entry) => entry.retracted === null);
      expect(candidate).toBeDefined();
      await f.select(property, candidate!.id);
    }
    const red = boundCover(f);
    expect((await f.listing('schema:image')).candidates.some((entry) => entry.id === red.bound.candidate)).toBe(true);
    await f.select('schema:image', red.bound.candidate);
    const redHashes = await published(f, red.media, 0, sources[0]!);

    expect((await f.run(1, true)).status).toBe('interrupted');
    expect(f.faultCount).toBe(1);
    const ack = structuredClone(f.interrupted);
    expect(ack.command.op).toBe('propose');
    expect(isCover(ack.command)).toBe(true);
    if (!('value' in ack.result) || !('candidate' in ack.result.value)) throw new Error('Missing actual native ACK');
    const green = boundCover(f);
    expect(green.bound.candidate).toBe(ack.result.value.candidate);
    expect(green.command).toEqual(ack.command);
    expect(green.media).not.toBe(red.media);
    expect(green.bound.candidate).not.toBe(red.bound.candidate);
    const durable = localAck(f, ack.command.key);
    expect(JSON.parse(durable.acknowledgement)).toEqual({ results: [ack.result] });
    expect(await f.runtime.receipt(ack.command.key)).toBe(ack.receipt);
    const before = await nativeImage(f, green.media, 1, sources[1]!);
    await f.reopen();
    expect(f.covers()).toEqual([green.bound]);
    expect(localAck(f, ack.command.key)).toEqual(durable);
    expect((await f.run(1)).status).toBe('committed');
    expect(f.covers()).toEqual([green.bound]);
    expect(await f.runtime.receipt(ack.command.key)).toBe(ack.receipt);
    expect(await f.runtime.mediaBoundary.observe(green.media)).toEqual(before);
    expect(f.acknowledgements.filter((entry) => entry.command.key === ack.command.key)).toEqual([ack]);
    const retractions = (candidate: string) => f.acknowledgements.filter((entry) => entry.command.op === 'retract' && entry.command.candidate === candidate);
    expect(retractions(green.bound.candidate)).toEqual([]);
    expect(retractions(red.bound.candidate)).toHaveLength(1);
    expect((await f.listing('schema:image')).candidates.filter((entry) => entry.retracted === null).map((entry) => entry.id)).toEqual([green.bound.candidate]);
    expect(f.pending).toHaveLength(2);
    await f.select('schema:image', green.bound.candidate);
    const greenHashes = await published(f, green.media, 1, sources[1]!);
    expect(greenHashes.some((hash) => redHashes.includes(hash))).toBe(false);
    await replay(f, 1);

    expect((await f.run(2)).status).toBe('committed');
    const blue = boundCover(f);
    expect([red.bound.candidate, green.bound.candidate]).not.toContain(blue.bound.candidate);
    expect([red.media, green.media]).not.toContain(blue.media);
    expect(retractions(green.bound.candidate)).toHaveLength(1);
    await f.select('schema:image', blue.bound.candidate);
    const blueHashes = await published(f, blue.media, 2, sources[2]!);
    expect(blueHashes.some((hash) => [...redHashes, ...greenHashes].includes(hash))).toBe(false);
    expect(f.pending).toHaveLength(3);
    expect(new Set(f.pending).size).toBe(3);
    await replay(f, 2);
    expect(await published(f, blue.media, 2, sources[2]!)).toEqual(blueHashes);
    const capture = await f.runtime.mediaBoundary.capture();
    expect(capture.sourceRequests.map((entry) => entry.url)).toEqual(f.urls);
    for (const [version, request] of capture.sourceRequests.entries()) {
      expect(request.bytes).toBe(sources[version]!.byteLength);
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.responseHeaders.has('location')).toBe(false);
      expect([...request.headers.keys()].some((key) => /credit|provenance|metadata|license/.test(key))).toBe(false);
    }
    expect(capture.liveInternetRequests).toEqual([]);
    expect(capture.peakBufferedSourceBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    console.log('cover-recovery-pixels native evidence', JSON.stringify({ interrupted: ack, binding: green.bound,
      media: [red.media, green.media, blue.media], originals: sources.map(digest), derivatives: [redHashes, greenHashes, blueHashes] }));
  } finally {
    await f.close();
  }
}, 600_000);
