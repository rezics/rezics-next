import { expect, test } from 'bun:test';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { postDocument, submitPost, type PostIntent, type PostProgress } from './api.ts';
import { preparePostImageDraft, sameImageDraftContext, type PostImageDraft } from './image-draft.ts';

const native = (id: string) => `https://rezics.com/id/${id}`;
const root = native('01a14f4e-526a-706c-9404-479d17f3e7ba');
const rootRevision = native('11111111-1111-4111-8111-111111111111');
const reply = native('22222222-2222-4222-8222-222222222222');
const variantId = 'urn:rezics:variant:33333333-3333-4333-8333-333333333333';
const head = '44444444-4444-4444-8444-444444444444';
const finalHead = '55555555-5555-4555-8555-555555555555';
const intent: PostIntent = { realm: native('66666666-6666-4666-8666-666666666666'), work: root,
  mainVersion: native('77777777-7777-4777-8777-777777777777'), title: 'Current title',
  body: JSON.stringify(fromPlainText('Current text', 'blocks')), spoiler: false, language: 'en',
  actingSubject: native('71473997-6e2e-4e59-9044-01627a79e839') };
type Main = NonNullable<Parameters<typeof submitPost>[3]>;
type DraftInput = Parameters<Main['v1']['member-reply-drafts']['post']>[0];
function documentOf(input: DraftInput | undefined) {
  if (!input || !('document' in input)) throw new Error('expected-complete-document');
  return input.document;
}

test('publication persists the current complete image/text against the acknowledged authoring head before identity or placement', async () => {
  const image = { type: 'image', attrs: { id: 'e26349cf-dbcc-497e-8e3f-9e0c3344342c',
    representationId: 'f02b9465-dafb-422b-b77e-565b84e8f2ed', mediaUseId: '88888888-8888-4888-8888-888888888888',
    src: '/api/main/v1/media/representations/f02b9465-dafb-422b-b77e-565b84e8f2ed/bytes?use=88888888-8888-4888-8888-888888888888' } };
  const text = fromPlainText('Text after uploading the image', 'blocks');
  const body: DocumentSnapshot = { ...text, doc: { ...text.doc, content: [...text.doc.content!, image] } };
  const current = { ...intent, body: JSON.stringify(body) };
  const progress: PostProgress = { key: crypto.randomUUID(), reply, variantId, rootRevision, writeState: 'none' };
  const stages: string[] = [];
  let written: DraftInput | undefined;
  const main = { v1: {
    'member-reply-drafts': { post: async (input: DraftInput) => {
      stages.push('draft'); written = input;
      return { data: { reply, variantId, revisionId: finalHead, revisionDigest: 'final-digest' } };
    } },
    'realm-replies': { post: async (input: { revisionId: string }) => {
      stages.push('identity'); expect(input.revisionId).toBe(finalHead); return { data: {} };
    } },
    'realm-reply-placements': { post: async (input: { revisionId: string; revisionDigest: string }) => {
      stages.push('place'); expect(input).toMatchObject({ revisionId: finalHead, revisionDigest: 'final-digest' });
      return { data: { reply } };
    } },
    realms: () => ({ threads: () => ({ get: async () => ({ data: {} }) }) }),
  } } as unknown as Main;
  expect((await submitPost(current, progress, () => {}, main, undefined, undefined, undefined, head)).kind).toBe('posted');
  expect(written).toMatchObject({ reply, variantId, rootTarget: root, rootRevision, expectedHead: head });
  expect(documentOf(written)).toEqual(postDocument(current, progress));
  expect(documentOf(written).doc.content?.at(-1)).toMatchObject(image);
  expect(stages).toEqual(['draft', 'identity', 'place']);
});

function authoringApi() {
  const requests: Array<{ input: DraftInput; key: string }> = [];
  let status = 201;
  let saved: PostImageDraft | undefined;
  const main = { v1: {
    'main-versions': () => ({ selection: { get: async () => ({ data: { work: root, selectedDraft: rootRevision } }) } }),
    'member-reply-drafts': { post: async (input: DraftInput, options: { headers: { 'idempotency-key': string } }) => {
      expect(saved?.progress.writeState).toBe('unknown');
      requests.push({ input, key: options.headers['idempotency-key'] });
      if (status === 0) throw new Error('lost-response');
      if (status !== 201) return { error: { status } };
      return { data: { reply: input.reply, variantId: input.variantId, revisionId: head,
        revisionDigest: 'a'.repeat(64), deleted: false } };
    } },
  } } as unknown as Main;
  return { requests, main, status: (value: number) => { status = value; },
    persist: (record: PostImageDraft) => { saved = structuredClone(record); },
    restored: () => saved! };
}

test('first image preparation durably records an actual reply authoring receipt and pins the Work selected revision', async () => {
  const owner = authoringApi();
  const result = await preparePostImageDraft(intent, null, owner.persist, owner.main);
  const record = owner.restored();
  expect(result).toEqual({ reply: record.progress.reply, variantId: record.progress.variantId,
    revisionId: head, rootTarget: root, rootRevision });
  expect(owner.requests[0]?.input).toMatchObject({ profile: 'member-reply-draft-v1',
    reply: result.reply, variantId: result.variantId, expectedHead: null, rootTarget: root,
    rootRevision, originRealm: intent.realm, actingSubject: intent.actingSubject });
  expect(documentOf(owner.requests[0]?.input)).toEqual(postDocument(intent, record.progress));
  expect(record.progress.writeState).toBe('acknowledged');
  expect(record.progress.digest).toBe('a'.repeat(64));
  // Further typing does not dispatch another authoring write or change the acknowledged image head.
  expect(await preparePostImageDraft({ ...intent, body: 'Later current text' }, record, owner.persist, owner.main)).toEqual(result);
  expect(owner.requests).toHaveLength(1);
});

test('an unknown image authoring write retries its exact immutable request while the current editor text stays independent', async () => {
  const owner = authoringApi(); owner.status(0);
  await expect(preparePostImageDraft(intent, null, owner.persist, owner.main)).rejects.toThrow('lost-response');
  const pending = owner.restored();
  expect(pending.progress.writeState).toBe('unknown');
  owner.status(201);
  await preparePostImageDraft({ ...intent, title: 'Later title', body: 'Later text' }, pending, owner.persist, owner.main);
  expect(owner.requests).toHaveLength(2);
  expect(owner.requests[1]).toEqual(owner.requests[0]);
  expect(owner.restored().intent).toEqual(intent);
  expect(owner.restored().progress.writeState).toBe('acknowledged');
});

test('a pending image authoring request never leaves the device when its recovery record cannot be saved', async () => {
  const owner = authoringApi();
  await expect(preparePostImageDraft(intent, null, () => { throw new Error('device-full'); }, owner.main)).rejects.toThrow('device-full');
  expect(owner.requests).toHaveLength(0);
});

test('losing the device acknowledgement keeps the pending request recoverable with the same key', async () => {
  const owner = authoringApi();
  await expect(preparePostImageDraft(intent, null, record => {
    if (record.progress.writeState === 'acknowledged') throw new Error('device-full');
    owner.persist(record);
  }, owner.main)).rejects.toThrow('device-full');
  const pending = owner.restored();
  expect(pending.progress.writeState).toBe('unknown');
  await preparePostImageDraft(intent, pending, owner.persist, owner.main);
  expect(owner.requests[1]).toEqual(owner.requests[0]);
  expect(owner.restored().progress.writeState).toBe('acknowledged');
});

for (const status of [403, 503]) test(`authoring ${status} retains a truthful write state and safe retry`, async () => {
  const owner = authoringApi(); owner.status(status);
  await expect(preparePostImageDraft(intent, null, owner.persist, owner.main)).rejects.toThrow('image-draft-unavailable');
  const pending = owner.restored();
  expect(pending.progress.writeState).toBe(status === 403 ? 'none' : 'unknown');
  expect(pending.progress.revisionId).toBeUndefined();
  owner.status(201);
  await preparePostImageDraft(intent, pending, owner.persist, owner.main);
  expect(owner.restored().progress.writeState).toBe('acknowledged');
  if (status === 403) expect(owner.requests[1]?.key).not.toBe(owner.requests[0]?.key);
  else expect(owner.requests[1]).toEqual(owner.requests[0]);
});

test('reply binding follows the actual root, actor, Realm and writing language, while ordinary edits keep that context', () => {
  const record: PostImageDraft = { intent, progress: { key: 'key', reply, variantId, rootRevision, revisionId: head, writeState: 'acknowledged' } };
  expect(sameImageDraftContext({ ...intent, title: 'New title', body: 'New text', spoiler: true }, record)).toBe(true);
  for (const patch of [{ work: native('99999999-9999-4999-8999-999999999999') }, { revision: rootRevision },
    { realm: root }, { actingSubject: root }, { language: 'zh-Hans' }])
    expect(sameImageDraftContext({ ...intent, ...patch }, record)).toBe(false);
});
