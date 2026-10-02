import { expect, test } from 'bun:test';
import { fromMarkdown, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import {
  mainThreadApi,
  replyProgress,
  type ReplyInput,
  type ReplyProgress,
} from '../features/feed/thread-api.ts';

const input = (body: string): ReplyInput => ({
  realm: 'realm',
  work: 'work',
  rootRevision: 'root',
  parent: { reply: 'parent', revisionId: 'seen-parent' },
  body,
  language: 'und',
  actingSubject: 'author',
});

function recordingApi(refused = false) {
  const drafts: Array<{
    body?: null;
    document?: DocumentSnapshot;
    direction: string;
    expectedHead: string | null;
  }> = [];
  let placements = 0;
  const main = {
    v1: {
      'member-reply-drafts': {
        post: async (draft: (typeof drafts)[number]) => {
          drafts.push(draft);
          return { data: { revisionId: 'revision' } };
        },
      },
      'realm-replies': { post: async () => ({ data: { reply: 'reply' } }) },
      'member-replies': () => ({ get: async () => ({ data: { revisionDigest: 'digest' } }) }),
      'realm-reply-placements': {
        post: async () => {
          if (refused) return { data: null, error: { status: 403 } };
          if (++placements === 1) throw new Error('Lost placement response');
          return { data: { reply: 'reply', placement: 'placed' } };
        },
      },
    },
  };
  return { api: mainThreadApi(() => main as never), drafts };
}

test('rich reply requests send one explicit snapshot and preserve progress after a thrown response', async () => {
  const document = fromMarkdown('**مرحبا**\n\n>!النهاية!<');
  const { api, drafts } = recordingApi();
  const first = await api.reply(input(serializeDocument(document)), replyProgress());
  expect(first.kind).toBe('failed');
  const progress = (first as { kind: 'failed'; progress: ReplyProgress }).progress;
  expect(progress).toMatchObject({ revisionId: 'revision', identified: true, digest: 'digest' });
  expect(drafts[0]).toMatchObject({ document, direction: 'rtl' });
  expect(drafts[0]?.body).toBeUndefined();
  expect((await api.reply(input(serializeDocument(document)), progress)).kind).toBe('placed');
  expect(drafts).toHaveLength(1);
});

test('a refused rich reply withdraws through the explicit null-body tombstone', async () => {
  const { api, drafts } = recordingApi(true);
  expect(
    (await api.reply(input(serializeDocument(fromMarkdown('Reply'))), replyProgress())).kind,
  ).toBe('refused');
  expect(drafts[1]).toMatchObject({ body: null, expectedHead: 'revision' });
  expect(drafts[1]?.document).toBeUndefined();
});
