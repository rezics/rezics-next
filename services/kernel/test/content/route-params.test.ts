import { afterAll, expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { Pool } from 'pg';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';

const pool = new Pool({ connectionString: 'postgres://kernel.invalid/route-params-contract' });
afterAll(() => pool.end());

function assertContentClientRoutes(client: KernelClient) {
  const thread = client.threads({ id: 'thread-id' });
  const post = client.posts({ id: 'post-id' });
  const routes = {
    thread: { get: thread.get, posts: thread.posts, reaction: thread.reaction },
    post: { get: post.get, revisions: post.revisions, reaction: post.reaction },
  } satisfies {
    thread: { get: unknown; posts: unknown; reaction: unknown };
    post: { get: unknown; revisions: unknown; reaction: unknown };
  };
  void routes;
}
void assertContentClientRoutes;

test('mounted thread and post routes use id for their resource path segment', () => {
  const document = openApiDocument(createKernel({ pool, routeKey: new Uint8Array(32).fill(1) }));
  const paths = Object.keys(document.paths).filter((path) => /^\/v1\/(?:threads|posts)\/\{[^}]+\}(?:\/|$)/.test(path));

  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect(path).toMatch(/^\/v1\/(?:threads|posts)\/\{id\}(?:\/|$)/);
});
