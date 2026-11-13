import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText as createPlainText, serializeDocument } from '@rezics/document';
import type { PoolClient } from 'pg';
import { commitHostedVersionRevision } from '../../src/content/hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
} from '../../src/content/hosted-version-store.ts';
import type { HostedVersionPointValue } from '../../src/content/hosted-version-draft-write.ts';
import type { HostedChapterTarget } from '../../src/content/hosted-chapters-model.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import { issueRevisionDisclosure, revokeRevisionDisclosure } from '../../src/content/revision-disclosure.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

type Item = Readonly<{ occurrenceId: string; title: string; target: HostedChapterTarget }>;

const commandContext = (idempotencyKey = crypto.randomUUID()) => ({
  deadline: Date.now() + 120_000,
  idempotencyKey,
  requestId: crypto.randomUUID(),
});

async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await f.native.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function targetFor(thread: Awaited<ReturnType<typeof f.native.thread>>): Promise<HostedChapterTarget> {
  const revisionId = thread.firstPost.revisionId;
  const digest = await f.native.pool.query<{ sha256: string }>(
    `SELECT encode(r.body_sha256,'hex') AS sha256
     FROM content.revision r WHERE r.route=$1 AND r.thread_id=$2 AND r.post_id=$3 AND r.revision_id=$4`,
    [routeOf(thread.id), thread.id, thread.firstPost.id, revisionId],
  );
  const sha256 = digest.rows[0]?.sha256;
  if (!sha256) throw new Error('Missing exact hosted source digest');
  return { threadId: thread.id, postId: thread.firstPost.id, revisionId, sha256 };
}

function tree(
  index: VersionedOutlineSequenceReadWriteSet<HostedVersionPointValue>,
  items: readonly Item[],
  start = 0,
  end = items.length,
  parentId: string | null = null,
): Readonly<{ rootId: string | null; height: number; count: bigint }> {
  if (start >= end) return { rootId: null, height: 0, count: 0n };
  const middle = Math.floor((start + end) / 2);
  const item = items[middle]!;
  const left = tree(index, items, start, middle, item.occurrenceId);
  const right = tree(index, items, middle + 1, end, item.occurrenceId);
  const node: VersionedOutlineSequenceNode<HostedVersionPointValue> = {
    id: item.occurrenceId,
    value: {
      kind: 'chapter',
      title: item.title,
      subtreeHeight: 0,
      chapterCount: 1n,
      target: item.target,
    },
    leftId: left.rootId,
    rightId: right.rootId,
    treeParentId: parentId,
    height: Math.max(left.height, right.height) + 1,
    count: left.count + right.count + 1n,
    chapterWeight: 1n,
    chapterCount: left.count + right.count + 1n,
  };
  index.writeNode(node);
  return { rootId: node.id, height: node.height, count: node.count };
}

/** Seed an immutable ordered fixture using the production version writer and revision CAS. */
async function seedVersion(
  catalogueId: string,
  items: readonly Item[],
  revisionKind: 'structure' | 'publication',
  expectedDraftRevisionId: string,
  expectedPublicationId: string | null = null,
): Promise<string> {
  const route = routeOf(catalogueId);
  if (route === null) throw new Error('Invalid hosted fixture catalogue route');
  const generationKind = revisionKind === 'structure' ? 'draft' : 'candidate';
  const revisionId = newId(route);
  const generationId = newId(route);
  return transaction(async (tx) => {
    const empty = await createHostedVersionGeneration(tx, catalogueId, generationId, generationKind);
    const write = createHostedVersionWrite<HostedVersionPointValue>(tx, empty);
    const siblings = hostedVersionSequence(write, 'sibling');
    const preorder = hostedVersionSequence(write, 'preorder');
    const chapters = hostedVersionSequence(write, 'chapter');
    const siblingRoot = tree(siblings, items).rootId;
    const preorderRoot = tree(preorder, items).rootId;
    const chapterRoot = tree(chapters, items).rootId;

    for (const item of items) {
      stageHostedVersionOccurrence(write, item.occurrenceId, {
        parentOccurrenceId: null,
        subtreeSize: 1n,
        value: {
          kind: 'chapter',
          title: item.title,
          subtreeHeight: 0,
          chapterCount: 1n,
          target: item.target,
        },
      });
    }
    stageHostedVersionSiblingRoot(write, null, siblingRoot);
    stageHostedVersionSnapshotRoots(write, {
      preorderRootId: preorderRoot,
      chapterRootId: chapterRoot,
      placementCount: BigInt(items.length),
      chapterCount: BigInt(items.length),
    });
    const snapshot = await commitHostedVersionWrite(tx, write);
    if (revisionKind === 'structure') {
      if (generationKind !== 'draft') throw new Error('Structure fixture must use a draft generation');
      await commitHostedVersionRevision(tx, {
        revisionId,
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        revisionKind,
        expectedDraftRevisionId,
        snapshot: {
          route,
          catalogueId,
          generationId,
          generationKind: 'draft',
          sequence: snapshot.sequence,
        },
      });
    } else {
      if (generationKind !== 'candidate') throw new Error('Publication fixture must use a candidate generation');
      await commitHostedVersionRevision(tx, {
        revisionId,
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        revisionKind,
        expectedDraftRevisionId,
        expectedPublicationId,
        snapshot: {
          route,
          catalogueId,
          generationId,
          generationKind: 'candidate',
          sequence: snapshot.sequence,
        },
      });
    }
    return revisionId;
  });
}

async function createOrderedBook(
  catalogueId: string,
  threadId: string,
  draftItems: readonly Item[],
  publicItems: readonly Item[],
) {
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId,
    placements: draftItems.map((item, position) => ({
      occurrenceId: item.occurrenceId,
      parentId: null,
      position,
      title: item.title,
      kind: 'chapter',
      target: item.target,
    })),
  });
  const draftRevisionId = await seedVersion(catalogueId, draftItems, 'structure', created.revisionId as string);
  const publicationId = await seedVersion(catalogueId, publicItems, 'publication', draftRevisionId);
  return { draftRevisionId, publicationId };
}

function resolutionPath(catalogueId: string, occurrenceId: string, revisionId: string) {
  return `/v1/hostedCatalogues/${catalogueId}/occurrences/${occurrenceId}?kind=publication&revisionId=${revisionId}`;
}

function metadataPath(catalogueId: string, occurrenceId: string, revisionId: string) {
  return `/v1/hostedCatalogues/${catalogueId}/occurrences/${occurrenceId}/metadata?kind=publication&revisionId=${revisionId}`;
}

function canonicalBytes(value: ReturnType<typeof fromPlainText>): string {
  return Buffer.from(serializeDocument(value), 'utf8').toString('base64');
}

const plainTextDocuments = new Map<string, ReturnType<typeof createPlainText>>();
function fromPlainText(text: string): ReturnType<typeof createPlainText> {
  const existing = plainTextDocuments.get(text);
  if (existing) return existing;
  const document = createPlainText(text);
  plainTextDocuments.set(text, document);
  return document;
}

test('native point HTTP publishes, replaces and reads only exact ordered Book selections', async () => {
  const publicA = await f.native.thread('published', fromPlainText('Public source A'));
  const publicB = await f.native.thread('published', fromPlainText('Public sibling B'));
  const privateSource = await f.native.thread('draft', fromPlainText('Private source C'));
  const [targetA, targetB, privateTarget] = await Promise.all([
    targetFor(publicA),
    targetFor(publicB),
    targetFor(privateSource),
  ]);
  const route = routeOf(f.catalogueId)!;
  const chapterA = { occurrenceId: newId(route), title: 'Public A', target: targetA };
  const siblingB = { occurrenceId: newId(route), title: 'Public B', target: targetB };
  const privateC = { occurrenceId: newId(route), title: 'Private C', target: privateTarget };
  const privateC2 = { occurrenceId: newId(route), title: 'Private C duplicate', target: privateTarget };
  const initialDraft = [chapterA, siblingB, privateC, privateC2];
  const { draftRevisionId, publicationId: initialPublicationId } = await createOrderedBook(
    f.catalogueId,
    f.threadId,
    initialDraft,
    [chapterA, siblingB, privateC],
  );
  const bookPath = `/v1/hostedCatalogues/${f.catalogueId}`;

  const privateBeforeConsent = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, privateC.occurrenceId, initialPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateBeforeConsent.status).toBe(200);
  expect(privateBeforeConsent.value.occurrence).toEqual({
    occurrenceId: privateC.occurrenceId,
    parentId: null,
    position: 2,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(privateBeforeConsent.value.document).toBeNull();
  const privateMetadataBeforeConsent = await f.native.call(
    'GET',
    metadataPath(f.catalogueId, privateC.occurrenceId, initialPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateMetadataBeforeConsent.value.occurrence.availability).toBe('unavailable');
  expect(privateMetadataBeforeConsent.value.occurrence).not.toHaveProperty('title');
  expect(privateMetadataBeforeConsent.value.occurrence).not.toHaveProperty('target');

  const contentDependencies = {
    pool: f.native.pool,
    access: f.native.system.access,
    tokens: f.native.system.tokenKeys,
    routeKey: f.native.system.routeKey,
    clock: () => new Date(),
  };
  const consent = await issueRevisionDisclosure(
    contentDependencies,
    f.native.author.actor,
    { catalogueId: f.catalogueId, target: privateTarget },
    commandContext(),
  );
  const privateAfterConsent = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, privateC.occurrenceId, initialPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateAfterConsent.status).toBe(200);
  expect(privateAfterConsent.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Private source C')));
  const privateMetadataAfterConsent = await f.native.call(
    'GET',
    metadataPath(f.catalogueId, privateC.occurrenceId, initialPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateMetadataAfterConsent.value.occurrence).toMatchObject({
    occurrenceId: privateC.occurrenceId,
    availability: 'available',
    target: privateTarget,
  });

  const publicRead = await f.native.call('GET', `/v1/posts/${targetA.postId}`, undefined, { anonymous: true });
  expect(publicRead.status).toBe(200);
  const publicBookRead = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, chapterA.occurrenceId, initialPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(publicBookRead.status).toBe(200);
  expect(publicBookRead.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Public source A')));

  const publishInput = {
    expectedRevisionId: draftRevisionId,
    expectedPublicationId: initialPublicationId,
    occurrenceId: privateC2.occurrenceId,
    target: privateTarget,
    parentId: null,
    beforeOccurrenceId: null,
    selectedAncestors: [],
  };
  const publishKey = crypto.randomUUID();
  const published = await f.native.call('POST', `${bookPath}:publishChapter`, publishInput, { key: publishKey });
  expect(published.status).toBe(200);
  const firstPublicationId = published.value.revisionId as string;
  expect(
    (
      await f.native.call('GET', resolutionPath(f.catalogueId, privateC2.occurrenceId, firstPublicationId), undefined, {
        anonymous: true,
      })
    ).value.document.canonicalBytes,
  ).toBe(canonicalBytes(fromPlainText('Private source C')));

  const revisedA = await f.native.revise(publicA.firstPost, { body: fromPlainText('Public source A revised') });
  expect(revisedA.status).toBe(200);
  const revisedTargetA: HostedChapterTarget = {
    ...targetA,
    revisionId: revisedA.value.post.revisionId as string,
    sha256: (
      await f.native.pool.query<{ sha256: string }>(
        `SELECT encode(r.body_sha256,'hex') AS sha256 FROM content.revision r
         WHERE r.route=$1 AND r.thread_id=$2 AND r.post_id=$3 AND r.revision_id=$4`,
        [routeOf(targetA.postId), targetA.threadId, targetA.postId, revisedA.value.post.revisionId],
      )
    ).rows[0]!.sha256,
  };
  const nextDraftItems: readonly Item[] = [{ ...chapterA, target: revisedTargetA }, siblingB, privateC, privateC2];
  const nextDraftRevisionId = await seedVersion(
    f.catalogueId,
    nextDraftItems,
    'structure',
    draftRevisionId,
    firstPublicationId,
  );
  const replacement = await f.native.call('POST', `${bookPath}:replacePublishedChapter`, {
    expectedRevisionId: nextDraftRevisionId,
    expectedPublicationId: firstPublicationId,
    occurrenceId: chapterA.occurrenceId,
    target: revisedTargetA,
  });
  expect(replacement.status).toBe(200);
  const nextPublicationId = replacement.value.revisionId as string;

  const newExact = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, chapterA.occurrenceId, nextPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(newExact.value.occurrence.target).toEqual(revisedTargetA);
  expect(newExact.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Public source A revised')));
  const oldExact = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, chapterA.occurrenceId, firstPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(oldExact.value.occurrence.target).toEqual(targetA);
  expect(oldExact.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Public source A')));
  const currentChildren = await f.native.call(
    'GET',
    `${bookPath}/children?kind=publication&revisionId=${nextPublicationId}`,
    undefined,
    { anonymous: true },
  );
  expect(currentChildren.value.items[1]).toMatchObject({
    occurrenceId: siblingB.occurrenceId,
    target: targetB,
    position: 1,
  });
  expect(currentChildren.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    chapterA.occurrenceId,
    siblingB.occurrenceId,
    privateC.occurrenceId,
    privateC2.occurrenceId,
  ]);

  const replay = await f.native.call('POST', `${bookPath}:publishChapter`, publishInput, { key: publishKey });
  expect(replay.status).toBe(200);
  expect(replay.value).toEqual(published.value);
  const stale = await f.native.call('POST', `${bookPath}:publishChapter`, publishInput, { key: crypto.randomUUID() });
  expect(stale.status).toBe(412);

  const directPrivate = await f.native.call('GET', `/v1/posts/${privateTarget.postId}`, undefined, { anonymous: true });
  expect(directPrivate.status).toBe(404);
  const otherCatalogue = await f.native.thread('published');
  const otherPrivate = {
    occurrenceId: newId(routeOf(otherCatalogue.firstPost.id)!),
    title: 'Other Book',
    target: privateTarget,
  };
  const otherHead = await createOrderedBook(
    otherCatalogue.firstPost.id,
    otherCatalogue.id,
    [otherPrivate],
    [otherPrivate],
  );
  const otherBookRead = await f.native.call(
    'GET',
    resolutionPath(otherCatalogue.firstPost.id, otherPrivate.occurrenceId, otherHead.publicationId),
    undefined,
    { anonymous: true },
  );
  expect(otherBookRead.status).toBe(200);
  expect(otherBookRead.value.occurrence).toEqual({
    occurrenceId: otherPrivate.occurrenceId,
    parentId: null,
    position: 0,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(otherBookRead.value.document).toBeNull();

  await revokeRevisionDisclosure(
    contentDependencies,
    f.native.author.actor,
    { disclosureId: consent.value.disclosureId },
    commandContext(),
  );
  for (const occurrenceId of [privateC.occurrenceId, privateC2.occurrenceId]) {
    const revoked = await f.native.call(
      'GET',
      resolutionPath(f.catalogueId, occurrenceId, nextPublicationId),
      undefined,
      { anonymous: true },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.value.occurrence.availability).toBe('unavailable');
    expect(revoked.value.occurrence).not.toHaveProperty('title');
    expect(revoked.value.occurrence).not.toHaveProperty('target');
    expect(revoked.value.document).toBeNull();
    const revokedMetadata = await f.native.call(
      'GET',
      metadataPath(f.catalogueId, occurrenceId, nextPublicationId),
      undefined,
      { anonymous: true },
    );
    expect(revokedMetadata.value.occurrence.availability).toBe('unavailable');
    expect(revokedMetadata.value.occurrence).not.toHaveProperty('title');
    expect(revokedMetadata.value.occurrence).not.toHaveProperty('target');
  }
});
