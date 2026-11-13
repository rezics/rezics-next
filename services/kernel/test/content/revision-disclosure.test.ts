import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { ContentForbiddenError, ContentNotFoundError } from '../../src/content/commands.ts';
import {
  issueRevisionDisclosure,
  lookupRevisionDisclosure,
  observeIssuedRevisionDisclosure,
  pageRevisionDisclosureErasure,
  publicRevisionDisclosureBaseline,
  readRevisionDisclosure,
  revisionDisclosureReaderGate,
  revokeRevisionDisclosure,
  type RevisionDisclosureDependencies,
} from '../../src/content/revision-disclosure.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);

let f: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  f = await postPublicationFixture();
});
afterAll(async () => {
  await f?.close();
});

function dependencies(): RevisionDisclosureDependencies {
  return {
    pool: f.pool,
    access: f.system.access,
    routeKey: f.system.routeKey,
    clock: () => new Date(),
  };
}

function context(key = crypto.randomUUID()) {
  return { idempotencyKey: key, deadline: Date.now() + 120_000, requestId: crypto.randomUUID() };
}

async function digestOf(postId: string) {
  const row = (
    await f.pool.query<{ sha256: string }>(
      `SELECT encode(r.body_sha256,'hex') AS sha256
       FROM content.post p JOIN content.revision r
         ON r.route=p.route AND r.thread_id=p.thread_id AND r.post_id=p.post_id
        AND r.revision_id=p.head_revision_id
       WHERE p.post_id=$1`,
      [postId],
    )
  ).rows[0];
  if (!row) throw new Error('Missing source digest');
  return row.sha256;
}

async function opening(visibility: 'draft' | 'published' | 'protected') {
  const thread = await f.thread(visibility === 'protected' ? 'published' : visibility);
  if (visibility === 'protected') {
    const created = await f.command('/v1/threads', {
      title: 'Protected opening',
      body: fromPlainText('Protected opening'),
      licence: 'MIT',
      subjectIds: [],
      boardId: f.board.id,
      visibility: 'protected',
    });
    const protectedThread = created.thread as { id: string; firstPost: { id: string; revisionId: string } };
    return {
      threadId: protectedThread.id,
      postId: protectedThread.firstPost.id,
      revisionId: protectedThread.firstPost.revisionId,
      sha256: await digestOf(protectedThread.firstPost.id),
    };
  }
  return {
    threadId: thread.id,
    postId: thread.firstPost.id,
    revisionId: thread.firstPost.revisionId,
    sha256: await digestOf(thread.firstPost.id),
  };
}

test('private draft opening issues, reuses and revokes exact consent without granting read', async () => {
  const deps = dependencies();
  const catalogue = await f.thread('published');
  const target = await opening('draft');
  const input = { catalogueId: catalogue.firstPost.id, target };
  const key = crypto.randomUUID();
  const issued = await issueRevisionDisclosure(deps, f.author.actor, input, context(key));
  expect(issued.value.state).toBe('issued');
  expect(issued.value.reused).toBe(false);
  expect(issued.value.durableInitiator).toMatch(/^[0-9a-f]{64}$/);
  const replay = await issueRevisionDisclosure(deps, f.author.actor, input, context(key));
  expect(replay.value.disclosureId).toBe(issued.value.disclosureId);
  const reused = await issueRevisionDisclosure(deps, f.author.actor, input, context(crypto.randomUUID()));
  expect(reused.value).toMatchObject({ disclosureId: issued.value.disclosureId, reused: true, state: 'issued' });
  const found = await lookupRevisionDisclosure(deps, input, { deadline: Date.now() + 30_000 });
  expect(found?.disclosureId).toBe(issued.value.disclosureId);
  const live = await observeIssuedRevisionDisclosure(deps, input, { deadline: Date.now() + 30_000 });
  expect(live?.state).toBe('issued');
  expect(
    revisionDisclosureReaderGate(live!, {
      catalogueId: input.catalogueId,
      publicationId: newId(routeOf(input.catalogueId)!),
      occurrenceId: newId(routeOf(input.catalogueId)!),
      sourceRevisionId: target.revisionId,
    }),
  ).not.toBeNull();
  expect(publicRevisionDisclosureBaseline('published')).toBe('public-eligibility');
  expect(publicRevisionDisclosureBaseline('draft')).toBe('consent-required');
  expect((await f.call('GET', `/v1/posts/${target.postId}`, undefined, { anonymous: true })).status).toBe(404);
  expect((await f.call('GET', `/v1/posts/${target.postId}`, undefined, { other: true })).status).toBe(404);
  const client = await f.pool.connect();
  let page;
  try {
    page = await pageRevisionDisclosureErasure(
      client,
      { kind: 'post', id: target.postId },
      { deadline: Date.now() + 30_000 },
    );
  } finally {
    client.release();
  }
  expect(page.items.map((row) => row.disclosureId)).toContain(issued.value.disclosureId);
  const revoked = await revokeRevisionDisclosure(
    deps,
    f.author.actor,
    { disclosureId: issued.value.disclosureId },
    context(),
  );
  expect(revoked.value.state).toBe('revoked');
  expect(await lookupRevisionDisclosure(deps, input, { deadline: Date.now() + 30_000 })).toBeNull();
  const reread = await readRevisionDisclosure(deps, issued.value.disclosureId, {
    actor: f.author.actor,
    deadline: Date.now() + 30_000,
  });
  expect(reread.state).toBe('revoked');
  const again = await issueRevisionDisclosure(deps, f.author.actor, input, context());
  expect(again.value.disclosureId).not.toBe(issued.value.disclosureId);
});

test('protected, mismatched and other-author issue fail; public sources stay on eligibility', async () => {
  const deps = dependencies();
  const catalogue = await f.thread('published');
  const draft = await opening('draft');
  await expect(
    issueRevisionDisclosure(
      deps,
      f.system.actors.other.actor,
      { catalogueId: catalogue.firstPost.id, target: draft },
      context(),
    ),
  ).rejects.toBeInstanceOf(ContentForbiddenError);
  await expect(
    issueRevisionDisclosure(
      deps,
      f.author.actor,
      { catalogueId: catalogue.firstPost.id, target: { ...draft, sha256: '0'.repeat(64) } },
      context(),
    ),
  ).rejects.toBeInstanceOf(ContentNotFoundError);
  const published = await opening('published');
  expect(publicRevisionDisclosureBaseline('published')).toBe('public-eligibility');
  await expect(
    issueRevisionDisclosure(
      deps,
      f.author.actor,
      { catalogueId: catalogue.firstPost.id, target: published },
      context(),
    ),
  ).rejects.toBeInstanceOf(ContentNotFoundError);
  const protectedTarget = await opening('protected');
  await expect(
    issueRevisionDisclosure(
      deps,
      f.author.actor,
      { catalogueId: catalogue.firstPost.id, target: protectedTarget },
      context(),
    ),
  ).rejects.toBeInstanceOf(ContentNotFoundError);
  expect(
    await lookupRevisionDisclosure(
      deps,
      { catalogueId: newId(routeOf(catalogue.firstPost.id)!), target: draft },
      { deadline: Date.now() + 30_000 },
    ),
  ).toBeNull();
});
