import { expect, test } from 'bun:test';
import {
  documentText,
  fromMarkdown,
  serializeDocument,
  type DocumentSnapshot,
} from '@rezics/document';
import {
  newPostProgress,
  postDocument,
  submitPost,
  type PostProgress,
} from '../features/post-composer/api.ts';

const postIntent = {
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  mainVersion: null,
  revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  title: 'The ending', body: 'I loved it.', spoiler: false, language: 'en',
  actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004',
};
const revisionId = '00000000-0000-4000-8000-000000000005';
const revisionDigest = 'a'.repeat(64);
const activeBan = {
  realm: postIntent.realm, receiptId: '00000000-0000-4000-8000-000000000006',
  action: 'ban', reason: 'Repeated posts disrupted discussion.',
  permanent: true, bannedUntil: null, happenedAt: '2026-10-01T00:00:00.000Z',
  appeal: { state: 'none' },
};
type PostingStep = 'draft' | 'identity' | 'place';
type WriteOptions = { headers: { 'idempotency-key': string } };

/** Public reads deliberately reject: an author has no placement yet. */
function unplacedReplyMain(options: {
  failStep?: PostingStep;
  failure?: 'lost' | 'denied' | 'unavailable';
  ban?: object | null;
  banReadFails?: boolean;
  draftRevision?: string;
} = {}) {
  const calls: Array<{ step: PostingStep; key: string; body: Record<string, unknown> }> = [];
  const banReads: Array<{ realm: string; query: { actingSubject: string } }> = [];
  let publicReads = 0;
  let failed = false;
  let ban = options.ban ?? null;
  const write = async (step: PostingStep, body: Record<string, unknown>, request: WriteOptions) => {
    calls.push({ step, key: request.headers['idempotency-key'], body });
    if (!failed && options.failStep === step) {
      failed = true;
      if (options.failure === 'lost') throw new Error('Response lost after the write');
      return { data: null, error: { status: options.failure === 'unavailable' ? 503 : 403 } };
    }
    return { data: step === 'draft'
      ? { revisionId: options.draftRevision ?? revisionId, revisionDigest }
      : { reply: body.reply } };
  };
  const main = { v1: {
    'member-reply-drafts': { post: (body: Record<string, unknown>, request: WriteOptions) => write('draft', body, request) },
    'realm-replies': { post: (body: Record<string, unknown>, request: WriteOptions) => write('identity', body, request) },
    'realm-reply-placements': { post: (body: Record<string, unknown>, request: WriteOptions) => write('place', body, request) },
    'member-replies': () => ({ get: async () => {
      publicReads++;
      return { data: null, error: { status: 404, value: { code: 'reply_unavailable' } } };
    } }),
    realms: ({ realm }: { realm: string }) => ({ 'member-ban': { get: async ({ query }: { query: { actingSubject: string } }) => {
      banReads.push({ realm, query });
      if (options.banReadFails) throw new Error('Ban read unavailable');
      return ban ? { data: ban } : { data: null, error: { status: 404 } };
    } } }),
  } } as unknown as NonNullable<Parameters<typeof submitPost>[3]>;
  return { main, calls, banReads, publicReads: () => publicReads, liftBan: () => { ban = null; } };
}

test('a fresh unplaced reply gets its placement digest from the draft without a public read', async () => {
  const api = unplacedReplyMain();
  const original = newPostProgress();
  const persisted: PostProgress[] = [];
  expect(await submitPost(postIntent, original, progress => persisted.push(progress), api.main))
    .toEqual({ kind: 'posted', reply: original.reply });
  expect(api.calls.map(call => call.step)).toEqual(['draft', 'identity', 'place']);
  expect(api.calls[2]!.body).toMatchObject({ reply: original.reply, revisionId, revisionDigest });
  expect(persisted.some(progress => progress.revisionId === revisionId && progress.digest === revisionDigest)).toBe(true);
  expect(api.publicReads()).toBe(0);
});

test.each([false, true])('a saved reply missing its digest replays the draft with identified=%s', async identified => {
  const api = unplacedReplyMain();
  const original = { ...newPostProgress(), rootRevision: postIntent.revision, revisionId, identified };
  let saved: PostProgress = original;
  expect(await submitPost(postIntent, original, progress => { saved = progress; }, api.main))
    .toEqual({ kind: 'posted', reply: original.reply });
  expect(api.calls.map(call => call.step)).toEqual(identified ? ['draft', 'place'] : ['draft', 'identity', 'place']);
  expect(api.calls[0]!).toMatchObject({ key: `${original.key}:draft`, body: {
    reply: original.reply, variantId: original.variantId, expectedHead: null,
  } });
  expect(saved).toMatchObject({ revisionId, digest: revisionDigest, identified: true });
  expect(api.publicReads()).toBe(0);
});

test('digest recovery fails before placement when the draft replay names another revision', async () => {
  const api = unplacedReplyMain({ draftRevision: '00000000-0000-4000-8000-000000000007' });
  const original = { ...newPostProgress(), rootRevision: postIntent.revision, revisionId, identified: true };
  expect(await submitPost(postIntent, original, () => undefined, api.main))
    .toEqual({ kind: 'failed', progress: original });
  expect(api.calls.map(call => call.step)).toEqual(['draft']);
  expect(api.publicReads()).toBe(0);
});

test.each(['draft', 'identity', 'place'] as const)(
  'a lost %s response retries the same intent and operation key', async step => {
    const api = unplacedReplyMain({ failStep: step, failure: 'lost' });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') throw new Error('Lost response must retain retry progress');
    expect(await submitPost(postIntent, first.progress, () => undefined, api.main))
      .toEqual({ kind: 'posted', reply: original.reply });
    const attempts = api.calls.filter(call => call.step === step);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(api.calls.every(call => call.body.reply === original.reply)).toBe(true);
    expect(api.calls.filter(call => call.step === 'draft')).toHaveLength(step === 'draft' ? 2 : 1);
    expect(api.calls.filter(call => call.step === 'identity')).toHaveLength(step === 'identity' ? 2 : 1);
    expect(api.publicReads()).toBe(0);
    expect(api.banReads).toHaveLength(0);
  },
);

test.each(['draft', 'identity', 'place'] as const)(
  'a ban denied at %s retains the reply for a successful retry after unban', async step => {
    const api = unplacedReplyMain({ failStep: step, failure: 'denied', ban: activeBan });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    expect(first.kind).toBe('banned');
    if (first.kind !== 'banned') throw new Error('An active member ban must be reported');
    expect(first.progress).toMatchObject({ key: original.key, reply: original.reply, variantId: original.variantId });
    expect(api.calls.some(call => call.body.body === null)).toBe(false);
    expect(api.banReads).toEqual([{ realm: postIntent.realm.slice(-36), query: { actingSubject: postIntent.actingSubject } }]);
    api.liftBan();
    expect(await submitPost(postIntent, first.progress, () => undefined, api.main))
      .toEqual({ kind: 'posted', reply: original.reply });
    const attempts = api.calls.filter(call => call.step === step);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(api.publicReads()).toBe(0);
  },
);

test.each(['draft', 'identity', 'place'] as const)(
  'a different authority denial at %s keeps its ordinary failure outcome', async step => {
    const api = unplacedReplyMain({ failStep: step, failure: 'denied' });
    const result = await submitPost(postIntent, newPostProgress(), () => undefined, api.main);
    expect(result.kind).toBe(step === 'place' ? 'refused' : 'failed');
    expect(api.calls.some(call => call.body.body === null)).toBe(step === 'place');
  },
);

test.each([
  ['ended', { ...activeBan, permanent: false, bannedUntil: '2000-01-01T00:00:00.000Z' }, false],
  ['another realm', { ...activeBan, realm: postIntent.work }, false],
  ['reversed', { ...activeBan, appeal: {
    state: 'decided', caseId: '00000000-0000-4000-8000-000000000008', statement: 'Please reconsider.',
    outcome: 'reversed', rationale: null, decidedAt: null, liftedAt: null,
  } }, false],
  ['unreadable', activeBan, true],
] as const)('a %s ban read does not mislabel a draft denial', async (_name, ban, banReadFails) => {
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban, banReadFails });
  expect((await submitPost(postIntent, newPostProgress(), () => undefined, api.main)).kind).toBe('failed');
});

test('an unavailable placement stays retryable even when the member has a ban', async () => {
  const api = unplacedReplyMain({ failStep: 'place', failure: 'unavailable', ban: activeBan });
  expect((await submitPost(postIntent, newPostProgress(), () => undefined, api.main)).kind).toBe('failed');
  expect(api.banReads).toHaveLength(0);
  expect(api.calls.some(call => call.body.body === null)).toBe(false);
});

test('a lost placement response retries with the same post identity and operation key', async () => {
  const calls: Array<{ step: string; key: string; body: unknown }> = [];
  let placementAttempt = 0;
  const record = (
    step: string,
    body: unknown,
    options: { headers: { 'idempotency-key': string } },
  ) => {
    calls.push({ step, key: options.headers['idempotency-key'], body });
  };
  const main = {
    v1: {
      'main-versions': () => ({
        selection: { get: async () => ({ data: { work: 'work', selectedDraft: 'draft' } }) },
      }),
      'member-reply-drafts': {
        post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
          record('draft', body, options);
          return { data: { revisionId: 'revision', revisionDigest: 'digest' } };
        },
      },
      'realm-replies': {
        post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
          record('identity', body, options);
          return { data: { reply: 'reply' } };
        },
      },
      'realm-reply-placements': {
        post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
          record('place', body, options);
          return ++placementAttempt === 1
            ? { data: null, error: { status: 503 } }
            : { data: { reply: (body as { reply: string }).reply } };
        },
      },
    },
  } as unknown as NonNullable<Parameters<typeof submitPost>[3]>;
  const original = newPostProgress();
  let saved: PostProgress = original;
  const intent = {
    realm: 'realm',
    work: 'work',
    mainVersion: 'main-version',
    title: 'The ending',
    body: 'I loved it.',
    spoiler: true,
    language: 'en',
    actingSubject: 'author',
  };
  const first = await submitPost(
    intent,
    original,
    (progress) => {
      saved = progress;
    },
    main,
  );
  expect(first.kind).toBe('failed');
  expect(saved).toMatchObject({
    reply: original.reply,
    revisionId: 'revision',
    digest: 'digest',
    identified: true,
  });
  expect(calls.map((call) => call.step)).toEqual(['draft', 'identity', 'place']);
  expect(documentText((calls[0]!.body as { document: DocumentSnapshot }).document)).toBe(
    'The ending\nI loved it.',
  );
  expect((calls[0]!.body as { spoiler: boolean }).spoiler).toBe(true);
  expect((calls[1]!.body as { spoiler: boolean }).spoiler).toBe(true);
  expect((calls[0]!.body as { body?: string }).body).toBeUndefined();
  expect((calls[0]!.body as { originRealm: string }).originRealm).toBe('realm');
  const second = await submitPost(
    intent,
    saved,
    (progress) => {
      saved = progress;
    },
    main,
  );
  expect(second).toEqual({ kind: 'posted', reply: original.reply });
  expect(calls.map((call) => call.step)).toEqual(['draft', 'identity', 'place', 'place']);
  expect(calls[2]!.key).toBe(calls[3]!.key);
});

test('the title stays as the writer typed it, and a spoiler mark does not change the words', () => {
  const original = fromMarkdown('**Bold**\n\n> Quoted\n\n>!ending!<');
  const intent = {
    realm: 'realm',
    work: 'work',
    mainVersion: 'main-version',
    title: 'Title',
    body: serializeDocument(original),
    spoiler: true,
    language: 'en',
    actingSubject: 'author',
  };
  const progress = newPostProgress();
  const rich = postDocument(intent, progress);
  expect(rich.doc.content?.slice(1)).toEqual(original.doc.content);
  expect(documentText(rich)).toBe('Title\nBold\nQuoted\nending');
  const legacy = { ...intent, body: '**Bold**\n\n>!ending!<' };
  expect(serializeDocument(postDocument(legacy, progress))).toBe(
    serializeDocument(postDocument(legacy, progress)),
  );
});

test('a Japanese spoiler and an unmarked English title both keep the words the writer typed', () => {
  const progress = newPostProgress();
  const base = {
    realm: 'realm', work: 'work', mainVersion: 'main-version', actingSubject: 'author',
  };
  const japanese = postDocument({ ...base, title: '最終章の手紙', body: '本文', spoiler: true, language: 'ja' }, progress);
  expect(documentText(japanese)).toBe('最終章の手紙\n本文');
  const unmarked = postDocument({
    ...base, title: 'Spoilers: a review of spoiler culture', body: 'The title names the subject.',
    spoiler: false, language: 'en',
  }, progress);
  expect(documentText(unmarked)).toBe('Spoilers: a review of spoiler culture\nThe title names the subject.');
});
