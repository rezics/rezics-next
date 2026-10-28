import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { loadThreadPage } from '../src/threads/thread-page';

const app = join(import.meta.dir, '..');
const source = (path: string) => readFile(join(app, path), 'utf8');

test('an anonymous thread page read ignores a session cookie and sends no credential', async () => {
  const calls: Request[] = [];
  let sessionReads = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/posts')) return Response.json({ posts: [], next: null });
      return Response.json({ thread: { id: 'thread', firstPost: { id: 'opening' } } });
    },
  });
  await loadThreadPage(
    client as KernelClient,
    new Request('https://site.test/en/threads/thread/title', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    {
      SITE_ORIGINS: 'https://site.test',
      SESSIONS: {
        idFromName() {
          sessionReads += 1;
          return 'session';
        },
        get() {
          sessionReads += 1;
          throw new Error('session must not be read');
        },
      },
    } as never,
    { id: 'thread' },
    { sitekey: '', scriptUrl: 'https://site.test/turnstile.js' },
    'anonymous',
  );
  expect(sessionReads).toBe(0);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((request) => request.headers.get('authorization') === null)).toBe(true);
});

test('board and thread routes render anonymously without session rereads', async () => {
  for (const route of ['routes/boards/$id.tsx', 'routes/threads/$id_.$slug.tsx', 'routes/threads/$id.tsx']) {
    const text = await source(`src/${route}`);
    expect(text).not.toContain('sessionReread');
  }
  const reads = await source('src/threads/reads.ts');
  expect(reads).toContain('readThreadPersonal');
  expect(await source('src/threads/thread-queries.ts')).toContain('personalRead');
  expect(await source('src/router.tsx')).toContain('credentialMode: anonymousReadMode');
  expect(await source('src/session/query.ts')).toContain(".server((): ClientSession => ({ state: 'unknown'");
  expect(reads).toContain("data.credentialMode ?? 'anonymous'");
});

test('personal controls use browser queries and reserve their first-paint space', async () => {
  const queries = await source('src/threads/thread-queries.ts');
  expect(queries).toContain('personalRead');
  expect(queries).toContain('threadPersonalQuery');
  const route = await source('src/routes/threads/$id_.$slug.tsx');
  expect(route).toContain('useQuery');
  expect(route).toContain("enabled: session === 'signed-in'");
  expect(route).toContain('personal');
  expect(route).toContain('min-h');
  expect(route).toContain('SignInPrompt');
});

test('thread mutations update or invalidate cached thread and personal reads', async () => {
  const route = await source('src/routes/threads/$id_.$slug.tsx');
  const reactions = await source('src/threads/thread-reactions.tsx');
  expect(route).toContain('invalidateQueries');
  expect(route).toContain('onMutation');
  expect(reactions).toContain('onMutation');
  expect(route).not.toContain('location.reload');
});
