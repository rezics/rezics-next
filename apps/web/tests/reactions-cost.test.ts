import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client.ts';
import { changeReactionRequest } from '../src/threads/reaction-request.ts';
import { loadThreadPage } from '../src/threads/thread-page.ts';

const sessionId = 'a'.repeat(43);
const csrf = 'A'.repeat(22);
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const sizes = [1, 10, 100];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Metrics = { K: number; D: number; R: number; A: number };
type KernelCall = { method: string; path: string; authorization: string | null; idempotencyKey: string | null };

function sessionEnv(metrics: Metrics): Partial<SessionEnv> {
  const sessionStub = {
    async credential() {
      metrics.D += 1;
      return { status: 'active', subject: 'member', accessToken: 'access', csrfToken: csrf };
    },
    async signedIn() {
      metrics.D += 1;
      return { signedIn: true, subject: 'member', csrfToken: csrf };
    },
  };
  return {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'reaction:set',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName() {
        return sessionId;
      },
      get() {
        return sessionStub;
      },
    },
  } as unknown as Partial<SessionEnv>;
}

function recordingClient(size: number, metrics: Metrics, calls: KernelCall[]) {
  let pending = 0;
  let maxPending = 0;
  const stored = Array.from({ length: size }, (_, index) => `reaction-${index}`);
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/auth/')) {
        metrics.A += 1;
        return new Response(null, { status: 404 });
      }
      metrics.K += 1;
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await Promise.resolve();
      try {
        calls.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get('authorization'),
          idempotencyKey: request.headers.get('idempotency-key'),
        });
        if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}`) {
          return Response.json({
            thread: {
              id: threadId,
              reactions: { upvote: size },
              viewerReaction: 'upvote',
              firstPost: { id: `${threadId}-first` },
            },
          });
        }
        if (request.method === 'GET' && url.pathname === `/v1/threads/${threadId}/posts`) {
          return Response.json({
            posts: stored.map((id) => ({ id, reactions: { like: 1 }, viewerReaction: null })),
            next: null,
          });
        }
        if (url.pathname === `/v1/posts/${stored[0]}/reaction` && request.method === 'PUT') {
          return Response.json({ kind: 'like' });
        }
        if (url.pathname === `/v1/posts/${stored[0]}/reaction` && request.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `/v1/threads/${threadId}/reaction` && request.method === 'PUT') {
          return Response.json({ kind: 'love' });
        }
        if (url.pathname === `/v1/threads/${threadId}/reaction` && request.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return Response.json({ status: 404, code: 'not_found' }, { status: 404 });
      } finally {
        pending -= 1;
      }
    },
  });
  return {
    client,
    stored,
    peak() {
      return maxPending;
    },
  };
}

function signedRequest(method: 'GET' | 'POST') {
  return new Request(`https://site.test/en/threads/${threadId}`, {
    method,
    headers: {
      origin: 'https://site.test',
      cookie: `__Host-rezics_session=${sessionId}`,
      'x-csrf-token': csrf,
    },
  });
}

test('thread page reads stay within their bound as s grows', async () => {
  for (const size of sizes) {
    const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
    const calls: KernelCall[] = [];
    const recorded = recordingClient(size, metrics, calls);
    const page = await loadThreadPage(
      recorded.client,
      signedRequest('GET'),
      sessionEnv(metrics),
      { id: threadId },
      {
        sitekey: '',
        scriptUrl: 'https://site.test/turnstile.js',
      },
      'anonymous',
    );
    expect(page.posts.posts).toHaveLength(size);
    expect(page.thread.reactions).toEqual({ upvote: size });
    expect(metrics).toEqual({ K: 2, D: 0, R: 0, A: 0 });
    expect(recorded.peak()).toBe(2);
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(
      [`GET /v1/threads/${threadId}`, `GET /v1/threads/${threadId}/posts`].sort(),
    );
    expect(calls.every((call) => call.authorization === null)).toBe(true);
    expect(calls.some((call) => call.path.endsWith('/reaction'))).toBe(false);
  }
});

test('setting or clearing a reaction stays within its bound as s grows', async () => {
  for (const size of sizes) {
    for (const kind of ['like', null] as const) {
      const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
      const calls: KernelCall[] = [];
      const recorded = recordingClient(size, metrics, calls);
      const result = await changeReactionRequest(
        { target: 'post', id: recorded.stored[0]!, kind },
        signedRequest('POST'),
        sessionEnv(metrics),
        recorded.client,
      );
      expect(result.ok).toBe(true);
      expect(metrics).toEqual({ K: 1, D: 1, R: 0, A: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe(kind === null ? 'DELETE' : 'PUT');
      expect(calls[0]?.path).toBe(`/v1/posts/${recorded.stored[0]}/reaction`);
      expect(calls[0]?.authorization).toBe('Bearer access');
      expect(calls[0]?.idempotencyKey).toMatch(uuid);
    }
    const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
    const calls: KernelCall[] = [];
    const recorded = recordingClient(size, metrics, calls);
    const result = await changeReactionRequest(
      { target: 'thread', id: threadId, kind: 'love' },
      signedRequest('POST'),
      sessionEnv(metrics),
      recorded.client,
    );
    expect(result.ok).toBe(true);
    expect(metrics).toEqual({ K: 1, D: 1, R: 0, A: 0 });
    expect(calls[0]?.path).toBe(`/v1/threads/${threadId}/reaction`);
  }
});
