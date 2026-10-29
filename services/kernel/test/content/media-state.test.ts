import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createHash } from 'node:crypto';
import { accessCommandAuthorization, type Access, type AccountActor } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { authoritativeTimeValue, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  claimMedia,
  completeMedia,
  readCollectionFence,
  readMediaState,
  readReservation,
  reserveMedia,
  type MediaCompletionInput,
  type MediaReservationInput,
} from '../../src/content/media.ts';
import insertPost from '../../src/content/insert-post.sql';
import insertRevision from '../../src/content/insert-revision.sql';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
const route = 0x4312;
const authorScopes = [
  'media:create',
  'media:complete',
  'media:read_reservation',
  'thread:read',
  'post:read',
  'board:read',
  'post:create',
] as const;
let author: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: 'rezics-website',
  scopes: authorScopes,
  requestedBy: null,
  authnEpoch: 1,
};
let other: AccountActor = { ...author, accountId: newId(0x2345) };
const board = newId(0x9876);
const thread = newId(route);
const secondThread = newId(route);
let access: Access;
const dependencies = () => ({ pool: db.pool, access });
const context = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  requestId: Bun.randomUUIDv7(),
  deadline: Date.now() + 10000,
});
const hash = 'a'.repeat(64);
type ExistingThreadReservationInput = Extract<MediaReservationInput, { containerId: string }>;
const input = (patch: Partial<ExistingThreadReservationInput> = {}): MediaReservationInput => ({
  containerId: thread,
  purpose: 'post-image',
  mediaType: 'image/png',
  byteCount: 256,
  sha256: hash,
  ...patch,
});
const completion = (reservationRequestId: string, patch: Partial<MediaCompletionInput> = {}): MediaCompletionInput => ({
  containerId: thread,
  reservationRequestId,
  byteCount: 256,
  sha256: hash,
  ...patch,
});

async function grant(id: string, action: string, resource = thread) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
    [routeOf(resource), resource, id, action],
  );
}
async function container(id: string) {
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Images','published',1,$3)`,
    [routeOf(id), id, author.accountId, board],
  );
  for (const action of ['media:create', 'thread:read', 'post:create']) await grant(author.accountId, action, id);
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  // These are verified-identity fixture inputs to the real Accounts formula. Full Auth/HTTP binding is a later suite.
  for (const actor of [author, other]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(actor.accountId), actor.accountId],
    );
  }
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Images','published',1,$3)`,
    [routeOf(board), board, author.accountId],
  );
  await grant(author.accountId, 'board:read', board);
  await container(thread);
  await container(secondThread);
  access = admittedAccess({ actions: productionActions() });
  const boundary = { pool: db.pool, deadline: Date.now() + 10_000 };
  author = await authenticateAccount(access, boundary, author);
  other = await authenticateAccount(access, boundary, other);
});
afterAll(() => db?.close());

async function reserved(patch: Partial<ExistingThreadReservationInput> = {}) {
  const request = context();
  const result = await reserveMedia(dependencies(), author, input(patch), request);
  return { id: result.value.mediaId, request, result };
}
async function uploaded(patch: Partial<ExistingThreadReservationInput> = {}) {
  const media = await reserved(patch);
  await completeMedia(
    dependencies(),
    author,
    media.id,
    completion(media.request.idempotencyKey, { containerId: patch.containerId ?? thread }),
    context(),
  );
  return media;
}
async function available(patch: Partial<ExistingThreadReservationInput> = {}) {
  const media = await uploaded(patch);
  // Processing belongs to the following job task. This fixture models its committed state, never a client option.
  await db.admin.query("UPDATE content.media SET state='available' WHERE route=$1 AND media_id=$2", [
    routeOf(media.id),
    media.id,
  ]);
  return media;
}
async function row(id: string) {
  return (await db.admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [routeOf(id), id]))
    .rows[0];
}
async function effects() {
  return (
    await db.admin.query(`SELECT
    (SELECT count(*)::integer FROM content.media) AS media,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events`)
  ).rows[0];
}
async function unchanged(work: () => Promise<unknown>) {
  const before = await effects();
  await expect(work()).rejects.toThrow();
  expect(await effects()).toEqual(before);
}

test('reservation completion and claims follow uploader container and partition authority', async () => {
  const { id, request, result } = await reserved();
  expect(routeOf(id)).toBe(route);
  expect(result.partition).toBe(partitionOf(route));
  expect(await row(id)).toMatchObject({
    container_id: thread,
    uploader_id: author.accountId,
    reservation_request_id: request.idempotencyKey,
    state: 'reserved',
    byte_count: '256',
    declared_sha256: hash,
    sha256: null,
    claimed_at: null,
    key: `m/${id}/original`,
    transaction_id: result.transactionId,
  });
  const before = await effects();
  expect((await reserveMedia(dependencies(), author, input(), request)).value).toEqual({ mediaId: id });
  expect(await effects()).toEqual(before);
  const roles = (
    await db.admin.query(
      'SELECT grant_role,subject_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
      [route, id],
    )
  ).rows;
  expect(roles).toEqual([{ grant_role: 'content.media.owner', subject_id: author.accountId }]);
  const event = (
    await db.admin.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      result.partition,
      result.position.toString(),
    ])
  ).rows;
  expect(event).toEqual([
    {
      type: 'com.rezics.content.media.reserved.v1',
      data: { mediaId: id, containerId: thread, actorId: author.accountId },
    },
  ]);
  const metadata = await readReservation(dependencies(), id, { actor: author, deadline: Date.now() + 5000 });
  expect(metadata).toMatchObject({
    id,
    containerId: thread,
    uploaderId: author.accountId,
    reservationRequestId: request.idempotencyKey,
    byteCount: 256,
    declaredSha256: hash,
    state: 'reserved',
    key: `m/${id}/original`,
  });
  expect(await readReservation(dependencies(), id, { actor: other, deadline: Date.now() + 5000 })).toBeNull();
  expect(await readReservation(dependencies(), newId(route), { actor: other, deadline: Date.now() + 5000 })).toBeNull();
  expect(
    await readReservation(dependencies(), id, { actor: { kind: 'anonymous' }, deadline: Date.now() + 5000 }),
  ).toBeNull();
  expect(
    await readReservation(dependencies(), id, { actor: { ...author, scopes: [] }, deadline: Date.now() + 5000 }),
  ).toBeNull();
  const completeRequest = context();
  const completeInput = completion(request.idempotencyKey);
  const done = await completeMedia(dependencies(), author, id, completeInput, completeRequest);
  expect(done.value).toEqual({ mediaId: id, state: 'uploaded' });
  expect(await row(id)).toMatchObject({ state: 'uploaded', sha256: hash, actual_byte_count: '256' });
  await db.admin.query("UPDATE content.media SET state='available' WHERE route=$1 AND media_id=$2", [route, id]);
  const processed = await row(id);
  expect((await completeMedia(dependencies(), author, id, completeInput, completeRequest)).replayed).toBe(true);
  expect(await row(id)).toEqual(processed);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
    route,
    thread,
    'media:create',
  ]);
  expect((await completeMedia(dependencies(), author, id, completeInput, completeRequest)).replayed).toBe(true);
  await unchanged(() => reserveMedia(dependencies(), author, input(), request));
  await grant(author.accountId, 'media:create');
  await db.admin.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [route, id]);
  await unchanged(() => completeMedia(dependencies(), author, id, completeInput, completeRequest));
});

test('invalid metadata, missing or concealed containers and new-ID grants cannot reserve', async () => {
  for (const patch of [
    { purpose: 'attachment' },
    { mediaType: 'application/octet-stream' },
    { byteCount: -1 },
    { byteCount: 0 },
    { byteCount: 1.5 },
    { byteCount: 20 * 1024 * 1024 + 1 },
    { sha256: 'invalid' },
    { sha256: hash.toUpperCase() },
  ])
    await unchanged(() =>
      reserveMedia(dependencies(), author, input(patch as Partial<ExistingThreadReservationInput>), context()),
    );
  for (const actor of [other, { kind: 'anonymous' } as const])
    await unchanged(() => reserveMedia(dependencies(), actor, input(), context()));
  const missing = newId(route);
  await grant(author.accountId, 'media:create', missing);
  await unchanged(() => reserveMedia(dependencies(), author, input({ containerId: missing }), context()));
  await db.admin.query(
    "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [routeOf(board), board],
  );
  await unchanged(() => reserveMedia(dependencies(), author, input(), context()));
  await db.admin.query(
    "UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [routeOf(board), board],
  );
  const { sha256: declared, ...withoutDigest } = input();
  expect(declared).toBe(hash);
  const optionalRequest = context();
  const optionalResult = await reserveMedia(dependencies(), author, withoutDigest, optionalRequest);
  const optional = { id: optionalResult.value.mediaId, request: optionalRequest };
  expect((await row(optional.id)).declared_sha256).toBeNull();
  await completeMedia(dependencies(), author, optional.id, completion(optional.request.idempotencyKey), context());
  for (const mediaType of ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
    expect((await row((await reserved({ mediaType })).id)).media_type).toBe(mediaType);
});

test('initializer failure rolls back reservation, owner role, receipt and outbox', async () => {
  await db.admin.query(`CREATE FUNCTION public.fail_media_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.grant_role='content.media.owner' THEN RAISE EXCEPTION 'initializer failure'; END IF; RETURN NEW; END $$`);
  await db.admin.query(
    'CREATE TRIGGER fail_media_owner BEFORE INSERT ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION public.fail_media_owner()',
  );
  try {
    await unchanged(() => reserveMedia(dependencies(), author, input(), context()));
  } finally {
    await db.admin.query('DROP TRIGGER fail_media_owner ON access.resource_role_grant');
    await db.admin.query('DROP FUNCTION public.fail_media_owner()');
  }
});

test('reserved uploaded available rejected transitions cannot be forged', async () => {
  const media = await reserved();
  const body = completion(media.request.idempotencyKey);
  for (const actor of [
    other,
    { ...author, clientId: 'other-client' },
    { ...author, scopes: author.scopes.filter((s) => s !== 'media:complete') },
  ])
    await unchanged(() => completeMedia(dependencies(), actor, media.id, body, context()));
  // Even a formula grant cannot turn another verified uploader into this reservation's owner.
  await grant(other.accountId, 'media:complete', media.id);
  await unchanged(() => completeMedia(dependencies(), other, media.id, body, context()));
  for (const patch of [
    { containerId: secondThread },
    { reservationRequestId: 'wrong' },
    { byteCount: 255 },
    { byteCount: -1 },
    { byteCount: 1.5 },
    { sha256: 'b'.repeat(64) },
    { sha256: 'invalid' },
  ])
    await unchanged(() => completeMedia(dependencies(), author, media.id, { ...body, ...patch }, context()));
  expect((await row(media.id)).state).toBe('reserved');
  await completeMedia(dependencies(), author, media.id, body, context());
  for (const state of ['uploaded', 'available', 'rejected']) {
    if (state !== 'uploaded')
      await db.admin.query('UPDATE content.media SET state=$3,decision=$4 WHERE route=$1 AND media_id=$2', [
        route,
        media.id,
        state,
        state === 'rejected' ? 'invalid-image' : null,
      ]);
    const before = await row(media.id);
    await unchanged(() => completeMedia(dependencies(), author, media.id, body, context()));
    expect(await row(media.id)).toEqual(before);
  }
  expect(await readMediaState(db.pool, media.id)).toBe('rejected');
  expect(await readCollectionFence(db.pool, media.id)).toBe(false);
});

async function reference(
  ids: readonly string[],
  options: { containerId?: string; actor?: AccountActor; fail?: boolean; key?: string } = {},
) {
  const actor = options.actor ?? author;
  const target = options.containerId ?? thread;
  const postId = newId(route);
  const revisionId = newId(route);
  const request = context();
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    'post:create',
    { route, id: thread },
    { pool: db.pool, deadline: request.deadline },
    () => new Error('denied'),
  );
  return runCommand(
    db.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: request.deadline,
      authorization,
      receipt: {
        kind: 'content.media-reference',
        key: options.key ?? request.idempotencyKey,
        digest: createHash('sha256')
          .update(JSON.stringify([ids, target]))
          .digest(),
      },
    },
    async (tx, command) => {
      await insertPost.run(tx, {
        route,
        thread_id: thread,
        post_id: postId,
        reply_to_post_id: null,
        author_account_id: actor.accountId,
        head_revision_id: revisionId,
        visibility: 'published',
        security_revision: 1,
        transaction_id: command.transactionId,
      });
      const body = Buffer.from(JSON.stringify(fromPlainText('')));
      await insertRevision.run(tx, {
        route,
        thread_id: thread,
        post_id: postId,
        revision_id: revisionId,
        body,
        body_sha256: createHash('sha256').update(body).digest(),
        search_text: '',
        licence: 'CC0-1.0',
        subject_ids: [],
        board_id: board,
        availability: 'available',
        transaction_id: command.transactionId,
      });
      await claimMedia(tx, { mediaIds: ids, containerId: target, author: actor, itemId: postId, revisionId });
      if (options.fail) throw new Error('referencing command failed');
      return {
        value: { postId, at: authoritativeTimeValue(command.time) },
        events: [
          {
            type: 'com.rezics.content.post.created.v1',
            data: {
              threadId: thread,
              itemId: postId,
              revisionId,
              actorId: actor.accountId,
              ...SUBJECT_THREAD_EVENT_FIELDS,
            },
          },
        ],
      };
    },
  );
}

test('claims use the referencing transaction, actual container, verified author and shared T', async () => {
  const media = await available();
  const requestKey = Bun.randomUUIDv7();
  const result = await reference([media.id], { key: requestKey });
  expect(new Date((await row(media.id)).claimed_at).toISOString()).toBe(new Date(result.value.at).toISOString());
  const before = await row(media.id);
  expect((await reference([media.id], { key: requestKey })).replayed).toBe(true);
  await unchanged(() => reference([media.id]));
  expect(await row(media.id)).toEqual(before);
  const wrongContainer = await available({ containerId: secondThread });
  await unchanged(() => reference([wrongContainer.id]));
  const crossRouteThread = newId(route + 1);
  await container(crossRouteThread);
  const crossRoute = await available({ containerId: crossRouteThread });
  await unchanged(() => reference([crossRoute.id]));
  await unchanged(() => reference(Array.from({ length: 33 }, () => media.id)));
  const unowned = await available();
  await grant(other.accountId, 'post:create');
  await unchanged(() => reference([unowned.id], { actor: other }));
  await expect(
    claimMedia(db.pool, {
      mediaIds: [unowned.id],
      containerId: thread,
      author,
      itemId: newId(route),
      revisionId: newId(route),
    }),
  ).rejects.toThrow();
});

test('claims roll back with referencing command, including mixed lists and collection fences', async () => {
  const good = await available();
  const bad = await uploaded();
  const original = await row(good.id);
  const beforePosts = (await db.admin.query('SELECT count(*) FROM content.post WHERE route=$1', [route])).rows;
  await unchanged(() => reference([good.id, bad.id]));
  await unchanged(() => reference([good.id], { fail: true }));
  expect(await row(good.id)).toEqual(original);
  expect((await db.admin.query('SELECT count(*) FROM content.post WHERE route=$1', [route])).rows).toEqual(beforePosts);
  for (const flag of ['erased', 'collection_pending']) {
    // Erasure is irreversible, so each fence gets its own media identity.
    const fenced = await available();
    await db.admin.query(
      `UPDATE content.media SET ${flag}=true, security_revision=security_revision+1 WHERE route=$1 AND media_id=$2`,
      [route, fenced.id],
    );
    await unchanged(() => reference([fenced.id]));
    expect((await row(fenced.id)).claimed_at).toBeNull();
  }
  expect((await row(good.id)).claimed_at).toBeNull();
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  // Seed work is outside the measured operation. Grow hot-partition and other-route rows together;
  // H, J, input bytes and changed rows stay fixed. Native auto_explain observes all production SQL.
  const report = await checkGrowth(db, {
    name: 'media reserve complete reservation and same-transaction claim',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      for (let index = previous; index < scale; index++) {
        const r = index % 2 === 0 ? route : route + 16;
        const id = newId(r);
        const target = r === route ? thread : newId(r);
        await database.admin.query(
          `INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,state,key,transaction_id)
          VALUES ($1,$2,$3,$4,$5,'post-image','image/png',256,'reserved',$6,$4)`,
          [r, id, target, author.accountId, `distractor-${index}`, `m/${id}/original`],
        );
      }
      await database.admin.query('ANALYZE content.media');
      await database.admin.query('ANALYZE access.resource_role_grant');
    },
    async operation(_database, _scale, repetition) {
      const request = { ...context(), idempotencyKey: `growth-reservation-${repetition}` };
      const media = await reserveMedia(dependencies(), author, input(), request);
      await completeMedia(dependencies(), author, media.value.mediaId, completion(request.idempotencyKey), {
        ...context(),
        idempotencyKey: `growth-completion-${repetition}`,
      });
      expect(
        await readReservation(dependencies(), media.value.mediaId, { actor: author, deadline: Date.now() + 5000 }),
      ).not.toBeNull();
      // The following job owns publication. Fixture state preparation is not counted as product proof.
      await db.admin.query("UPDATE content.media SET state='available' WHERE route=$1 AND media_id=$2", [
        route,
        media.value.mediaId,
      ]);
      await reference([media.value.mediaId], { key: `growth-reference-${repetition}` });
    },
  });
  console.log('GrowthReport', JSON.stringify(report));
  expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
});
