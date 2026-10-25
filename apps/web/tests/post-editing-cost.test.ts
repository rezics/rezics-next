import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import type { SessionEnv } from '../src/session/client.ts';
import { erasePostRequest, revisePostRequest } from '../src/threads/post-writes.ts';

const sessionId = 'a'.repeat(43);
const csrf = 'A'.repeat(22);
const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const body: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text: 'Edited text' }] }],
  },
};

type Metrics = { K: number; D: number; R: number; A: number };
type KernelCall = { method: string; path: string; idempotencyKey: string | null; ifMatch: string | null };

function harness(size: number) {
  const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
  const calls: KernelCall[] = [];
  const sessionStub = {
    async credential() {
      metrics.D++;
      return { status: 'active', subject: 'owner', accessToken: 'access', csrfToken: csrf };
    },
    async signedIn() {
      metrics.D++;
      return { signedIn: true, subject: 'owner', csrfToken: csrf };
    },
  };
  const env = {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'post:revise post:erase',
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
  const dataset = Array.from({ length: size }, (_, index) => ({ id: index === 0 ? targetId : `post-${index}` }));
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      metrics.K++;
      calls.push({
        method: request.method,
        path: url.pathname,
        idempotencyKey: request.headers.get('idempotency-key'),
        ifMatch: request.headers.get('if-match'),
      });
      if (url.pathname === `/v1/posts/${dataset[0]!.id}/revisions` && request.method === 'POST') {
        return Response.json({
          post: {
            id: targetId,
            threadId: targetId,
            route: 0,
            authorId: 'owner',
            parentId: null,
            licence: 'LicenseRef-rezics-terms',
            subjectIds: [],
            boardId: targetId,
            visibility: 'published',
            securityRevision: '1',
            availability: 'available',
            createdAt: '2026-01-01T00:00:00.000Z',
            revisedAt: '2026-01-02T00:00:00.000Z',
            revisionId,
            sha256: 'a'.repeat(64),
            mediaIds: [],
            body,
          },
        });
      }
      if (url.pathname === `/v1/posts/${dataset[0]!.id}` && request.method === 'DELETE')
        return new Response(null, { status: 204 });
      return Response.json({ status: 404, code: 'not_found' }, { status: 404 });
    },
  });
  const request = () =>
    new Request('https://site.test/_serverfn/post-write', {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        cookie: `__Host-rezics_session=${sessionId}`,
        'x-csrf-token': csrf,
      },
    });
  return { client, env, metrics, calls, request };
}

const refused = () => ({ ok: false as const, reason: 'unavailable' as const });

test('post edits keep K/D/R/A fixed as post data grows', async () => {
  for (const size of [1, 10, 100]) {
    const h = harness(size);
    const result = await revisePostRequest(
      { postId: targetId, revisionId, body, idempotencyKey, mediaIds: [] },
      h.request(),
      h.env,
      h.client,
      refused,
    );
    expect(result.ok).toBe(true);
    expect(h.metrics).toEqual({ K: 1, D: 1, R: 0, A: 0 });
    expect(h.calls).toEqual([
      {
        method: 'POST',
        path: `/v1/posts/${targetId}/revisions`,
        idempotencyKey,
        ifMatch: `"${revisionId}"`,
      },
    ]);
  }
});

test('post deletions keep K/D/R/A fixed as post data grows', async () => {
  for (const size of [1, 10, 100]) {
    const h = harness(size);
    const result = await erasePostRequest({ postId: targetId, idempotencyKey }, h.request(), h.env, h.client, refused);
    expect(result.ok).toBe(true);
    expect(h.metrics).toEqual({ K: 1, D: 1, R: 0, A: 0 });
    expect(h.calls).toEqual([
      {
        method: 'DELETE',
        path: `/v1/posts/${targetId}`,
        idempotencyKey,
        ifMatch: null,
      },
    ]);
  }
});
