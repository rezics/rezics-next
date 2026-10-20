import { expect, test } from 'bun:test';
import { documentText, parseStoredDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { storedImageUpload } from './local-image.ts';
import { imageUseReconciler } from './image-uses.ts';
import { documentPublication } from './publication.ts';

const actor = 'https://rezics.com/id/71473997-6e2e-4e59-9044-01627a79e839';
const root = 'https://rezics.com/id/01a14f4e-526a-706c-9404-479d17f3e7ba';
const rootRevision = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const reply = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const variantId = 'urn:rezics:variant:33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const representation = 'f02b9465-dafb-422b-b77e-565b84e8f2ed';
const occurrence = 'e26349cf-dbcc-497e-8e3f-9e0c3344342c';
const use = '55555555-5555-4555-8555-555555555555';
const originRealm = 'https://rezics.com/id/66666666-6666-4666-8666-666666666666';
const receipt = { reply, variantId, revisionId, rootTarget: root, rootRevision, originRealm };
const memberTarget = (retained = false) => ({ retained, prepare: async () => receipt });
const memberReplyDraft = { profile: 'member-reply-draft-image-v1', variantId,
  expectedHead: revisionId, rootTarget: root, rootRevision };
const file = new File([new Uint8Array([1, 2, 3])], 'draft.png', { type: 'image/png' });
const image = (): DocumentNode => ({ type: 'image', attrs: { id: occurrence, representationId: representation,
  mediaUseId: use, src: `/api/main/v1/media/representations/${representation}/bytes?use=${use}`, conceal: false } });
const document = (...nodes: DocumentNode[]): DocumentSnapshot => ({ version: 'rezics-document-v1', profile: 'blocks',
  doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'current-text' },
    content: [{ type: 'text', text: 'Current complete text.' }] }, ...nodes] } });

function transport(status = 201) {
  const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
  const send = (async (url, init) => {
    const path = String(url);
    if (init?.method === 'PUT') return Response.json({ status: 'activated', representation }, { status: 201 });
    const body = JSON.parse(String(init?.body));
    commands.push({ path, body });
    if (path.endsWith('/uploads')) return Response.json({ upload: 'upload' }, { status: 201 });
    if (path.endsWith('/inferences')) return Response.json({}, { status: 201 });
    if (path.endsWith('/uses')) {
      // Media fences a reply Use whose context differs from the acknowledged draft's immutable origin.
      if (body.memberReplyDraft && body.context !== receipt.originRealm) return new Response(null, { status: 403 });
      return status === 201 ? Response.json({ use }, { status }) : new Response(null, { status });
    }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  return { commands, send };
}

test('upload binds to the acknowledged native reply, origin Realm, variant/head and exact root, without a metadata read', async () => {
  const owner = transport();
  const uploaded = await storedImageUpload(actor, memberTarget(), owner.send)(file, occurrence);
  expect(owner.commands.find(command => command.path.endsWith('/uses'))?.body).toEqual({
    actingSubject: actor, target: reply, context: originRealm, representation, occurrence, conceal: false, memberReplyDraft,
  });
  expect(uploaded).toMatchObject({ representationId: representation, mediaUseId: use });
  expect(uploaded.src).toContain(`use=${use}`);
});

test('ordinary Work upload retains the ordinary request with no member reply authority fields', async () => {
  const owner = transport();
  await storedImageUpload(actor, root, owner.send)(file, occurrence);
  expect(owner.commands.find(command => command.path.endsWith('/uses'))?.body).toEqual({
    actingSubject: actor, target: root, representation, occurrence, conceal: false,
  });
});

test('ordinary Work copied-image reconciliation retains the ordinary operation', async () => {
  const owner = transport();
  await imageUseReconciler(document(), actor, root, owner.send)(document(image()));
  expect(owner.commands).toHaveLength(1);
  expect(owner.commands[0]?.body).toEqual({ actingSubject: actor, target: root, representation, occurrence, conceal: false });
});

test('unavailable reply preparation prevents reserve and byte writes and remains retryable', async () => {
  const owner = transport();
  let available = false;
  const target = { retained: false, prepare: async () => {
    if (!available) throw new Error('reply-draft-unavailable');
    return receipt;
  } };
  const upload = storedImageUpload(actor, target, owner.send);
  await expect(upload(file, occurrence)).rejects.toThrow('reply-draft-unavailable');
  expect(owner.commands).toHaveLength(0);
  available = true;
  await upload(file, occurrence);
  expect(owner.commands.find(command => command.path.endsWith('/uses'))?.body).toMatchObject({ target: reply, context: originRealm, memberReplyDraft });
});

for (const refusal of [403, 503]) test(`binding ${refusal} retains current image/text until a successful same-context retry`, async () => {
  let denied = true;
  const attempts: unknown[] = [];
  const send = (async (_url, init) => {
    attempts.push(JSON.parse(String(init?.body)));
    return denied ? new Response(null, { status: refusal }) : Response.json({ use });
  }) as typeof fetch;
  const reconcile = imageUseReconciler(document(), actor, memberTarget(), send);
  let saved: string | undefined;
  const states: string[] = [];
  const publication = documentPublication(reconcile, value => { saved = value; }, state => states.push(state));
  const current = document(image());
  expect(await publication.publish(current)).toBe(false);
  expect(states.at(-1)).toBe('failed');
  expect(saved).toBeUndefined();
  expect(publication.current()).toBe(current);
  denied = false;
  expect(await publication.retry()).toBe(true);
  expect(attempts).toEqual([1, 2].map(() => ({ actingSubject: actor, target: reply,
    context: originRealm, representation, occurrence, conceal: false, memberReplyDraft })));
  const reopened = parseStoredDocument(saved!);
  expect(documentText(reopened!)).toBe('Current complete text.\n');
  expect(reopened!.doc.content?.[1]?.attrs).toMatchObject({ representationId: representation, mediaUseId: use, id: occurrence });
});

test('reopened member reply images retain their exact Use without rebinding or preview metadata', async () => {
  let calls = 0;
  const current = document(image());
  const offline = Object.assign(async () => { calls++; throw new Error('offline'); }, { preconnect: fetch.preconnect });
  const reconcile = imageUseReconciler(current, actor, memberTarget(true), offline);
  expect(await reconcile(current)).toBe(current);
  expect(calls).toBe(0);
});

test('changing member reply context rebinds old occurrences instead of treating their old receipt as current', async () => {
  const owner = transport();
  const current = document(image());
  const reconcile = imageUseReconciler(current, actor, memberTarget(false), owner.send);
  await reconcile(current);
  expect(owner.commands).toHaveLength(1);
  expect(owner.commands[0]?.body).toMatchObject({ target: reply, context: originRealm, memberReplyDraft });
});
