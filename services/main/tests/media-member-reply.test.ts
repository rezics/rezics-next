import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ContentCore, contentDraftIntentDigest, type SaveDraftCommand } from '../../content/src/core.ts';
import { authoredDocumentBody } from '../../content/src/document-body.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { verifyImage } from '../src/modules/media/image.ts';
import { sealMediaAdmission } from '../src/modules/media/commands.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { MediaStore, MediaConflict, MediaFenced, MediaMissing, MediaStale,
  DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { DocumentImageUseInput } from '../src/modules/media/presentation.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// A complete local one-pixel PNG, not a source-art or public-delivery fixture.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
let cluster: Awaited<ReturnType<typeof startPostgresCluster>>;
let pool: Pool, content: ContentCore, store: MediaStore;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 8, idle_in_transaction_session_timeout: 30_000 });
  await migrateContent(pool);
  content = new ContentCore(pool); store = new MediaStore(pool, content);
}, 120_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

const admission = (actor: string) => ({ admissionId: randomUUID(), principalId: randomUUID(),
  actingSubject: actor, authorityEpoch: '1', requestDigest: sha(randomUUID()) });

async function upload(actor: string) {
  const input = { asset: null, mediaType: 'image/png' as const, byteLength: image.length,
    sha256: sha(image), disclosure: 'private' as const };
  const reserved = await store.reserveUpload(admission(actor), input);
  const activated = await store.settleUpload(reserved.upload,
    { status: 'activated', ...verifyImage(image, 'image/png'), sha256: sha(image), byteLength: image.length },
    async () => sha(image));
  await store.recordAssetRevision(reserved.upload);
  return { ...reserved, representation: activated.representation };
}

function draftCommand(actor: string, reply: string, variantId: string, rootTarget: string,
  rootRevision: string, expectedHead: string | null, document?: DocumentSnapshot, originRealm?: string) {
  const command: SaveDraftCommand = { operationId: `member-reply:${randomUUID()}`,
    variant: { id: variantId, resourceId: reply, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead, model: 'member-reply-v1', sourceRevision: rootRevision, provenance: {},
    serializedJson: JSON.stringify({ ...authoredDocumentBody(document ? { document } : { body: 'My member reply' }, 8192),
      rootTarget, rootRevision, deleted: false, ...(originRealm ? { originRealm } : {}) }) };
  command.provenance = { kind: 'admitted-original-contribution-v1', author: actor,
    admissionId: randomUUID(), authorityEpoch: '1', scope: `content:draft:${reply}`, expectedHead,
    requestDigest: contentDraftIntentDigest(command, actor), rightsBasis: 'original-contribution' };
  return command;
}

async function replyFixture(originRealm?: string) {
  const actor = native(), reply = native(), rootTarget = native(), rootRevision = native();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await content.saveDraft(draftCommand(actor, reply, variantId, rootTarget, rootRevision, null, undefined, originRealm));
  const media = await upload(actor);
  const input: DocumentImageUseInput = { target: reply, representation: media.representation,
    occurrence: randomUUID(), context: originRealm ?? DEFAULT_MEDIA_CONTEXT, conceal: false,
    memberReplyDraft: { profile: 'member-reply-draft-image-v1', variantId,
      expectedHead: draft.revisionId!, rootTarget, rootRevision } };
  return { actor, reply, variantId, rootTarget, rootRevision, draft, media, input };
}

function imageDocument(input: DocumentImageUseInput, use: string) {
  const document = fromPlainText('My member reply', 'blocks');
  return { ...document, doc: { ...document.doc, content: [...document.doc.content!, { type: 'image', attrs: {
    id: input.occurrence, src: `/api/main/v1/media/representations/${input.representation}`,
    representationId: input.representation, mediaUseId: use, conceal: input.conceal } }] } };
}

test('own acknowledged member reply admits one exact image Use and saves/reopens its text and image', async () => {
  const f = await replyFixture();
  const authority = admission(f.actor);
  const used = await store.presentation.createDocumentUse(authority, f.input);
  expect(used).toMatchObject({ representation: f.media.representation, occurrence: f.input.occurrence, replayed: false });
  const command = draftCommand(f.actor, f.reply, f.variantId, f.rootTarget, f.rootRevision,
    f.draft.revisionId, imageDocument(f.input, used.use));
  const saved = await content.saveDraft(command);
  expect(saved.outcome).toBe('succeeded');
  const reopened = (await content.readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0]!;
  expect(reopened.status).toBe('available');
  if (reopened.status === 'available') {
    expect(reopened.body.body).toBe('My member reply\n');
    expect(reopened.body.document).toEqual(JSON.parse(command.serializedJson).document);
  }
  const replay = await store.presentation.createDocumentUse(authority, f.input);
  expect(replay).toMatchObject({ use: used.use, representation: used.representation, replayed: true, position: used.position });
  const row = (await pool.query('SELECT target,occurrence,representation_id,role FROM media.use WHERE id=$1', [used.use])).rows[0];
  expect(row).toEqual({ target: f.reply, occurrence: f.input.occurrence, representation_id: f.media.representation, role: 'document-image' });
  const event = (await pool.query('SELECT payload FROM content.outbox WHERE operation_id=$1', [`media-document-use:${authority.admissionId}`])).rows[0];
  expect(event.payload.memberReplyDraft).toMatchObject({ ...f.input.memberReplyDraft, draftOperation: expect.any(String) });
  expect((await store.presentation.metadata([{ representation: used.representation, use: used.use }]))[0]!.metadata.ageRating.status)
    .toBe('unassessed');
});

test('missing/foreign drafts and mismatched root, revision, variant and context create no Use', async () => {
  const f = await replyFixture();
  const basis = f.input.memberReplyDraft!;
  for (const [input, actor, failure] of [
    [{ ...f.input, target: native() }, f.actor, MediaMissing],
    [f.input, native(), MediaMissing],
    [{ ...f.input, memberReplyDraft: { ...basis, variantId: `urn:rezics:variant:${randomUUID()}` } }, f.actor, MediaFenced],
    [{ ...f.input, memberReplyDraft: { ...basis, rootTarget: native() } }, f.actor, MediaFenced],
    [{ ...f.input, memberReplyDraft: { ...basis, rootRevision: native() } }, f.actor, MediaFenced],
    [{ ...f.input, context: native() }, f.actor, MediaFenced],
  ] as const) {
    await expect(store.presentation.createDocumentUse(admission(actor), input)).rejects.toBeInstanceOf(failure);
  }
  expect((await pool.query('SELECT count(*)::int AS count FROM media.use WHERE target=$1', [f.reply])).rows[0].count).toBe(0);
});

test('stale draft admission has a durable stale receipt and a fresh intent may use the current head', async () => {
  const f = await replyFixture();
  const next = await content.saveDraft(draftCommand(f.actor, f.reply, f.variantId, f.rootTarget, f.rootRevision, f.draft.revisionId));
  const authority = admission(f.actor);
  await expect(store.presentation.createDocumentUse(authority, f.input)).rejects.toBeInstanceOf(MediaStale);
  await expect(store.presentation.createDocumentUse(authority, f.input)).rejects.toBeInstanceOf(MediaStale);
  expect((await store.readOutcome(`media-document-use:${authority.admissionId}`))?.outcome).toBe('stale_head');
  const current = { ...f.input, memberReplyDraft: { ...f.input.memberReplyDraft!, expectedHead: next.revisionId! } };
  expect((await store.presentation.createDocumentUse(admission(f.actor), current)).replayed).toBe(false);
});

test('representation ownership, availability and occurrence uniqueness remain enforced', async () => {
  const f = await replyFixture(), foreign = await upload(native());
  for (const representation of [randomUUID(), foreign.representation])
    await expect(store.presentation.createDocumentUse(admission(f.actor), { ...f.input, representation })).rejects.toBeInstanceOf(MediaMissing);
  const used = await store.presentation.createDocumentUse(admission(f.actor), f.input);
  await expect(store.presentation.createDocumentUse(admission(f.actor), f.input)).rejects.toBeInstanceOf(MediaConflict);
  await pool.query("UPDATE media.representation SET availability='unavailable' WHERE id=$1", [f.media.representation]);
  await expect(store.presentation.createDocumentUse(admission(f.actor), { ...f.input, occurrence: randomUUID() })).rejects.toBeInstanceOf(MediaMissing);
  expect(used.use).toMatch(/^[0-9a-f-]{36}$/);
});

test('Content still refuses substituted representation, occurrence, Use or reply target on final save', async () => {
  const f = await replyFixture();
  const used = await store.presentation.createDocumentUse(admission(f.actor), f.input);
  const otherReply = await replyFixture();
  for (const [input, use, reply] of [
    [{ ...f.input, representation: randomUUID() }, used.use, f],
    [{ ...f.input, occurrence: randomUUID() }, used.use, f],
    [f.input, randomUUID(), f],
    [f.input, used.use, otherReply],
  ] as const) {
    await expect(content.saveDraft(draftCommand(reply.actor, reply.reply, reply.variantId, reply.rootTarget,
      reply.rootRevision, reply.draft.revisionId, imageDocument(input, use))))
      .rejects.toThrow('document image use does not match');
  }
});

test('a Realm reply binds its actual origin context and legacy Work Use input remains compatible', async () => {
  const f = await replyFixture(native());
  await expect(store.presentation.createDocumentUse(admission(f.actor), { ...f.input, context: DEFAULT_MEDIA_CONTEXT }))
    .rejects.toBeInstanceOf(MediaFenced);
  expect((await store.presentation.createDocumentUse(admission(f.actor), f.input)).replayed).toBe(false);
  const { memberReplyDraft: _basis, ...legacy } = f.input;
  expect((await store.presentation.createDocumentUse(admission(f.actor), { ...legacy, target: native(), occurrence: randomUUID() })).replayed)
    .toBe(false);
});

test('Access cancellation fences the exact member image operation and preserves a committed Use', async () => {
  const f = await replyFixture();
  const registered = (authority: ReturnType<typeof admission>): RegisteredAdmission => ({
    id: authority.admissionId, principalId: authority.principalId, actingSubject: f.actor,
    authorityEpoch: authority.authorityEpoch, requestDigest: authority.requestDigest,
    scope: `content:draft:${f.reply}`, action: 'media.member-reply.use', idempotencyKey: randomUUID(),
    state: 'claimed', dispatchEligible: true, replayed: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const cancelled = admission(f.actor);
  const fenced = await sealMediaAdmission(store, registered(cancelled));
  expect(fenced).toMatchObject({ outcome: 'cancelled', admissionId: cancelled.admissionId,
    receipt: `urn:rezics:receipt:${sha(`${cancelled.admissionId}\0media-document-use`)}` });
  await expect(store.presentation.createDocumentUse(cancelled, f.input)).rejects.toBeInstanceOf(MediaFenced);
  const committed = admission(f.actor);
  const used = await store.presentation.createDocumentUse(committed, f.input);
  expect(await sealMediaAdmission(store, registered(committed))).toMatchObject({ outcome: 'succeeded',
    dataEpoch: used.position.dataEpoch, sequence: used.position.sequence });
  expect((await store.presentation.createDocumentUse(committed, f.input)).use).toBe(used.use);
});
