import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import type { HostedChapterTarget } from '../../src/content/hosted-chapters-model.ts';
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

async function publishBook(catalogueId: string, threadId: string, items: readonly Item[]) {
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId,
    placements: items.map((item, position) => ({
      occurrenceId: item.occurrenceId,
      parentId: null,
      position,
      title: item.title,
      kind: 'chapter' as const,
      target: item.target,
    })),
  });
  const published = await f.native.command(
    `/v1/hostedCatalogues/${catalogueId}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: items.map((item) => item.occurrenceId),
    },
    200,
  );
  return published.revisionId as string;
}

function resolutionPath(catalogueId: string, occurrenceId: string, revisionId: string) {
  return `/v1/hostedCatalogues/${catalogueId}/occurrences/${occurrenceId}?kind=publication&revisionId=${revisionId}`;
}

function issuePath(postId: string) {
  return `/v1/posts/${postId}:issueRevisionDisclosure`;
}

function revokePath(postId: string) {
  return `/v1/posts/${postId}:revokeRevisionDisclosure`;
}

function canonicalBytes(value: ReturnType<typeof fromPlainText>): string {
  return Buffer.from(serializeDocument(value), 'utf8').toString('base64');
}

function unavailable(occurrenceId: string, position: number) {
  return {
    occurrenceId,
    parentId: null,
    position,
    kind: 'chapter',
    availability: 'unavailable',
  };
}

async function send(path: string, body: unknown, key: string, bearer = f.native.author.bearer) {
  return f.native.system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        [IDEMPOTENCY_HEADER]: JSON.stringify(key),
      },
      body: JSON.stringify(body),
    }),
  );
}

test('author issues and revokes exact Book consent over native HTTP without broadening direct Posts', async () => {
  const publicSource = await f.native.thread('published', fromPlainText('Public source A'));
  const privateSource = await f.native.thread('draft', fromPlainText('Private source C'));
  const [publicTarget, privateTarget] = await Promise.all([targetFor(publicSource), targetFor(privateSource)]);
  const publicChapter: Item = {
    occurrenceId: f.newOccurrenceId(),
    title: 'Public A',
    target: publicTarget,
  };
  const privateChapter: Item = {
    occurrenceId: f.newOccurrenceId(),
    title: 'Private C',
    target: privateTarget,
  };
  const publicationId = await publishBook(f.catalogueId, f.threadId, [publicChapter, privateChapter]);
  const otherCatalogue = await f.native.thread('published');
  const otherChapter: Item = {
    occurrenceId: newId(routeOf(otherCatalogue.firstPost.id)!),
    title: 'Other Book',
    target: privateTarget,
  };
  const otherPublicationId = await publishBook(otherCatalogue.firstPost.id, otherCatalogue.id, [otherChapter]);
  const consent = { catalogueId: f.catalogueId, target: privateTarget };
  const sourceIssue = issuePath(privateTarget.postId);
  const sourceRevoke = revokePath(privateTarget.postId);

  const privateBefore = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, privateChapter.occurrenceId, publicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateBefore.status).toBe(200);
  expect(privateBefore.value.occurrence).toEqual(unavailable(privateChapter.occurrenceId, 1));
  expect(privateBefore.value.document).toBeNull();

  expect((await f.native.call('POST', sourceIssue, consent, { anonymous: true })).status).toBe(401);
  expect((await f.native.call('POST', sourceIssue, consent, { other: true })).status).toBe(403);
  expect((await f.native.call('POST', issuePath(f.catalogueId), consent)).status).toBe(404);
  expect(
    (
      await f.native.call('POST', sourceIssue, {
        catalogueId: f.catalogueId,
        target: { ...privateTarget, sha256: '0'.repeat(64) },
      })
    ).status,
  ).toBe(404);
  expect(
    (await f.native.call('POST', issuePath(publicTarget.postId), { catalogueId: f.catalogueId, target: publicTarget }))
      .status,
  ).toBe(404);

  const issueKey = crypto.randomUUID();
  const issuedResponse = await send(sourceIssue, consent, issueKey);
  const issued = (await issuedResponse.json()) as {
    disclosureId: string;
    state: string;
    catalogueId: string;
    reused: boolean;
    durableInitiator?: string;
  };
  expect(issuedResponse.status).toBe(200);
  expect(issuedResponse.headers.get('cache-control')).toBe('private, no-store');
  expect(issuedResponse.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
  expect(issued).toEqual({
    disclosureId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    state: 'issued',
    catalogueId: f.catalogueId,
    reused: false,
    durableInitiator: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const replayResponse = await send(sourceIssue, consent, issueKey);
  expect(replayResponse.status).toBe(200);
  expect(await replayResponse.json()).toEqual(issued);
  expect(replayResponse.headers.get('cache-control')).toBe('private, no-store');
  const reused = await f.native.call('POST', sourceIssue, consent);
  expect(reused.status).toBe(200);
  expect(reused.value).toMatchObject({
    disclosureId: issued.disclosureId,
    state: 'issued',
    catalogueId: f.catalogueId,
    reused: true,
  });
  expect(reused.value).not.toHaveProperty('durableInitiator');

  const privateAfter = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, privateChapter.occurrenceId, publicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateAfter.status).toBe(200);
  expect(privateAfter.value.occurrence).toMatchObject({
    occurrenceId: privateChapter.occurrenceId,
    availability: 'available',
    title: 'Private C',
    target: privateTarget,
  });
  expect(privateAfter.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Private source C')));
  const publicBook = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, publicChapter.occurrenceId, publicationId),
    undefined,
    { anonymous: true },
  );
  expect(publicBook.status).toBe(200);
  expect(publicBook.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Public source A')));
  expect((await f.native.call('GET', `/v1/posts/${privateTarget.postId}`, undefined, { anonymous: true })).status).toBe(
    404,
  );
  expect((await f.native.call('GET', `/v1/posts/${privateTarget.postId}`, undefined, { other: true })).status).toBe(
    404,
  );
  expect((await f.native.call('GET', `/v1/posts/${publicTarget.postId}`, undefined, { anonymous: true })).status).toBe(
    200,
  );
  const otherBook = await f.native.call(
    'GET',
    resolutionPath(otherCatalogue.firstPost.id, otherChapter.occurrenceId, otherPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(otherBook.status).toBe(200);
  expect(otherBook.value.occurrence).toEqual(unavailable(otherChapter.occurrenceId, 0));
  expect(otherBook.value.document).toBeNull();

  const revokeBody = { disclosureId: issued.disclosureId, ...consent };
  expect((await f.native.call('POST', sourceRevoke, revokeBody, { other: true })).status).toBe(403);
  expect((await f.native.call('POST', revokePath(f.catalogueId), revokeBody)).status).toBe(404);
  expect(
    (
      await f.native.call('POST', sourceRevoke, {
        ...revokeBody,
        target: { ...privateTarget, sha256: '0'.repeat(64) },
      })
    ).status,
  ).toBe(404);

  const revokeKey = crypto.randomUUID();
  const revokedResponse = await send(sourceRevoke, revokeBody, revokeKey);
  const revoked = await revokedResponse.json();
  expect(revokedResponse.status).toBe(200);
  expect(revokedResponse.headers.get('cache-control')).toBe('private, no-store');
  expect(revoked).toEqual({
    disclosureId: issued.disclosureId,
    state: 'revoked',
    catalogueId: f.catalogueId,
    reused: false,
  });
  const revokeReplay = await send(sourceRevoke, revokeBody, revokeKey);
  expect(revokeReplay.status).toBe(200);
  expect(await revokeReplay.json()).toEqual(revoked);
  const revokeReused = await f.native.call('POST', sourceRevoke, revokeBody);
  expect(revokeReused.status).toBe(200);
  expect(revokeReused.value).toEqual({
    disclosureId: issued.disclosureId,
    state: 'revoked',
    catalogueId: f.catalogueId,
    reused: true,
  });

  const privateDenied = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, privateChapter.occurrenceId, publicationId),
    undefined,
    { anonymous: true },
  );
  expect(privateDenied.status).toBe(200);
  expect(privateDenied.value.occurrence).toEqual(unavailable(privateChapter.occurrenceId, 1));
  expect(privateDenied.value.document).toBeNull();
  expect((await f.native.call('GET', `/v1/posts/${privateTarget.postId}`, undefined, { anonymous: true })).status).toBe(
    404,
  );
  const publicStill = await f.native.call(
    'GET',
    resolutionPath(f.catalogueId, publicChapter.occurrenceId, publicationId),
    undefined,
    { anonymous: true },
  );
  expect(publicStill.status).toBe(200);
  expect(publicStill.value.document.canonicalBytes).toBe(canonicalBytes(fromPlainText('Public source A')));
  const otherStill = await f.native.call(
    'GET',
    resolutionPath(otherCatalogue.firstPost.id, otherChapter.occurrenceId, otherPublicationId),
    undefined,
    { anonymous: true },
  );
  expect(otherStill.status).toBe(200);
  expect(otherStill.value.occurrence).toEqual(unavailable(otherChapter.occurrenceId, 0));
});
