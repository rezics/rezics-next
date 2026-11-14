import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { routeOf } from '../../src/route/route.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { nativeGrantor } from './support/native-system.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: ReturnType<typeof observeSql>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
  observer = observeSql(f.native.pool);
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});

type ObserverInterval = readonly [start: number, end: number];

function readChainProbes(records: readonly SqlExecution[]) {
  return records.filter((row) => row.statement === readChain.sql);
}

// Every authoring success/denial below must use metadata probes only. Reader
// assertions still fetch and verify the exact canonical body independently.
async function write(...args: Parameters<typeof f.native.call>) {
  const start = observer.records.length;
  const result = await f.native.call(...args);
  const probes = readChainProbes(observer.records.slice(start));
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) expect(probe.parameters[readChain.params.indexOf('include_body')]).toBe(false);
  return result;
}

async function replay(...args: Parameters<typeof f.native.call>) {
  const start = observer.records.length;
  const result = await f.native.call(...args);
  expect(readChainProbes(observer.records.slice(start))).toEqual([]);
  return result;
}

// A deliberately nested native operation owns its own SQL reads. Keep those
// records intact while checking every outer attachment probe on either side.
async function writeWithNestedRevision(
  nestedRevisionInterval: () => ObserverInterval | undefined,
  ...args: Parameters<typeof f.native.call>
) {
  const start = observer.records.length;
  const result = await f.native.call(...args);
  const end = observer.records.length;
  const interval = nestedRevisionInterval();
  if (!interval) throw new Error('Expected the injected revision observer interval');

  const [revisionStart, revisionEnd] = interval;
  expect(revisionStart).toBeGreaterThanOrEqual(start);
  expect(revisionEnd).toBeGreaterThan(revisionStart);
  expect(revisionEnd).toBeLessThanOrEqual(end);

  const beforeRevision = observer.records.slice(start, revisionStart);
  const revisionRecords = observer.records.slice(revisionStart, revisionEnd);
  const afterRevision = observer.records.slice(revisionEnd, end);
  const bodyParameter = readChain.params.indexOf('include_body');
  const revisionProbes = readChainProbes(revisionRecords);
  expect(revisionProbes.some((probe) => probe.parameters[bodyParameter] === true)).toBe(true);

  const beforeProbes = readChainProbes(beforeRevision);
  const afterProbes = readChainProbes(afterRevision);
  expect(beforeProbes.length).toBeGreaterThan(0);
  expect(afterProbes.length).toBeGreaterThan(0);
  for (const probe of [...beforeProbes, ...afterProbes]) {
    expect(probe.parameters[bodyParameter]).toBe(false);
  }
  return result;
}

test('publishes an ordered frozen catalogue while preserving Post disclosure and stable occurrence links', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const partId = f.newOccurrenceId();
  const emptyPartId = f.newOccurrenceId();
  const firstId = f.newOccurrenceId();
  const duplicateId = f.newOccurrenceId();
  const secondId = f.newOccurrenceId();
  const protectedId = f.newOccurrenceId();
  const draftId = f.newOccurrenceId();
  const submittedDocument = fromPlainText('Opening');
  const initialBytes = Buffer.from(serializeDocument(submittedDocument), 'utf8');
  const initialSha256 = createHash('sha256').update(initialBytes).digest('hex');
  const firstThread = await f.native.thread('published', submittedDocument);
  const secondThread = await f.native.thread();
  const draftThread = await f.native.thread('draft');
  const first = f.target(firstThread);
  expect(first.sha256).toBe(initialSha256);
  const second = f.target(secondThread);
  const draft = f.target(draftThread);
  const protectedTarget = await f.protectedChapter();
  const placements = [
    { occurrenceId: partId, parentId: null, position: 0, title: 'Part One', kind: 'part' },
    { occurrenceId: firstId, parentId: partId, position: 0, title: 'Chapter One', kind: 'chapter', target: first },
    {
      occurrenceId: duplicateId,
      parentId: partId,
      position: 1,
      title: 'Chapter One, alternate placement',
      kind: 'chapter',
      target: first,
    },
    { occurrenceId: emptyPartId, parentId: null, position: 1, title: 'Empty Part', kind: 'part' },
    { occurrenceId: secondId, parentId: null, position: 2, title: 'Chapter Two', kind: 'chapter', target: second },
    {
      occurrenceId: protectedId,
      parentId: null,
      position: 3,
      title: 'Protected Chapter',
      kind: 'chapter',
      target: protectedTarget,
    },
    { occurrenceId: draftId, parentId: null, position: 4, title: 'Private Draft', kind: 'chapter', target: draft },
  ] as const;
  const createBody = { postId: f.catalogueId, threadId: f.threadId, placements };
  const createKey = crypto.randomUUID();
  const created = await write('POST', '/v1/hostedCatalogues', createBody, { key: createKey });
  expect(created.status, JSON.stringify(created.value)).toBe(201);
  const createReplay = await replay('POST', '/v1/hostedCatalogues', createBody, { key: createKey });
  expect(createReplay.value).toEqual(created.value);

  const privatePage = await f.native.call('GET', `${path}/children?kind=structure`);
  expect(privatePage.status).toBe(200);
  expect(privatePage.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    partId,
    emptyPartId,
    secondId,
    protectedId,
    draftId,
  ]);
  expect(privatePage.value.items.at(-1)).toMatchObject({
    occurrenceId: draftId,
    availability: 'available',
    target: draft,
  });
  expect((await f.native.call('GET', `${path}/children?kind=structure`, undefined, { anonymous: true })).status).toBe(
    404,
  );

  const selected = [partId, firstId, duplicateId, emptyPartId, secondId, protectedId];
  const publishBody = {
    expectedRevisionId: created.value.revisionId,
    expectedPublicationId: null,
    occurrenceIds: selected,
  };
  const publishKey = crypto.randomUUID();
  const published = await write('POST', `${path}:publish`, publishBody, { key: publishKey });
  expect(published.status, JSON.stringify(published.value)).toBe(200);
  const publishReplay = await replay('POST', `${path}:publish`, publishBody, { key: publishKey });
  expect(publishReplay.value).toEqual(published.value);

  expect((await f.native.call('GET', `/v1/posts/${draft.postId}`, undefined, { anonymous: true })).status).toBe(404);
  const root = await f.native.call('GET', `${path}/children`, undefined, { anonymous: true });
  expect(root.status).toBe(200);
  expect(root.value).toMatchObject({ kind: 'publication', revisionId: published.value.revisionId });
  expect(root.value.items).toMatchObject([
    { occurrenceId: partId, position: 0, kind: 'part', availability: 'available', title: 'Part One' },
    { occurrenceId: emptyPartId, position: 1, kind: 'part', availability: 'available', title: 'Empty Part' },
    { occurrenceId: secondId, position: 2, kind: 'chapter', availability: 'available', title: 'Chapter Two' },
    { occurrenceId: protectedId, position: 3, kind: 'chapter', availability: 'unavailable' },
  ]);
  expect(root.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).not.toContain(draftId);
  expect(root.value.items[3]).not.toHaveProperty('title');
  expect(root.value.items[3]).not.toHaveProperty('target');

  const childPage = await f.native.call('GET', `${path}/children?parentId=${partId}`, undefined, { anonymous: true });
  expect(childPage.value.items).toMatchObject([
    { occurrenceId: firstId, parentId: partId, position: 0, availability: 'available', target: first },
    { occurrenceId: duplicateId, parentId: partId, position: 1, availability: 'available', target: first },
  ]);
  const emptyChildren = await f.native.call('GET', `${path}/children?parentId=${emptyPartId}`, undefined, {
    anonymous: true,
  });
  expect(emptyChildren.value.items).toEqual([]);

  const opened = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(opened.status).toBe(200);
  expect(opened.value.document).toEqual({
    encoding: 'base64',
    canonicalBytes: initialBytes.toString('base64'),
    sha256: initialSha256,
    authorId: f.native.author.actor.accountId,
    licence: 'MIT',
  });
  const concealed = await f.native.call(
    'GET',
    `${path}/occurrences/${protectedId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(concealed.value).toMatchObject({
    occurrence: {
      occurrenceId: protectedId,
      parentId: null,
      position: 3,
      kind: 'chapter',
      availability: 'unavailable',
    },
    document: null,
  });
  expect(concealed.value.occurrence).not.toHaveProperty('title');

  const next = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}/navigation?revisionId=${published.value.revisionId}&direction=next`,
    undefined,
    { anonymous: true },
  );
  expect(next.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    duplicateId,
    secondId,
    protectedId,
  ]);
  expect(next.value.items.at(-1)).toMatchObject({ availability: 'unavailable' });
  const previous = await f.native.call(
    'GET',
    `${path}/occurrences/${secondId}/navigation?revisionId=${published.value.revisionId}&direction=previous`,
    undefined,
    { anonymous: true },
  );
  expect(previous.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    duplicateId,
    firstId,
  ]);

  const edited = await f.native.revise(firstThread.firstPost, {});
  expect(edited.status).toBe(200);
  const frozen = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  const frozenBytes = Buffer.from(serializeDocument(submittedDocument), 'utf8');
  const frozenSha256 = createHash('sha256').update(frozenBytes).digest('hex');
  expect(frozenSha256).toBe(first.sha256);
  expect(frozen.value.document).toEqual({
    encoding: 'base64',
    canonicalBytes: frozenBytes.toString('base64'),
    sha256: frozenSha256,
    authorId: f.native.author.actor.accountId,
    licence: 'MIT',
  });

  const movedPlacements = [
    placements[0],
    { ...placements[2], position: 0 },
    placements[3],
    placements[4],
    placements[5],
    placements[6],
    { ...placements[1], parentId: null, position: 5 },
  ] as const;
  const moveBody = { expectedRevisionId: created.value.revisionId, placements: movedPlacements };
  const moveKey = crypto.randomUUID();
  const moved = await write('POST', `${path}:revise`, moveBody, { key: moveKey });
  expect(moved.status).toBe(200);
  const laterBody = {
    expectedRevisionId: moved.value.revisionId,
    placements: movedPlacements.map((item: (typeof movedPlacements)[number]) =>
      item.occurrenceId === secondId ? { ...item, title: 'Chapter Two, revised label' } : item,
    ),
  };
  const later = await write('POST', `${path}:revise`, laterBody, { key: crypto.randomUUID() });
  expect(later.status).toBe(200);
  const moveReplay = await replay('POST', `${path}:revise`, moveBody, { key: moveKey });
  expect(moveReplay.value).toEqual(moved.value);
  const stale = await write('POST', `${path}:revise`, moveBody, { key: crypto.randomUUID() });
  expect(stale.status).toBe(412);
  const movedPage = await f.native.call('GET', `${path}/children?kind=structure&parentId=${partId}`);
  expect(movedPage.value.items).toMatchObject([{ occurrenceId: duplicateId, position: 0 }]);
  const oldAddress = await f.native.call(
    'GET',
    `${path}/children?revisionId=${published.value.revisionId}&parentId=${partId}`,
    undefined,
    { anonymous: true },
  );
  expect(oldAddress.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    firstId,
    duplicateId,
  ]);

  const concurrentBodies = ['Draft A', 'Draft B'].map((title) => ({
    expectedRevisionId: later.value.revisionId,
    placements: movedPlacements.map((item: (typeof movedPlacements)[number]) =>
      item.occurrenceId === secondId ? { ...item, title } : item,
    ),
  }));
  const concurrent = await Promise.all(
    concurrentBodies.map((body) => write('POST', `${path}:revise`, body, { key: crypto.randomUUID() })),
  );
  expect(concurrent.filter((result) => result.status === 200)).toHaveLength(1);
  expect(concurrent.filter((result) => result.status === 412)).toHaveLength(1);

  const winner = concurrent.find((result) => result.status === 200)!;
  const badAttachment = movedPlacements.map((item: (typeof movedPlacements)[number]) =>
    item.occurrenceId === firstId ? { ...item, target: { ...first, sha256: '0'.repeat(64) } } : item,
  );
  const rejected = await write(
    'POST',
    `${path}:revise`,
    {
      expectedRevisionId: winner.value.revisionId,
      placements: badAttachment,
    },
    { key: crypto.randomUUID() },
  );
  expect(rejected.status).toBe(404);
  expect((await f.native.call('GET', `${path}?kind=structure`)).value.revisionId).toBe(winner.value.revisionId);
  expect((await f.native.call('GET', `/v1/posts/${first.postId}`)).status).toBe(200);

  await f.native.command(`/v1/posts/${second.postId}:erase`, { reason: 'Remove chapter source' }, 200);
  const erased = await f.native.call(
    'GET',
    `${path}/occurrences/${secondId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(erased.value).toMatchObject({
    occurrence: { occurrenceId: secondId, availability: 'unavailable' },
    document: null,
  });
});

test('attachment identity mismatches and a changed retained source fail closed without loading bodies', async () => {
  const catalogue = await f.native.thread();
  const chapter = await f.native.thread();
  const target = f.target(chapter);
  const placement = {
    occurrenceId: f.newOccurrenceIdFor(catalogue.id),
    parentId: null,
    position: 0,
    title: 'Chapter',
    kind: 'chapter',
    target,
  };
  const create = (placements: unknown[]) =>
    write('POST', '/v1/hostedCatalogues', {
      postId: catalogue.firstPost.id,
      threadId: catalogue.id,
      placements,
    });
  const nonmatchingRouteId = () => f.newOccurrenceIdFor(target.postId);
  const mismatches = [
    { identity: 'thread', target: { ...target, threadId: nonmatchingRouteId() } },
    { identity: 'revision', target: { ...target, revisionId: nonmatchingRouteId() } },
    { identity: 'digest', target: { ...target, sha256: '0'.repeat(64) } },
  ];
  for (const { identity, target: mismatch } of mismatches) {
    expect(routeOf(mismatch.threadId), identity).toBe(routeOf(mismatch.postId));
    expect(routeOf(mismatch.revisionId), identity).toBe(routeOf(mismatch.postId));
    const start = observer.records.length;
    // The valid duplicate must not shadow this invalid thread/revision/digest.
    const denied = await write('POST', '/v1/hostedCatalogues', {
      postId: catalogue.firstPost.id,
      threadId: catalogue.id,
      placements: [
        { ...placement, target: mismatch },
        { ...placement, occurrenceId: f.newOccurrenceIdFor(catalogue.id), position: 1 },
      ],
    });
    expect(denied.status, identity).toBe(404);
    expect(denied.value, identity).toMatchObject({ code: 'not_found' });
    const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
    const bodyParameter = readChain.params.indexOf('include_body');
    expect(
      probes.filter((probe) => probe.parameters[bodyParameter] === true),
      identity,
    ).toHaveLength(0);
    for (const probe of probes) expect(probe.parameters[bodyParameter], identity).toBe(false);
  }
  const nativeRead = reads.readPostMetadata;
  let changed = false;
  let nestedRevisionInterval: ObserverInterval | undefined;
  const retained = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === target.postId && !changed) {
      changed = true;
      const revisionStart = observer.records.length;
      let revisionStatus: number | undefined;
      try {
        revisionStatus = (await f.native.revise(chapter.firstPost, {})).status;
      } finally {
        nestedRevisionInterval = [revisionStart, observer.records.length];
      }
      expect(revisionStatus).toBe(200);
    }
    return result;
  });
  try {
    // The exact old revision still exists, but its original Post observation changed.
    // The concurrent revision's own body work is outside attachment observation.
    const changedObservation = await writeWithNestedRevision(
      () => nestedRevisionInterval,
      'POST',
      '/v1/hostedCatalogues',
      {
        postId: catalogue.firstPost.id,
        threadId: catalogue.id,
        placements: [placement],
      },
    );
    expect(changedObservation.status).toBe(404);
    expect(changed).toBe(true);
  } finally {
    retained.mockRestore();
    nestedRevisionInterval = undefined;
  }
  // A fresh observation can attach the exact old version without reading the head body.
  expect((await create([placement])).status).toBe(201);
  await f.native.command(`/v1/posts/${target.postId}:erase`, { reason: 'Erase attachment' }, 200);
  const otherCatalogue = await f.native.thread();
  expect(
    (
      await write('POST', '/v1/hostedCatalogues', {
        postId: otherCatalogue.firstPost.id,
        threadId: otherCatalogue.id,
        placements: [{ ...placement, occurrenceId: f.newOccurrenceIdFor(otherCatalogue.id) }],
      })
    ).status,
  ).toBe(404);
});

test('slow attachment admission leaves fresh write authority and rechecks a revoked owner', async () => {
  const catalogue = await f.native.thread();
  const chapter = await f.native.thread();
  const path = `/v1/hostedCatalogues/${catalogue.firstPost.id}`;
  const target = f.target(chapter);
  const placement = {
    occurrenceId: f.newOccurrenceIdFor(catalogue.firstPost.id),
    parentId: null,
    position: 0,
    title: 'Chapter',
    kind: 'chapter',
    target,
  };
  const created = await write('POST', '/v1/hostedCatalogues', {
    postId: catalogue.firstPost.id,
    threadId: catalogue.id,
    placements: [],
  });
  expect(created.status).toBe(201);

  const route = routeOf(catalogue.firstPost.id)!;
  const authorId = f.native.author.actor.accountId;
  const ownerValid = (
    await f.native.pool.query<{ valid: string }>(
      `SELECT valid::text FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'`,
      [route, catalogue.firstPost.id, authorId],
    )
  ).rows[0]!.valid;
  async function revokeOwner() {
    const response = await f.native.system.kernel.handle(
      new Request('https://content.test/v1/roleGrants:revoke', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${nativeGrantor(f.native.system).bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({
          resource: { route, id: catalogue.firstPost.id },
          subject: { kind: 'account', id: authorId },
          role: 'content.post.owner',
          valid: ownerValid,
        }),
      }),
    );
    expect(response.status, await response.text()).toBe(200);
  }

  const nativeRead = reads.readPostMetadata;
  let phase = 0;
  let delayedPhase = -1;
  let ownerRevoked = false;
  const retained = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === target.postId && delayedPhase !== phase) {
      delayedPhase = phase;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      if (phase === 1) {
        await revokeOwner();
        ownerRevoked = true;
      }
    }
    return result;
  });
  try {
    const admitted = await write('POST', `${path}:revise`, {
      expectedRevisionId: created.value.revisionId,
      placements: [placement],
    });
    expect(admitted.status).toBe(200);

    phase = 1;
    const denied = await write('POST', `${path}:revise`, {
      expectedRevisionId: admitted.value.revisionId,
      placements: [{ ...placement, title: 'Revised chapter' }],
    });
    expect([403, 404]).toContain(denied.status);
    expect(ownerRevoked).toBe(true);
    expect((await f.native.call('GET', `${path}?kind=structure`)).value.revisionId).toBe(admitted.value.revisionId);
  } finally {
    retained.mockRestore();
  }
});
