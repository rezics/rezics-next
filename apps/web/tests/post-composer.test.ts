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
  submitPost as submitPostCommand,
  type PostProgress,
} from '../features/post-composer/api.ts';
import { gateFor, type OperationGate, type PlatformAccess } from '../features/api/platform-access.ts';

const appealAccess: PlatformAccess = { groups: ['realm-appeals'], operations: [], generation: 'granted' };
const submitPost: typeof submitPostCommand = (intent, progress, persist, main, placed, projection, operationOpen = gateFor(appealAccess)) =>
  submitPostCommand(intent, progress, persist, main, placed, projection, operationOpen);

const postIntent = {
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  mainVersion: null,
  revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  title: 'The ending',
  body: 'I loved it.',
  spoiler: false,
  language: 'en',
  actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004',
};
const revisionId = '00000000-0000-4000-8000-000000000005';
const revisionDigest = 'a'.repeat(64);
const activeBan = {
  realm: postIntent.realm,
  receiptId: '00000000-0000-4000-8000-000000000006',
  action: 'ban',
  reason: 'Repeated posts disrupted discussion.',
  permanent: true,
  bannedUntil: null,
  happenedAt: '2026-10-01T00:00:00.000Z',
  appeal: { state: 'none' },
};
type PostingStep = 'draft' | 'identity' | 'place';
type WriteOptions = { headers: { 'idempotency-key': string } };

/** The thread projection can lag behind an authoritative placement receipt. */
function unplacedReplyMain(
  options: {
    failStep?: PostingStep;
    failure?: 'lost' | 'denied' | 'cancelled' | 'unavailable' | 'pending';
    ban?: object | null;
    banReadFails?: boolean;
    draftRevision?: string;
    projectionVisibleAfter?: number | null;
  } = {},
) {
  const calls: Array<{ step: PostingStep; key: string; body: Record<string, unknown> }> = [];
  const events: string[] = [];
  const banReads: Array<{ realm: string; query: { actingSubject: string } }> = [];
  let threadReads = 0;
  let failed = false;
  const cancelledKeys = new Map<string, { status: number; value: { code: string } }>();
  let ban = options.ban ?? null;
  const write = async (step: PostingStep, body: Record<string, unknown>, request: WriteOptions) => {
    calls.push({ step, key: request.headers['idempotency-key'], body });
    events.push(step);
    // Owner receipts permanently replay a cancelled operation, even after an unban.
    const cancelled = cancelledKeys.get(request.headers['idempotency-key']);
    if (cancelled) return { data: null, error: cancelled };
    if (options.failStep === step && (!failed || (options.failure === 'denied' && ban))) {
      failed = true;
      if (options.failure === 'lost') throw new Error('Response lost after the write');
      if (options.failure === 'unavailable') return { data: null, error: { status: 503 } };
      if (options.failure === 'pending')
        return { data: null, error: { status: 409, value: { code: 'admission_busy' } } };
      const error =
        options.failure === 'cancelled'
          ? { status: 409, value: { code: step === 'draft' ? 'stale_head' : 'realm_reply_stale' } }
          : { status: 403, value: { code: 'authority_denied' } };
      cancelledKeys.set(request.headers['idempotency-key'], error);
      return { data: null, error };
    }
    return {
      data:
        step === 'draft'
          ? { revisionId: options.draftRevision ?? revisionId, revisionDigest }
          : { reply: body.reply },
    };
  };
  const main = {
    v1: {
      'member-reply-drafts': {
        post: (body: Record<string, unknown>, request: WriteOptions) =>
          write('draft', body, request),
      },
      'realm-replies': {
        post: (body: Record<string, unknown>, request: WriteOptions) =>
          write('identity', body, request),
      },
      'realm-reply-placements': {
        post: (body: Record<string, unknown>, request: WriteOptions) =>
          write('place', body, request),
      },
      realms: ({ realm }: { realm: string }) => ({
        threads: ({ reply }: { reply: string }) => ({
          get: async (_request: { query: { actingSubject: string } }) => {
            threadReads++;
            events.push('read');
            if (
              options.projectionVisibleAfter === null ||
              threadReads < (options.projectionVisibleAfter ?? 1)
            ) {
              events.push('not-visible');
              return { data: null, error: { status: 404, value: { code: 'reply_unavailable' } } };
            }
            events.push('visible');
            return { data: { items: [{ reply }] } };
          },
        }),
        'member-ban': {
          get: async ({ query }: { query: { actingSubject: string } }) => {
            banReads.push({ realm, query });
            if (options.banReadFails) throw new Error('Ban read unavailable');
            return ban ? { data: ban } : { data: null, error: { status: 404 } };
          },
        },
      }),
    },
  } as unknown as NonNullable<Parameters<typeof submitPost>[3]>;
  return {
    main,
    calls,
    events,
    banReads,
    threadReads: () => threadReads,
    liftBan: () => {
      ban = null;
    },
  };
}

const diagnosticAccess: Array<[string, PlatformAccess, boolean]> = [
  ['anonymous', { groups: [], operations: [], generation: '' }, false],
  ['signed in without a grant', { groups: [], operations: [], generation: 'signed-in' }, false],
  ['group granted', appealAccess, true],
  ['operation granted', { groups: [], operations: ['getV1RealmsByRealmMember-ban'], generation: 'operation' }, true],
  ['another appeal operation granted', { groups: [], operations: ['postV1RealmsByRealmMember-receiptsByReceiptIdAppeal'], generation: 'other' }, false],
  ['revoked', { groups: [], operations: [], generation: 'revoked' }, false],
];

test.each(diagnosticAccess)('the optional ban diagnostic respects %s access', async (_state, access, allowed) => {
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban: activeBan });
  const result = await submitPostCommand(postIntent, newPostProgress(), () => undefined,
    api.main, undefined, undefined, gateFor(access));
  expect(result.kind).toBe(allowed ? 'banned' : 'failed');
  expect(api.banReads).toHaveLength(allowed ? 1 : 0);
  expect(api.calls.map(call => call.step)).toEqual(['draft']);
});

test('a caller without a supplied operation gate skips the optional closed read', async () => {
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban: activeBan });
  expect((await submitPostCommand(postIntent, newPostProgress(), () => undefined, api.main)).kind).toBe('failed');
  expect(api.banReads).toHaveLength(0);
});

test('revocation before a refusal skips the diagnostic through the current gate', async () => {
  let current = appealAccess;
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban: activeBan });
  const operationOpen: OperationGate = operation => gateFor(current)(operation);
  current = { groups: [], operations: [], generation: 'revoked' };
  expect((await submitPostCommand(postIntent, newPostProgress(), () => undefined,
    api.main, undefined, undefined, operationOpen)).kind).toBe('failed');
  expect(api.banReads).toHaveLength(0);
});

test.each(diagnosticAccess)('public posting remains available with %s appeal access', async (_state, access) => {
  const api = unplacedReplyMain();
  const progress = newPostProgress();
  expect(await submitPostCommand(postIntent, progress, () => undefined,
    api.main, undefined, undefined, gateFor(access))).toEqual({ kind: 'posted', reply: progress.reply });
  expect(api.calls.map(call => call.step)).toEqual(['draft', 'identity', 'place']);
  expect(api.banReads).toHaveLength(0);
});

test('a fresh post uses its draft receipt, then waits for the placed reply projection', async () => {
  const api = unplacedReplyMain();
  const original = newPostProgress();
  const persisted: PostProgress[] = [];
  expect(
    await submitPost(postIntent, original, (progress) => persisted.push(progress), api.main),
  ).toEqual({ kind: 'posted', reply: original.reply });
  expect(api.calls.map((call) => call.step)).toEqual(['draft', 'identity', 'place']);
  expect(api.calls[2]!.body).toMatchObject({ reply: original.reply, revisionId, revisionDigest });
  expect(
    persisted.some(
      (progress) => progress.revisionId === revisionId && progress.digest === revisionDigest,
    ),
  ).toBe(true);
  expect(api.threadReads()).toBe(1);
});

test('a placed post stays confirmed while the projection catches up, then opens the reply', async () => {
  const api = unplacedReplyMain({ projectionVisibleAfter: 2 });
  const original = newPostProgress();
  let confirmation = '';
  let projectionVisible = false;
  const result = await submitPost(
    postIntent,
    original,
    () => undefined,
    api.main,
    (reply) => {
      confirmation = reply;
      api.events.push('confirmed');
    },
    (visible) => {
      projectionVisible = visible;
      api.events.push(visible ? 'visible' : 'not-visible');
    },
  );

  expect(result).toEqual({ kind: 'posted', reply: original.reply });
  expect(confirmation).toBe(original.reply);
  expect(projectionVisible).toBe(true);
  expect(api.events.slice(-7)).toEqual([
    'place',
    'confirmed',
    'read',
    'not-visible',
    'read',
    'visible',
    'visible',
  ]);
  expect(api.threadReads()).toBe(2);
});

test('a successful placement remains posted when its projection misses the bounded reads', async () => {
  const api = unplacedReplyMain({ projectionVisibleAfter: null });
  const original = newPostProgress();
  let confirmed: string | undefined;
  let projectionVisible = true;
  expect(
    await submitPost(postIntent, original, () => undefined, api.main, (reply) => {
      confirmed = reply;
    }, (visible) => {
      projectionVisible = visible;
    }),
  ).toEqual({ kind: 'posted', reply: original.reply });
  expect(confirmed).toBe(original.reply);
  expect(projectionVisible).toBe(false);
  expect(api.threadReads()).toBe(3);
});

test.each([false, true])(
  'a saved reply missing its digest replays the draft with identified=%s',
  async (identified) => {
    const api = unplacedReplyMain();
    const original = {
      ...newPostProgress(),
      rootRevision: postIntent.revision,
      revisionId,
      identified,
    };
    let saved: PostProgress = original;
    expect(
      await submitPost(
        postIntent,
        original,
        (progress) => {
          saved = progress;
        },
        api.main,
      ),
    ).toEqual({ kind: 'posted', reply: original.reply });
    expect(api.calls.map((call) => call.step)).toEqual(
      identified ? ['draft', 'place'] : ['draft', 'identity', 'place'],
    );
    expect(api.calls[0]!).toMatchObject({
      key: `${original.key}:draft`,
      body: {
        reply: original.reply,
        variantId: original.variantId,
        expectedHead: null,
      },
    });
    expect(saved).toMatchObject({ revisionId, digest: revisionDigest, identified: true });
    expect(api.threadReads()).toBe(1);
  },
);

test('digest recovery fails before placement when the draft replay names another revision', async () => {
  const api = unplacedReplyMain({ draftRevision: '00000000-0000-4000-8000-000000000007' });
  const original = {
    ...newPostProgress(),
    rootRevision: postIntent.revision,
    revisionId,
    identified: true,
  };
  expect(await submitPost(postIntent, original, () => undefined, api.main)).toEqual({
    kind: 'failed',
    progress: original,
  });
  expect(api.calls.map((call) => call.step)).toEqual(['draft']);
  expect(api.threadReads()).toBe(0);
});

test.each(['draft', 'identity', 'place'] as const)(
  'a lost %s response retries the same intent and operation key',
  async (step) => {
    const api = unplacedReplyMain({ failStep: step, failure: 'lost' });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') throw new Error('Lost response must retain retry progress');
    expect(await submitPost(postIntent, first.progress, () => undefined, api.main)).toEqual({
      kind: 'posted',
      reply: original.reply,
    });
    const attempts = api.calls.filter((call) => call.step === step);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(api.calls.every((call) => call.body.reply === original.reply)).toBe(true);
    expect(api.calls.filter((call) => call.step === 'draft')).toHaveLength(
      step === 'draft' ? 2 : 1,
    );
    expect(api.calls.filter((call) => call.step === 'identity')).toHaveLength(
      step === 'identity' ? 2 : 1,
    );
    expect(api.threadReads()).toBe(1);
    expect(api.banReads).toHaveLength(0);
  },
);

test.each(['draft', 'identity', 'place'] as const)(
  'a ban denied at %s retires the cancelled key and retains the reply after unban',
  async (step) => {
    const api = unplacedReplyMain({ failStep: step, failure: 'denied', ban: activeBan });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    expect(first.kind).toBe('banned');
    if (first.kind !== 'banned') throw new Error('An active member ban must be reported');
    expect(first.progress).toMatchObject({
      key: original.key,
      reply: original.reply,
      variantId: original.variantId,
      restartRequired: true,
    });
    expect(api.calls.some((call) => call.body.body === null)).toBe(false);
    expect(api.banReads).toEqual([
      { realm: postIntent.realm.slice(-36), query: { actingSubject: postIntent.actingSubject } },
    ]);
    api.liftBan();
    const saved = JSON.parse(JSON.stringify(first.progress)) as PostProgress;
    const recovery: PostProgress[] = [];
    expect(
      await submitPost(postIntent, saved, (progress) => recovery.push(progress), api.main),
    ).toEqual({
      kind: 'posted',
      reply: original.reply,
    });
    const attempts = api.calls.filter((call) => call.step === step);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
    const restarted = { ...first.progress, key: attempts[1]!.key.split(':')[0]! };
    delete restarted.restartRequired;
    expect(recovery[0]).toEqual(restarted);
    expect(saved).toEqual(first.progress);
    expect(api.calls.every((call) => call.body.reply === original.reply)).toBe(true);
    if (step === 'draft') {
      expect(documentText(attempts[1]!.body.document as DocumentSnapshot)).toBe(
        documentText(attempts[0]!.body.document as DocumentSnapshot),
      );
      expect(attempts[1]!.body).toMatchObject({
        variantId: original.variantId,
        language: postIntent.language,
        spoiler: postIntent.spoiler,
        rootRevision: postIntent.revision,
      });
    } else {
      expect(attempts[1]!.body).toEqual(attempts[0]!.body);
      expect(api.calls.filter((call) => call.step === 'draft')).toHaveLength(1);
    }
    expect(api.threadReads()).toBe(1);
  },
);

test.each(['draft', 'identity', 'place'] as const)(
  'a cancelled %s operation retires its key without discarding successful steps',
  async (step) => {
    const api = unplacedReplyMain({ failStep: step, failure: 'cancelled' });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    if (first.kind !== 'failed') throw new Error('A cancelled operation needs another attempt');
    expect(first.progress.restartRequired).toBe(true);
    expect(await submitPost(postIntent, first.progress, () => undefined, api.main)).toEqual({
      kind: 'posted',
      reply: original.reply,
    });
    const attempts = api.calls.filter((call) => call.step === step);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
    expect(api.calls.filter((call) => call.step === 'draft')).toHaveLength(
      step === 'draft' ? 2 : 1,
    );
    expect(api.calls.some((call) => call.body.body === null)).toBe(false);
  },
);

test('older saved progress replays a cancelled draft denial after unban, then retires its key', async () => {
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban: activeBan });
  const original = newPostProgress();
  const denied = await submitPost(postIntent, original, () => undefined, api.main);
  if (denied.kind !== 'banned') throw new Error('The draft must initially be banned');
  const older = { ...denied.progress };
  delete older.restartRequired;
  api.liftBan();
  const replay = await submitPost(postIntent, older, () => undefined, api.main);
  if (replay.kind !== 'failed') throw new Error('The cancelled key must stay denied after unban');
  expect(replay.progress).toMatchObject({ key: original.key, restartRequired: true });
  expect(await submitPost(postIntent, replay.progress, () => undefined, api.main)).toEqual({
    kind: 'posted',
    reply: original.reply,
  });
  const attempts = api.calls.filter((call) => call.step === 'draft');
  expect(attempts).toHaveLength(3);
  expect(attempts[1]!.key).toBe(attempts[0]!.key);
  expect(attempts[2]!.key).not.toBe(attempts[0]!.key);
});

test.each([
  ['draft', 'unavailable'],
  ['draft', 'pending'],
  ['identity', 'unavailable'],
  ['identity', 'pending'],
  ['place', 'unavailable'],
  ['place', 'pending'],
] as const)(
  'a %s operation that is %s retains the same key for its retry',
  async (step, failure) => {
    const api = unplacedReplyMain({ failStep: step, failure });
    const original = newPostProgress();
    const first = await submitPost(postIntent, original, () => undefined, api.main);
    if (first.kind !== 'failed')
      throw new Error('An unfinished operation must retain retry progress');
    expect(first.progress.restartRequired).toBeUndefined();
    expect(await submitPost(postIntent, first.progress, () => undefined, api.main)).toEqual({
      kind: 'posted',
      reply: original.reply,
    });
    const attempts = api.calls.filter((call) => call.step === step);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(api.banReads).toHaveLength(0);
  },
);

test.each(['draft', 'identity', 'place'] as const)(
  'a different authority denial at %s keeps its ordinary failure outcome',
  async (step) => {
    const api = unplacedReplyMain({ failStep: step, failure: 'denied' });
    const result = await submitPost(postIntent, newPostProgress(), () => undefined, api.main);
    expect(result.kind).toBe(step === 'place' ? 'refused' : 'failed');
    expect(api.calls.some((call) => call.body.body === null)).toBe(step === 'place');
    if (result.kind === 'failed') {
      expect(result.progress.restartRequired).toBe(true);
      expect(await submitPost(postIntent, result.progress, () => undefined, api.main)).toEqual({
        kind: 'posted',
        reply: result.progress.reply,
      });
      const attempts = api.calls.filter((call) => call.step === step);
      expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
    }
  },
);

test.each([
  ['ended', { ...activeBan, permanent: false, bannedUntil: '2000-01-01T00:00:00.000Z' }, false],
  ['another realm', { ...activeBan, realm: postIntent.work }, false],
  [
    'reversed',
    {
      ...activeBan,
      appeal: {
        state: 'decided',
        caseId: '00000000-0000-4000-8000-000000000008',
        statement: 'Please reconsider.',
        outcome: 'reversed',
        rationale: null,
        decidedAt: null,
        liftedAt: null,
      },
    },
    false,
  ],
  ['unreadable', activeBan, true],
] as const)('a %s ban read does not mislabel a draft denial', async (_name, ban, banReadFails) => {
  const api = unplacedReplyMain({ failStep: 'draft', failure: 'denied', ban, banReadFails });
  expect((await submitPost(postIntent, newPostProgress(), () => undefined, api.main)).kind).toBe(
    'failed',
  );
});

test('an unavailable placement stays retryable even when the member has a ban', async () => {
  const api = unplacedReplyMain({ failStep: 'place', failure: 'unavailable', ban: activeBan });
  expect((await submitPost(postIntent, newPostProgress(), () => undefined, api.main)).kind).toBe(
    'failed',
  );
  expect(api.banReads).toHaveLength(0);
  expect(api.threadReads()).toBe(0);
  expect(api.calls.some((call) => call.body.body === null)).toBe(false);
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
      realms: () => ({
        threads: ({ reply }: { reply: string }) => ({
          get: async () => ({ data: { items: [{ reply }] } }),
        }),
      }),
      'realm-replies': {
        post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
          record('identity', body, options);
          return { data: { reply: 'reply' } };
        },
      },
      'member-replies': () => ({ get: async () => ({ data: { revisionDigest: 'digest' } }) }),
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
    realm: 'realm',
    work: 'work',
    mainVersion: 'main-version',
    actingSubject: 'author',
  };
  const japanese = postDocument(
    { ...base, title: '最終章の手紙', body: '本文', spoiler: true, language: 'ja' },
    progress,
  );
  expect(documentText(japanese)).toBe('最終章の手紙\n本文');
  const unmarked = postDocument(
    {
      ...base,
      title: 'Spoilers: a review of spoiler culture',
      body: 'The title names the subject.',
      spoiler: false,
      language: 'en',
    },
    progress,
  );
  expect(documentText(unmarked)).toBe(
    'Spoilers: a review of spoiler culture\nThe title names the subject.',
  );
});
