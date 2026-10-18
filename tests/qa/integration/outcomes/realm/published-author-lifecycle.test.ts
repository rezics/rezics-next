import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/published-author-lifecycle.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { type PersonaName, type PersonaSession } from '../../../support/personas.ts';
import { actorQuery, restoreAuthorManagementCorpus, short, type Content } from '../../../support/author-management-fixture.ts';

type Draft = Pick<Content, 'resourceId' | 'variantId' | 'revisionId' | 'byteDigest' | 'sourcePosition'>
  & { predecessor: string; replayed: boolean };
type Exact = { reference: { resourceId: string; variantId: string; revisionId: string;
  byteDigest: string; predecessor: string | null; provenance: { author: string } };
  serializedJson: string; body: unknown };
type Placement = { placement: string; realm: string; reply: string; revisionId: string; author: string };
type EligibilityWithdrawal = { profile: 'content-search-eligibility-withdrawal-v1'; outcome: 'succeeded';
  resourceId: string; variantId: string; publicationDecision: string; withdrawnEligibilityHead: string;
  decision: string; receipt: string; graphDataEpoch: string; graphSequence: string; replayed: boolean };
type PlacementWithdrawal = { profile: 'realm-reply-placement-withdrawal-v1'; realm: string; reply: string;
  revisionId: string; withdrawnPlacement: string; withdrawal: string; replayed: boolean };
describe('AMGT01:', () => {
let fixture: Awaited<ReturnType<typeof restoreAuthorManagementCorpus>>;
setDefaultTimeout(120_000);
// Every body gets a writable copy of the one retained cut; a red predecessor cannot alter its premise.
beforeEach(async () => { fixture = await restoreAuthorManagementCorpus(); }, 600_000);
afterEach(async () => { await fixture?.close(); });

// These assertions deliberately live in proof bodies. Fixture failures never stand in for a red outcome.
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
const exactPath = (revision: string, person?: PersonaSession) => `/v1/content-revisions/${revision}`
  + (person ? `?${actorQuery(person)}` : '');
const draftBody = (content: Content, actingSubject: string, body = 'Corrected original wording.') => ({
  profile: 'content-text-v1', resourceId: content.resourceId, variantId: content.variantId,
  expectedHead: content.revisionId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
  direction: 'ltr', body, actingSubject,
});
const eligibilityBody = (content: Content, actingSubject: string) => ({
  profile: 'content-search-eligibility-withdrawal-v1', resourceId: content.resourceId,
  variantId: content.variantId, publicationDecision: content.publication,
  expectedEligibilityHead: content.eligibility, actingSubject,
});
const placementBody = (placement: Placement, actingSubject: string) => ({
  profile: 'realm-reply-placement-withdrawal-v1', realm: placement.realm, reply: placement.reply,
  expectedHead: placement.placement, expectedRevisionId: placement.revisionId, actingSubject,
});
const placedPath = (realm: string, reply: string, person: PersonaSession) =>
  `/v1/realms/${short(realm)}/replies/${short(reply)}?${actorQuery(person)}`;

// Run denials before owner mutations, so every persona sees the same qualified baseline.
async function readAndDeny(name: Exclude<PersonaName, 'owner'>) {
  const { sessions, metadata } = fixture, person = sessions[name];
  for (const content of [metadata.chapter, metadata.post]) {
    const read = await answer<Exact>(person.main('GET', exactPath(content.revisionId)));
    expect(read.reference).toMatchObject({ resourceId: content.resourceId, variantId: content.variantId,
      revisionId: content.revisionId, byteDigest: content.byteDigest,
      provenance: { author: sessions.owner.actingSubject } });
    const refused = await person.main('POST', '/v1/content-drafts',
      draftBody(content, person.actingSubject ?? sessions.owner.actingSubject!));
    const raw = await refused.text();
    expect(refused.status, raw).toBe(name === 'visitor' ? 401 : 403);
    expect(raw).not.toContain(content.body);
    const metadataEdit = await person.main('POST', '/v1/content-edits', { profile: 'metadata-only-v1',
      work: content.resourceId, expectedHead: content === metadata.chapter ? metadata.chapterWorkRevision : metadata.postWorkRevision,
      title: 'An unauthorized metadata correction', actingSubject: person.actingSubject ?? sessions.owner.actingSubject });
    expect(metadataEdit.status, await metadataEdit.text()).toBe(name === 'visitor' ? 401 : 403);
    const withdrawn = await person.main('POST', '/v1/content-search-eligibility',
      eligibilityBody(content, person.actingSubject ?? sessions.owner.actingSubject!));
    expect(withdrawn.status, await withdrawn.text()).toBe(name === 'visitor' ? 401 : 403);
    expect(await answer<Exact>(person.main('GET', exactPath(content.revisionId)))).toEqual(read);
  }
  const reply = metadata.reply;
  const initial = await answer<{ reply: string; author: string; body: string; revisionId: string }>(
    person.main('GET', `/v1/member-replies/${short(reply.reply)}`));
  expect(initial).toMatchObject({ reply: reply.reply, author: reply.author, body: reply.body, revisionId: reply.revisionId });
  const correction = await person.main('POST', '/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply: reply.reply, variantId: reply.variantId,
    rootTarget: reply.rootTarget, rootRevision: reply.rootRevision, originRealm: null,
    language: 'en', direction: 'ltr', expectedHead: reply.revisionId,
    body: 'An unauthorized correction.', actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
  });
  expect(correction.status, await correction.text()).toBe(name === 'visitor' ? 401 : 403);
  const withdrawal = await person.main('POST', '/v1/realm-reply-placements', placementBody({
    realm: sessions.realm, reply: reply.reply, placement: reply.placement,
    revisionId: reply.revisionId, author: reply.author,
  }, person.actingSubject ?? sessions.owner.actingSubject!));
  expect(withdrawal.status, await withdrawal.text()).toBe(name === 'visitor' ? 401 : 403);
  expect(await answer(person.main('GET', `/v1/member-replies/${short(reply.reply)}`))).toEqual(initial);
}
outcomeTest(declaration, 'visitor', () => readAndDeny('visitor'));
outcomeTest(declaration, 'stranger', () => readAndDeny('stranger'));
outcomeTest(declaration, 'member', () => readAndDeny('member'));
outcomeTest(declaration, 'moderator', () => readAndDeny('moderator'));
outcomeTest(declaration, 'operator', () => readAndDeny('operator'));

outcomeTest(declaration, 'owner', async () => {
  const { sessions, metadata } = fixture, owner = sessions.owner;
  for (const [content, workHead] of [[metadata.chapter, metadata.chapterWorkRevision],
    [metadata.post, metadata.postWorkRevision]] as const) {
    const old = await answer<Exact>(owner.main('GET', exactPath(content.revisionId, owner)));
    const oldMetadata = await answer(owner.main('GET', `/v1/revisions/${short(workHead)}?${actorQuery(owner)}`));
    const body = draftBody(content, owner.actingSubject!, `Corrected ${content.resourceId === metadata.chapter.resourceId ? 'chapter' : 'Post'} wording.`);
    const key = `author-correct-${randomUUID()}`;
    const saved = await answer<Draft>(owner.main('POST', '/v1/content-drafts', body, key), 201);
    expect(saved).toMatchObject({ resourceId: content.resourceId, variantId: content.variantId,
      predecessor: content.revisionId, replayed: false, sourcePosition: { owner: 'content' } });
    expect(saved.revisionId).not.toBe(content.revisionId);
    expect(saved.byteDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.byteDigest).not.toBe(content.byteDigest);
    const replay = await answer<Draft>(owner.main('POST', '/v1/content-drafts', body, key));
    expect(replay).toEqual({ ...saved, replayed: true });
    await answer(owner.main('POST', '/v1/content-drafts', { ...body, body: 'Different retry intent.' }, key), 409);
    await answer(owner.main('POST', '/v1/content-drafts', body), 409);
    const next = await answer<Exact>(owner.main('GET', exactPath(saved.revisionId, owner)));
    expect(next.reference).toMatchObject({ resourceId: content.resourceId, variantId: content.variantId,
      revisionId: saved.revisionId, predecessor: content.revisionId, byteDigest: saved.byteDigest,
      provenance: { author: owner.actingSubject } });
    expect(next.serializedJson).toContain(body.body);
    expect(createHash('sha256').update(next.serializedJson).digest('hex')).toBe(saved.byteDigest);
    expect(await answer<Exact>(owner.main('GET', exactPath(content.revisionId, owner)))).toEqual(old);
    expect(await answer<Exact>(sessions.visitor.main('GET', exactPath(content.revisionId)))).toEqual(old);
    await answer(sessions.visitor.main('GET', exactPath(saved.revisionId)), 404);
    // Correct metadata on the same native Work; a replacement Work is never requested.
    const metadataKey = `author-metadata-${randomUUID()}`;
    const edit = { profile: 'metadata-only-v1', work: content.resourceId, expectedHead: workHead,
      title: 'Corrected original title', actingSubject: owner.actingSubject };
    const receipt = await answer<{ work: string; revision: string; predecessor: string; replayed: boolean }>(
      owner.main('POST', '/v1/content-edits', edit, metadataKey));
    expect(receipt).toMatchObject({ work: content.resourceId, predecessor: workHead, replayed: false });
    expect(receipt.revision).not.toBe(workHead);
    expect(await answer(owner.main('POST', '/v1/content-edits', edit, metadataKey)))
      .toEqual({ ...receipt, replayed: true });
    await answer(owner.main('POST', '/v1/content-edits', edit), 409);
    await answer(owner.main('POST', '/v1/content-edits', { ...edit, title: 'Changed metadata retry intent' }, metadataKey), 409);
    expect(await answer(owner.main('GET', `/v1/revisions/${short(workHead)}?${actorQuery(owner)}`))).toEqual(oldMetadata);
    const refreshed = await answer<{ item: { id: string; workRevision: string; title: { value: string } } }>(
      owner.main('GET', `/v1/me/agents/${short(owner.actingSubject!)}/works/${short(content.resourceId)}`));
    expect(refreshed.item).toMatchObject({ id: content.resourceId, workRevision: receipt.revision,
      title: { value: edit.title } });
  }
  const reply = metadata.reply;
  const oldReply = await answer<Exact>(owner.main('GET', exactPath(reply.revisionId, owner)));
  const request = { profile: 'member-reply-draft-v1', reply: reply.reply, variantId: reply.variantId,
    rootTarget: reply.rootTarget, rootRevision: reply.rootRevision, originRealm: null,
    language: 'en', direction: 'ltr', expectedHead: reply.revisionId,
    body: 'A corrected author reply.', actingSubject: owner.actingSubject };
  const key = `reply-correct-${randomUUID()}`;
  const revision = await answer<{ reply: string; variantId: string; revisionId: string; predecessor: string;
    revisionDigest: string; replayed: boolean }>(owner.main('POST', '/v1/member-reply-drafts', request, key), 201);
  expect(revision).toMatchObject({ reply: reply.reply, variantId: reply.variantId,
    predecessor: reply.revisionId, replayed: false });
  expect(revision.revisionId).not.toBe(reply.revisionId);
  expect(revision.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(revision.revisionDigest).not.toBe(reply.revisionDigest);
  expect(await answer(owner.main('POST', '/v1/member-reply-drafts', request, key))).toEqual({ ...revision, replayed: true });
  await answer(owner.main('POST', '/v1/member-reply-drafts', request), 409);
  await answer(owner.main('POST', '/v1/member-reply-drafts', { ...request, body: 'Changed intent.' }, key), 409);
  const corrected = await answer<Exact>(owner.main('GET', exactPath(revision.revisionId, owner)));
  expect(corrected.reference).toMatchObject({ resourceId: reply.reply, variantId: reply.variantId,
    revisionId: revision.revisionId, predecessor: reply.revisionId, byteDigest: revision.revisionDigest,
    provenance: { author: reply.author } });
  expect(corrected.serializedJson).toContain(request.body);
  expect(createHash('sha256').update(corrected.serializedJson).digest('hex')).toBe(revision.revisionDigest);
  await answer(sessions.visitor.main('GET', exactPath(revision.revisionId)), 404);
  const placement = await answer<Placement>(owner.main('POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: sessions.realm, reply: reply.reply,
    revisionId: revision.revisionId, revisionDigest: revision.revisionDigest,
    expectedHead: reply.placement, reviewDecisionId: null, actingSubject: owner.actingSubject,
  }), 201);
  expect(placement).toMatchObject({ realm: sessions.realm, reply: reply.reply, revisionId: revision.revisionId });
  expect(placement.placement).not.toBe(reply.placement);
  const refreshed = await answer<Placement>(owner.main('GET', placedPath(sessions.realm, reply.reply, owner)));
  expect(refreshed).toMatchObject({ placement: placement.placement, reply: reply.reply,
    revisionId: revision.revisionId, author: reply.author, rootTarget: reply.rootTarget, rootRevision: reply.rootRevision });
  expect(await answer(sessions.visitor.main('GET', exactPath(revision.revisionId)))).toEqual(corrected);
  expect(await answer<Exact>(owner.main('GET', exactPath(reply.revisionId, owner)))).toEqual(oldReply);
  const independent = await answer<Placement>(fixture.independent.moderator.main('GET',
    placedPath(fixture.independent.realm, reply.reply, fixture.independent.moderator)));
  expect(independent).toMatchObject({ placement: metadata.independentPlacement, revisionId: reply.revisionId });
});

test.failing('AMGT01 corrected content republishes the same identity with exact publication and qualification heads', async () => {
  const { sessions, metadata } = fixture, owner = sessions.owner;
  for (const content of [metadata.chapter, metadata.post]) {
    const draft = await answer<Draft>(owner.main('POST', '/v1/content-drafts',
      draftBody(content, owner.actingSubject!, 'A corrected published original.')), 201);
    const head = draft.revisionId;
    expect(head).not.toBe(content.revisionId);
    const exact = await answer<Exact>(owner.main('GET', exactPath(head, owner)));
    const publication = await answer<{ decision: string; status: string }>(owner.main('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', resourceId: content.resourceId, variantId: content.variantId,
      revisionId: head, preparationId: randomUUID(), expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: content.sourcePosition.dataEpoch, expectedPublicationHead: content.publication,
      actingSubject: owner.actingSubject,
    }), 201);
    expect(publication.status).toBe('active');
    const eligibility = await answer<{ outcome: string; decision: string }>(owner.main('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: content.resourceId, variantId: content.variantId,
      publicationDecision: publication.decision, expectedEligibilityHead: content.eligibility,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }), 201);
    expect(eligibility.outcome).toBe('succeeded');
    expect(await answer(sessions.visitor.main('GET', exactPath(head)))).toEqual(exact);
    expect(await answer(owner.main('GET', exactPath(content.revisionId, owner)))).toMatchObject({
      reference: { resourceId: content.resourceId, revisionId: content.revisionId,
        byteDigest: content.byteDigest, provenance: { author: owner.actingSubject } },
    });
    const oldPublic = await sessions.visitor.main('GET', exactPath(content.revisionId));
    expect(oldPublic.status, await oldPublic.text()).toBe(content === metadata.chapter ? 200 : 404);
  }
});

async function withdrawQualification(content: Content): Promise<EligibilityWithdrawal> {
  const owner = fixture.sessions.owner, request = eligibilityBody(content, owner.actingSubject!);
  const key = `qualification-withdraw-${randomUUID()}`;
  const receipt = await answer<EligibilityWithdrawal>(owner.main('POST', '/v1/content-search-eligibility', request, key), 201);
  expect(receipt).toMatchObject({ profile: request.profile, outcome: 'succeeded',
    resourceId: content.resourceId, variantId: content.variantId, publicationDecision: content.publication,
    withdrawnEligibilityHead: content.eligibility, replayed: false });
  expect(receipt.decision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(receipt.decision).not.toBe(content.eligibility);
  expect(receipt.receipt).toBeString();
  expect(receipt.graphDataEpoch).toBeString();
  expect(receipt.graphSequence).toMatch(/^\d+$/);
  expect(await answer(owner.main('POST', '/v1/content-search-eligibility', request, key)))
    .toEqual({ ...receipt, replayed: true });
  const stale = await answer<{ code: string }>(owner.main('POST', '/v1/content-search-eligibility', request), 409);
  expect(stale.code).toBe('stale_eligibility_head');
  const changed = await answer<{ code: string }>(owner.main('POST', '/v1/content-search-eligibility', {
    ...request, publicationDecision: `https://rezics.com/id/${randomUUID()}`,
  }, key), 409);
  expect(changed.code).toBe('idempotency_conflict');
  return receipt;
}

test.failing('AMGT01 qualification withdrawal removes only the selected Post publication support and retains author history', async () => {
  const { sessions, metadata } = fixture, content = metadata.post;
  const old = await answer<Exact>(sessions.owner.main('GET', exactPath(content.revisionId, sessions.owner)));
  const receipt = await withdrawQualification(content);
  await answer(sessions.visitor.main('GET', exactPath(content.revisionId)), 404);
  expect(await answer(sessions.owner.main('GET', exactPath(content.revisionId, sessions.owner)))).toEqual(old);
  const variants = await answer<{ items: { variantId: string; publicationHead: string; eligibilityHead: string }[] }>(
    sessions.owner.main('GET', `/v1/works/${short(content.resourceId)}/content-variants?${actorQuery(sessions.owner)}`));
  expect(variants.items.find(item => item.variantId === content.variantId)?.publicationHead).toBe(content.publication);
  expect(variants.items.find(item => item.variantId === content.variantId)?.eligibilityHead).toBe(receipt.decision);
  // Withdrawing eligibility does not erase the retained publication decision or the native identity.
  const post = await answer<{ id: string }>(sessions.owner.main('GET', `/v1/posts/${short(content.resourceId)}?${actorQuery(sessions.owner)}`));
  expect(post.id).toBe(content.resourceId);
  expect(await answer(sessions.visitor.main('GET', exactPath(metadata.chapter.revisionId)))).toMatchObject({
    reference: { resourceId: metadata.chapter.resourceId } });
});

test.failing('AMGT01 Structure removal qualification withdrawal and independent Work publication withdrawal have distinct effects', async () => {
  const { sessions, metadata } = fixture, owner = sessions.owner, composition = metadata.composition;
  const historyPath = `/v1/compositions/${short(composition.structure)}/revisions/${short(composition.revision)}?${actorQuery(owner)}`;
  const old = await answer<{ occurrences: { occurrence: string }[] }>(owner.main('GET', historyPath));
  expect(old.occurrences.map(item => item.occurrence)).toContain(metadata.chapterOccurrence);
  const removed = await answer<{ revision: string }>(owner.main('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'book-composition', expectedHead: composition.revision, actingSubject: owner.actingSubject,
    operations: [{ op: 'remove', occurrence: metadata.chapterOccurrence }],
  }));
  expect(removed.revision).not.toBe(composition.revision);
  const now = await answer<{ occurrences: { occurrence: string; state: string }[] }>(owner.main('GET',
    `/v1/compositions/${short(composition.structure)}?${actorQuery(owner)}`));
  expect(now.occurrences.filter(item => item.state === 'active').map(item => item.occurrence)).not.toContain(metadata.chapterOccurrence);
  expect(await answer(owner.main('GET', historyPath))).toEqual(old);
  await answer(sessions.visitor.main('GET', exactPath(metadata.chapter.revisionId)));
  // The independent Structure pins the original revision, even if this identity was corrected later.
  const adopted = await answer<{ occurrences: { selection?: { revision: string } }[] }>(owner.main('GET',
    `/v1/compositions/${short(metadata.adoption.structure)}?${actorQuery(owner)}`));
  const pinned = adopted.occurrences.find(item => item.selection)?.selection?.revision;
  expect(pinned).toBeString();
  const preserved = await answer(sessions.visitor.main('GET', exactPath(pinned!)));
  await withdrawQualification(metadata.chapter);
  expect(await answer(sessions.visitor.main('GET', exactPath(pinned!)))).toEqual(preserved);
  const independent = metadata.adoption;
  await answer(owner.main('POST', '/v1/work-publications', { profile: 'work-structure-publication-v1',
    operation: 'withdraw', work: independent.work.work, expectedPublicationHead: independent.publication,
    actingSubject: owner.actingSubject }), 201);
  await answer(sessions.visitor.main('GET', exactPath(pinned!)), 404);
  expect(await answer(owner.main('GET', exactPath(pinned!, owner)))).toEqual(preserved);
  expect(await answer(owner.main('GET', historyPath))).toEqual(old);
});

test.failing('AMGT01 owner placement withdrawal preserves another publisher placement and another author reply', async () => {
  const { sessions, metadata, independent } = fixture, owner = sessions.owner, reply = metadata.reply;
  const current = await answer<Placement>(owner.main('GET', placedPath(sessions.realm, reply.reply, owner)));
  const other = await answer<Placement>(independent.moderator.main('GET', placedPath(independent.realm, reply.reply, independent.moderator)));
  const otherAuthor = await answer(sessions.member.main('GET', `/v1/member-replies/${short(metadata.independentReply.reply)}`));
  // Ownership of the reply does not grant control over another publisher's Realm placement.
  await answer(owner.main('POST', '/v1/realm-reply-placements', placementBody(other, owner.actingSubject!)), 403);
  await answer(owner.main('POST', '/v1/realm-reply-placements', placementBody({ realm: sessions.realm,
    reply: metadata.independentReply.reply, revisionId: metadata.independentReply.revisionId,
    placement: metadata.independentReply.placement, author: metadata.independentReply.author }, owner.actingSubject!)), 403);
  const body = placementBody(current, owner.actingSubject!), key = `placement-withdraw-${randomUUID()}`;
  const mismatchedRevision = await answer<{ code: string }>(owner.main('POST', '/v1/realm-reply-placements', {
    ...body, expectedRevisionId: randomUUID(),
  }), 409);
  expect(mismatchedRevision.code).toBe('realm_reply_stale');
  expect(await answer(owner.main('GET', placedPath(sessions.realm, reply.reply, owner)))).toEqual(current);
  const receipt = await answer<PlacementWithdrawal>(owner.main('POST', '/v1/realm-reply-placements', body, key), 201);
  expect(receipt).toMatchObject({ profile: body.profile, realm: current.realm, reply: current.reply,
    revisionId: current.revisionId, withdrawnPlacement: current.placement, replayed: false });
  expect(receipt.withdrawal).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(receipt.withdrawal).not.toBe(current.placement);
  expect(await answer(owner.main('POST', '/v1/realm-reply-placements', body, key))).toEqual({ ...receipt, replayed: true });
  const stale = await answer<{ code: string }>(owner.main('POST', '/v1/realm-reply-placements', body), 409);
  expect(stale.code).toBe('realm_reply_stale');
  const changed = await answer<{ code: string }>(owner.main('POST', '/v1/realm-reply-placements', {
    ...body, realm: independent.realm,
  }, key), 409);
  expect(changed.code).toBe('idempotency_conflict');
  await answer(owner.main('GET', placedPath(sessions.realm, reply.reply, owner)), 404);
  expect(await answer(independent.moderator.main('GET', placedPath(independent.realm, reply.reply, independent.moderator)))).toEqual(other);
  expect(await answer(sessions.member.main('GET', `/v1/member-replies/${short(metadata.independentReply.reply)}`))).toEqual(otherAuthor);
  const history = await answer<Exact>(owner.main('GET', exactPath(reply.revisionId, owner)));
  expect(history.reference).toMatchObject({ resourceId: reply.reply, variantId: reply.variantId,
    revisionId: reply.revisionId, provenance: { author: reply.author } });
  expect(history.serializedJson).toContain(reply.body);
});
});
