import { expect, test } from 'bun:test';
import { newPostProgress, postWriteState, submitPost, type PostProgress } from './api.ts';

const intent = {
  realm: 'realm', work: 'work', mainVersion: 'main-version', title: 'Keep my title',
  body: 'Keep my text', spoiler: true, language: 'en', actingSubject: 'author',
};

function api() {
  const writes: Array<{ stage: string; key: string; body: unknown }> = [];
  let failRead = false, loseDraft = false;
  let saved: PostProgress | undefined;
  const receipts = new Map<string, object>();
  const write = async (stage: NonNullable<PostProgress['pendingStep']>, body: unknown, options: { headers: { 'idempotency-key': string } }) => {
    expect(saved?.writeState).toBe('unknown');
    expect(saved?.pendingStep).toBe(stage);
    const key = options.headers['idempotency-key'];
    writes.push({ stage, key, body });
    const receipt = receipts.get(key) ?? (stage === 'draft'
      ? { revisionId: 'revision', revisionDigest: 'digest' } : { reply: saved!.reply });
    receipts.set(key, receipt);
    if (stage === 'draft' && loseDraft) { loseDraft = false; throw new Error('Lost write response'); }
    return { data: receipt };
  };
  const main = { v1: {
    'main-versions': () => ({ selection: { get: async () => {
      if (failRead) throw new Error('Read unavailable');
      return { data: { work: intent.work, selectedDraft: 'root' } };
    } } }),
    'member-reply-drafts': { post: (body: unknown, options: Parameters<typeof write>[2]) => write('draft', body, options) },
    'realm-replies': { post: (body: unknown, options: Parameters<typeof write>[2]) => write('identity', body, options) },
    'realm-reply-placements': { post: (body: unknown, options: Parameters<typeof write>[2]) => write('place', body, options) },
    realms: () => ({ threads: () => ({ get: async () => ({ data: {} }) }) }),
  } } as unknown as NonNullable<Parameters<typeof submitPost>[3]>;
  return { main, writes, receipts, failRead: () => { failRead = true; }, loseDraft: () => { loseDraft = true; },
    persist: (progress: PostProgress) => { saved = JSON.parse(JSON.stringify(progress)); },
    restored: () => saved! };
}

test('a failed preflight restores an explicitly unwritten, editable and cancellable attempt', async () => {
  const owner = api(); owner.failRead();
  const original = newPostProgress(); owner.persist(original);
  const result = await submitPost(intent, original, owner.persist, owner.main);
  expect(result.kind).toBe('failed');
  expect(owner.writes).toHaveLength(0);
  expect(postWriteState(owner.restored())).toBe('none');
  expect(postWriteState(JSON.parse(JSON.stringify(result.kind === 'failed' && result.progress)))).toBe('none');
});

test('unknown write outcomes survive reload and same-key retries create one submission', async () => {
  const owner = api(); owner.loseDraft();
  const original = newPostProgress();
  expect((await submitPost(intent, original, owner.persist, owner.main)).kind).toBe('failed');
  const restored = owner.restored();
  expect(postWriteState(restored)).toBe('unknown');
  expect(restored.pendingStep).toBe('draft');
  expect(await submitPost(intent, restored, owner.persist, owner.main)).toEqual({ kind: 'posted', reply: original.reply });
  expect(owner.writes.map(write => write.stage)).toEqual(['draft', 'draft', 'identity', 'place']);
  expect(owner.writes[0]).toEqual(owner.writes[1]);
  expect(owner.receipts.size).toBe(3);
  expect(postWriteState(owner.restored())).toBe('acknowledged');
});

test('a write never starts if its pending state cannot be durably recorded', async () => {
  const owner = api();
  const result = await submitPost(intent, newPostProgress(), progress => {
    if (progress.writeState === 'unknown') throw new Error('Device storage full');
    owner.persist(progress);
  }, owner.main);
  expect(result.kind).toBe('failed');
  expect(owner.writes).toHaveLength(0);
  expect(result.kind === 'failed' && postWriteState(result.progress)).toBe('none');
});

test('legacy attempts without a receipt remain uncertain unless a refusal proves no write', () => {
  const { writeState: _state, ...legacy } = newPostProgress();
  expect(postWriteState(legacy)).toBe('unknown');
  expect(postWriteState({ ...legacy, restartRequired: true })).toBe('none');
  expect(postWriteState({ ...legacy, revisionId: 'receipt', restartRequired: true })).toBe('acknowledged');
});
