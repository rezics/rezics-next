import { expect, test } from 'bun:test';
import {
  mainThreadApi,
  replyProgress,
  type ReplyInput,
  type ReplyProgress,
} from '../features/feed/thread-api.ts';

const iri = (n: number) => `https://rezics.com/id/${n.toString(16).padStart(36, '0')}`;
const revision = (n: number) => n.toString(16).padStart(36, '0');
const realm = iri(90);
const parent = iri(91);

const input = (body: string): ReplyInput => ({
  realm,
  work: iri(92),
  rootRevision: iri(93),
  parent: { reply: parent, revisionId: revision(94) },
  body,
  language: 'en',
  actingSubject: iri(95),
});

type Answer = { data: Record<string, unknown> | null; error?: { status: number } | null };
type HarnessOptions = {
  parentAnswer?: Answer;
  draftAnswer?: (body: Record<string, unknown>, index: number) => Answer;
  identityAnswer?: (body: Record<string, unknown>, index: number) => Answer;
  placementAnswer?: (body: Record<string, unknown>, index: number) => Answer;
};

function harness(options: HarnessOptions = {}) {
  const reads: string[] = [];
  const drafts: Array<{ body: Record<string, unknown>; key: string }> = [];
  const identities: Array<{ body: Record<string, unknown>; key: string }> = [];
  const placements: Array<{ body: Record<string, unknown>; key: string }> = [];
  const keyOf = (request: { headers?: Record<string, string> }) => request.headers?.['idempotency-key'] ?? '';
  const main = {
    v1: {
      'member-replies': ({ reply }: { reply: string }) => ({
        get: async () => {
          reads.push(reply);
          return options.parentAnswer ?? { data: { originRealm: realm } };
        },
      }),
      'member-reply-drafts': {
        post: async (body: Record<string, unknown>, request: { headers?: Record<string, string> }) => {
          drafts.push({ body, key: keyOf(request) });
          return options.draftAnswer?.(body, drafts.length - 1) ?? {
            data: body.body === null
              ? { revisionId: 'withdrawn-revision', revisionDigest: 'withdrawn-digest' }
              : { revisionId: 'revision', revisionDigest: 'digest' },
          };
        },
      },
      'realm-replies': {
        post: async (body: Record<string, unknown>, request: { headers?: Record<string, string> }) => {
          identities.push({ body, key: keyOf(request) });
          return options.identityAnswer?.(body, identities.length - 1) ?? { data: { reply: body.reply } };
        },
      },
      'realm-reply-placements': {
        post: async (body: Record<string, unknown>, request: { headers?: Record<string, string> }) => {
          placements.push({ body, key: keyOf(request) });
          return options.placementAnswer?.(body, placements.length - 1) ?? {
            data: { reply: body.reply, placement: 'placement' },
          };
        },
      },
    },
  };
  return { api: mainThreadApi(() => main as never), reads, drafts, identities, placements };
}

test('inherits the Realm parent origin and reads only that parent', async () => {
  const fx = harness({ parentAnswer: { data: { originRealm: realm } } });

  expect((await fx.api.reply(input('A child reply'), replyProgress())).kind).toBe('placed');
  expect(fx.reads).toEqual([parent.slice(-36)]);
  expect(fx.drafts[0]?.body).toMatchObject({ originRealm: realm });
  expect(fx.identities[0]?.body).toMatchObject({ parentReply: parent, parentRevision: revision(94) });
  expect(fx.placements[0]?.body).toMatchObject({ revisionDigest: 'digest' });
});

test('keeps an independent parent null-origin and reads no child digest', async () => {
  const fx = harness({ parentAnswer: { data: { originRealm: null } } });

  expect((await fx.api.reply(input('Independent child'), replyProgress())).kind).toBe('placed');
  expect(fx.reads).toEqual([parent.slice(-36)]);
  expect(fx.drafts[0]?.body).toHaveProperty('originRealm', null);
});

test('an unavailable parent leaves the intent untouched and writes no child', async () => {
  const fx = harness({ parentAnswer: { data: null, error: { status: 404 } } });
  const progress = replyProgress();

  const outcome = await fx.api.reply(input('Keep these words'), progress);

  expect(outcome).toEqual({ kind: 'failed', progress });
  expect(fx.reads).toEqual([parent.slice(-36)]);
  expect(fx.drafts).toHaveLength(0);
  expect(fx.identities).toHaveLength(0);
});

test('keeps the draft digest when the placement response is lost', async () => {
  const fx = harness({
    parentAnswer: { data: { originRealm: realm } },
    placementAnswer: (_body, index) => index === 0
      ? { data: null, error: { status: 0 } }
      : { data: { reply: iri(96), placement: 'placement' } },
  });
  const first = await fx.api.reply(input('Retry this reply'), replyProgress());
  expect(first.kind).toBe('failed');
  const progress = (first as { kind: 'failed'; progress: ReplyProgress }).progress;
  expect(progress).toMatchObject({ revisionId: 'revision', digest: 'digest', originRealm: realm, identified: true });

  expect((await fx.api.reply(input('Retry this reply'), progress)).kind).toBe('placed');
  expect(fx.drafts).toHaveLength(1);
  expect(fx.identities).toHaveLength(1);
  expect(fx.reads).toEqual([parent.slice(-36)]);
  expect(fx.placements.map(({ body }) => body.revisionDigest)).toEqual(['digest', 'digest']);
});

test('legacy independent progress replays the draft key and verifies its revision', async () => {
  const fx = harness({
    parentAnswer: { data: { originRealm: null } },
    draftAnswer: () => ({ data: { revisionId: 'saved-revision', revisionDigest: 'recovered-digest' } }),
  });
  const progress: ReplyProgress = {
    key: 'legacy-key', reply: iri(97), variantId: `urn:rezics:variant:${iri(98).slice(-36)}`,
    revisionId: 'saved-revision', identified: true,
  };

  expect((await fx.api.reply(input('Legacy words'), progress)).kind).toBe('placed');
  expect(fx.drafts).toHaveLength(1);
  expect(fx.drafts[0]?.key).toBe('legacy-key:draft');
  expect(fx.drafts[0]?.body).toMatchObject({ reply: iri(97) });
  expect(fx.drafts[0]?.body.originRealm).toBeUndefined();
  expect(fx.placements[0]?.body).toMatchObject({ revisionId: 'saved-revision', revisionDigest: 'recovered-digest' });
});

test('lost legacy draft response is replayed unchanged, withdrawn, then replaced with a Realm intent', async () => {
  const words = 'Replay the original words';
  const request = input(words);
  const fx = harness({
    parentAnswer: { data: { originRealm: realm } },
    // The prior draft call committed but its response was lost. This replay recovers it.
    draftAnswer: (_body, index) => index === 0
      ? { data: { revisionId: 'committed-revision', revisionDigest: 'committed-digest' } }
      : { data: { revisionId: 'fresh-revision', revisionDigest: 'fresh-digest' } },
  });
  const progress: ReplyProgress = {
    key: 'legacy-lost-key', reply: iri(103), variantId: `urn:rezics:variant:${iri(104).slice(-36)}`,
  };

  expect((await fx.api.reply(request, progress)).kind).toBe('placed');
  expect(fx.drafts).toHaveLength(3);
  expect(fx.drafts[0]).toMatchObject({
    key: 'legacy-lost-key:draft',
    body: {
      profile: 'member-reply-draft-v1',
      reply: progress.reply,
      variantId: progress.variantId,
      rootTarget: request.work,
      rootRevision: request.rootRevision,
      language: request.language,
      expectedHead: null,
      body: words,
      actingSubject: request.actingSubject,
    },
  });
  expect(fx.drafts[0]?.body.originRealm).toBeUndefined();
  expect(fx.drafts[1]).toMatchObject({
    key: 'legacy-lost-key:withdraw',
    body: { reply: iri(103), body: null, expectedHead: 'committed-revision' },
  });
  expect(fx.drafts[1]?.body.originRealm).toBeUndefined();
  expect(fx.drafts[2]?.key).not.toBe('legacy-lost-key:draft');
  expect(fx.drafts[2]?.body).toMatchObject({
    originRealm: realm,
    body: words,
  });
  expect(fx.drafts[2]?.body.reply).not.toBe(iri(103));
  expect(fx.drafts[2]?.key).not.toBe('legacy-lost-key:withdraw');
  expect(fx.placements[0]?.body).toMatchObject({ revisionId: 'fresh-revision', revisionDigest: 'fresh-digest' });
});

test('a mismatched legacy Realm draft is withdrawn before a fresh Realm intent', async () => {
  const fx = harness({ parentAnswer: { data: { originRealm: realm } } });
  const progress: ReplyProgress = {
    key: 'legacy-key', reply: iri(99), variantId: `urn:rezics:variant:${iri(100).slice(-36)}`,
    revisionId: 'legacy-revision', identified: true,
  };
  const original = { ...progress };

  expect((await fx.api.reply(input('Keep my words'), progress)).kind).toBe('placed');
  expect(progress).toEqual(original);
  expect(fx.drafts[0]).toMatchObject({ key: 'legacy-key:withdraw', body: { body: null, expectedHead: 'legacy-revision' } });
  expect(fx.drafts[0]?.body.originRealm).toBeUndefined();
  expect(fx.drafts[1]?.body).toMatchObject({ originRealm: realm, body: 'Keep my words' });
  expect(fx.drafts[1]?.key).not.toBe('legacy-key:draft');
  expect(fx.identities[0]?.body.reply).not.toBe(iri(99));
});

test('a definitive refusal clears the intent and lets the retained words retry after unban', async () => {
  let refused = true;
  const fx = harness({
    identityAnswer: (body) => refused
      ? { data: null, error: { status: 403 } }
      : { data: { reply: body.reply } },
  });
  const words = 'The reply remains in the composer';
  const rejected = replyProgress();

  expect((await fx.api.reply(input(words), rejected)).kind).toBe('refused');
  expect(fx.drafts[1]?.body).toMatchObject({ body: null, expectedHead: 'revision' });
  refused = false;
  const retry = await fx.api.reply(input(words), replyProgress());

  expect(retry.kind).toBe('placed');
  expect(fx.drafts[2]?.body).toMatchObject({ body: words, originRealm: realm });
  expect(fx.identities[1]?.body.reply).not.toBe(fx.identities[0]?.body.reply);
});

test('a changed revision on legacy draft replay never replaces saved progress', async () => {
  const fx = harness({
    parentAnswer: { data: { originRealm: null } },
    draftAnswer: () => ({ data: { revisionId: 'unexpected-revision', revisionDigest: 'wrong-digest' } }),
  });
  const progress: ReplyProgress = {
    key: 'legacy-key', reply: iri(101), variantId: `urn:rezics:variant:${iri(102).slice(-36)}`,
    revisionId: 'saved-revision', identified: true,
  };

  expect(await fx.api.reply(input('Legacy words'), progress)).toEqual({ kind: 'failed', progress: {
    ...progress, draftStarted: true,
  } });
  expect(fx.placements).toHaveLength(0);
});
