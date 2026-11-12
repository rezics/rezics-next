import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import * as reads from '../../src/content/reads.ts';
import { resolveHostedOccurrenceMetadata } from '../../src/content/hosted-chapters-reads.ts';
import type { HostedOccurrenceView } from '../../src/content/hosted-chapters-model.ts';
import readChain from '../../src/content/read-chain.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: ReturnType<typeof observeSql>;
let source: Awaited<ReturnType<typeof f.native.thread>>;
let ids: string[];
let revisionId: string;
let path: string;
const originalDocument = fromPlainText('Opening');
beforeAll(async () => {
  f = await hostedChaptersFixture();
  source = await f.native.thread('published', originalDocument);
  const protectedTarget = await f.protectedChapter();
  ids = Array.from({ length: 4 }, () => f.newOccurrenceId());
  path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: ids.map((occurrenceId, position) => ({
      occurrenceId,
      parentId: null,
      position,
      kind: 'chapter',
      title: `Chapter ${position}`,
      target: position === 1 ? protectedTarget : f.target(source),
    })),
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: ids,
    },
    200,
  );
  revisionId = published.revisionId;
  observer = observeSql(f.native.pool);
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});
const get = (suffix: string) => f.native.call('GET', `${path}${suffix}`, undefined, { anonymous: true });
const unavailable = (position: number): HostedOccurrenceView => ({
  occurrenceId: ids[position]!,
  parentId: null,
  position,
  kind: 'chapter',
  availability: 'unavailable',
});
function bodyProbes(start: number) {
  const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
  expect(probes.length).toBeGreaterThan(0);
  return probes.filter((row) => row.parameters[readChain.params.indexOf('include_body')] === true);
}
const metadata = (position: number) =>
  resolveHostedOccurrenceMetadata(
    {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
      clock: () => new Date(),
    },
    f.catalogueId,
    ids[position]!,
    { revisionId },
    { actor: { kind: 'anonymous' }, deadline: Date.now() + 60_000 },
  );

test('Contents, previous/next and occurrence metadata fetch zero bodies; exact opening fetches one verified body', async () => {
  const start = observer.records.length;
  const nativeRead = reads.readPostMetadata;
  let targetObservations = 0;
  const probe = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    if (args[2] === source.firstPost.id) targetObservations++;
    return nativeRead(...args);
  });
  try {
    const contents = await get('/children');
    expect(contents.status).toBe(200);
    expect(contents.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual(ids);
    expect(contents.value.items[1]).toEqual(unavailable(1));
    expect(targetObservations).toBe(1); // Duplicate placements share the retained native observation.
  } finally {
    probe.mockRestore();
  }
  const next = await get(`/occurrences/${ids[0]}/navigation?direction=next&limit=1`);
  expect(next.status).toBe(200);
  expect(next.value.items).toEqual([unavailable(1)]);
  expect(next.value.nextCursor).toEqual(expect.any(String));
  const continued = await get(
    `/occurrences/${ids[0]}/navigation?direction=next&limit=1&cursor=${encodeURIComponent(next.value.nextCursor)}`,
  );
  expect(continued.value.items[0]).toMatchObject({
    occurrenceId: ids[2],
    availability: 'available',
    target: f.target(source),
  });
  const previous = await get(`/occurrences/${ids[3]}/navigation?direction=previous&limit=2`);
  expect(previous.status).toBe(200);
  expect(previous.value.items[0]).toMatchObject({ occurrenceId: ids[2], availability: 'available' });
  expect(previous.value.items[1]).toEqual(unavailable(1));
  expect((await metadata(0)).value.occurrence).toMatchObject({ availability: 'available', target: f.target(source) });
  expect((await metadata(1)).value.occurrence).toEqual(unavailable(1));
  expect(bodyProbes(start)).toHaveLength(0);
  const beforeOpen = observer.records.length;
  const opened = await get(`/occurrences/${ids[0]}?revisionId=${revisionId}`);
  expect(opened.status).toBe(200);
  expect(bodyProbes(beforeOpen)).toHaveLength(1);
  const bytes = Buffer.from(opened.value.document.canonicalBytes, 'base64');
  expect(bytes.toString('utf8')).toBe(serializeDocument(originalDocument));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.target(source).sha256);
});

test('a changed original source conceals every duplicate, while a fresh exact historical observation remains usable', async () => {
  const nativeRead = reads.readPostMetadata;
  let changed = false;
  const probe = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === source.firstPost.id && !changed) {
      changed = true;
      expect((await f.native.revise(source.firstPost, {})).status).toBe(200);
    }
    return result;
  });
  try {
    const contents = await get('/children');
    expect(contents.status).toBe(200);
    expect(changed).toBe(true);
    expect(contents.value.items).toEqual(ids.map((_, position) => unavailable(position)));
  } finally {
    probe.mockRestore();
  }
  const start = observer.records.length;
  expect((await metadata(0)).value.occurrence).toMatchObject({ availability: 'available', target: f.target(source) });
  expect(bodyProbes(start)).toHaveLength(0);
  const opened = await get(`/occurrences/${ids[0]}?revisionId=${revisionId}`);
  expect(opened.value.document.sha256).toBe(f.target(source).sha256);
});

test('stored digest metadata never certifies altered canonical bytes on exact opening', async () => {
  const nativeRead = reads.readPost;
  // Keep real native disclosure/body acquisition; inject corruption only into the
  // returned document to exercise the independent hosted canonical digest check.
  const probe = spyOn(reads, 'readPost').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === source.firstPost.id && result.value?.availability === 'available')
      return { ...result, value: { ...result.value, body: fromPlainText('Corrupted bytes') } };
    return result;
  });
  try {
    const start = observer.records.length;
    const opened = await get(`/occurrences/${ids[0]}?revisionId=${revisionId}`);
    expect(opened.status).toBe(200);
    expect(opened.value.occurrence).toEqual(unavailable(0));
    expect(opened.value.document).toBeNull();
    expect(bodyProbes(start)).toHaveLength(1);
  } finally {
    probe.mockRestore();
  }
});
