import { expect, mock, spyOn, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const site = 'https://site.test';
const threadId = 'thread-one';
const postId = 'post-one';
const revisionId = 'revision-one';
const subjectId = 'subject-one';
let request: Request;
let native: KernelClient;
let signedIn = true;
const responseHeaders = new Headers();

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    SITE_ORIGINS: site,
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'thread:read',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: () => sessionId,
      get: () => ({
        credential: async () =>
          signedIn
            ? { status: 'active', subject: 'viewer-one', accessToken: 'access', csrfToken }
            : { status: 'absent', csrfToken: null },
      }),
    },
  },
}));
mock.module('../src/kernel/client', () => ({ kernelClient: () => native }));

const readModule = await import('../src/threads/reads');

function requestFor(signal?: AbortSignal) {
  request = new Request(`${site}/en/threads/${threadId}/title`, {
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      origin: site,
    },
    ...(signal ? { signal } : {}),
  });
  responseHeaders.delete('cache-control');
}

type Call = { kind: 'thread' | 'thread-reaction' | 'post-reaction' | 'vote'; target: string; signal?: AbortSignal };
type ReactionResult = { error?: unknown; data?: { kind?: string | null } } | Error;

function personalClient(reactions: Record<string, ReactionResult> = {}) {
  const calls: Call[] = [];
  const signalOf = (options: { fetch?: { signal?: AbortSignal } }) => options.fetch?.signal;
  const reviewThread = {
    id: threadId,
    kind: 'review',
    authorId: 'viewer-one',
    firstPost: {
      id: revisionId,
      authorId: 'viewer-one',
      subjectIds: [subjectId],
      voteCitation: { questionId: 'question-one', units: 2, revision: 3 },
    },
  };
  const client = {
    threads: ({ id }: { id: string }) => ({
      get: async (options: { fetch?: { signal?: AbortSignal } }) => {
        calls.push({ kind: 'thread', target: id, signal: signalOf(options) });
        return { data: { thread: reviewThread } };
      },
      reaction: {
        get: async (options: { fetch?: { signal?: AbortSignal } }) => {
          calls.push({ kind: 'thread-reaction', target: id, signal: signalOf(options) });
          const result = reactions[id] ?? { data: { kind: null } };
          if (result instanceof Error) throw result;
          return result;
        },
      },
    }),
    posts: ({ id }: { id: string }) => ({
      reaction: {
        get: async (options: { fetch?: { signal?: AbortSignal } }) => {
          calls.push({ kind: 'post-reaction', target: id, signal: signalOf(options) });
          const result = reactions[id] ?? { data: { kind: null } };
          if (result instanceof Error) throw result;
          return result;
        },
      },
    }),
    subjects: ({ id }: { id: string }) => ({
      ratings: ({ questionId }: { questionId: string }) => ({
        vote: {
          get: async (options: { fetch?: { signal?: AbortSignal } }) => {
            calls.push({ kind: 'vote', target: `${id}:${questionId}`, signal: signalOf(options) });
            return { data: { units: 5, revision: 7 } };
          },
        },
      }),
    }),
  } as unknown as KernelClient;
  return { client, calls };
}

test('an anonymous personal response is not an empty signed-in reaction slot', async () => {
  signedIn = false;
  requestFor();
  try {
    const result = await readModule.readThreadPersonal({
      data: { id: threadId, postIds: [postId], readReactions: true },
    });
    expect(result).toEqual({ viewerId: null, reactions: {}, reviewVotes: {} });
  } finally {
    signedIn = true;
  }
});

test('composed personal reads skip reaction fanout and retain exact author revision votes', async () => {
  const controller = new AbortController();
  const fixture = personalClient();
  native = fixture.client;
  requestFor(controller.signal);

  const result = await readModule.readThreadPersonal({ data: { id: threadId, postIds: [], readReactions: false } });

  expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  expect(result.viewerId).toBe('viewer-one');
  expect(result.reactions).toEqual({});
  expect(result.reviewVotes).toEqual({
    [revisionId]: { questionId: 'question-one', units: 5, revision: 7 },
  });
  expect(fixture.calls.map((call) => call.kind)).toEqual(['thread', 'vote']);
  expect(fixture.calls.every((call) => call.signal === controller.signal)).toBe(true);
});

test('a known empty reaction slot stays distinct from an unavailable legacy slot', async () => {
  const fixture = personalClient({
    [threadId]: { data: { kind: null } },
    [postId]: new Error('post reaction read failed'),
  });
  native = fixture.client;
  requestFor();

  const result = await readModule.readThreadPersonal({
    data: { id: threadId, postIds: [postId], readReactions: true },
  });

  expect(result.reactions).toEqual({
    [threadId]: { state: 'ready', value: null },
    [postId]: { state: 'unavailable' },
  });
});

test('the personal query preserves its exact cursor and forwards cancellation to the BFF call', async () => {
  const { threadPersonalQuery } = await import('../src/threads/thread-queries');
  const read = spyOn(readModule, 'readThreadPersonal').mockImplementation(async () => ({
    viewerId: 'viewer-one',
    reactions: {},
    reviewVotes: {},
  }));
  const options = threadPersonalQuery(threadId, 'exact-cursor', [postId]);
  const signal = new AbortController().signal;
  try {
    const result = await options.queryFn!({ signal } as never);
    expect(options.queryKey).toEqual(['thread-personal', threadId, 'exact-cursor', false, postId]);
    expect(read).toHaveBeenCalledWith({
      data: { id: threadId, postIds: [], readReactions: false },
      signal,
    });
    expect(typeof result.idempotencyKey).toBe('string');
  } finally {
    read.mockRestore();
  }
});
