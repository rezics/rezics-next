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
          return { data: { revisionId: 'revision' } };
        },
      },
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
