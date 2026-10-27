import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadThreadPage } from '../src/threads/thread-page';
import thread from '../src/kernel/recorded/thread.json';
import posts from '../src/kernel/recorded/thread-posts.json';
import board from '../src/kernel/recorded/board.json';

const request = new Request('https://example.test/');
const verification = { sitekey: '', scriptUrl: '' };

test('reads the thread board once regardless of post count and tolerates a missing board', async () => {
  for (const count of [1, posts.posts.length]) {
    for (const missing of [false, true]) {
      const calls: string[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          const path = new URL(new Request(input, init).url).pathname;
          calls.push(path);
          if (path.endsWith('/posts')) return Response.json({ ...posts, posts: posts.posts.slice(0, count) });
          if (path.includes('/boards/')) return missing ? new Response(null, { status: 404 }) : Response.json(board);
          return Response.json(thread);
        },
      });
      const page = await loadThreadPage(client, request, {}, { id: thread.thread.id }, verification);
      expect(calls).toHaveLength(3);
      expect(calls.filter((path) => path.endsWith(`/boards/${thread.thread.boardId}`))).toHaveLength(1);
      expect(page.board?.title).toBe(missing ? undefined : board.board.title);
    }
  }
});

test('the thread head, subjects, composer and post anchors provide a compact accessible frame', async () => {
  const route = await Bun.file(new URL('../src/routes/threads/$id.tsx', import.meta.url)).text();
  const subjects = await Bun.file(new URL('../src/threads/thread-subjects.tsx', import.meta.url)).text();
  const composer = await Bun.file(new URL('../src/threads/composer.tsx', import.meta.url)).text();
  const context = await Bun.file(new URL('../src/threads/thread-context.tsx', import.meta.url)).text();
  expect(route).toContain('<BoardContext');
  expect(context).toContain('to="/boards/$id"');
  const head = route.split('<header')[1]!.split('</header>')[0]!;
  expect(head).not.toContain('<Byline');
  expect(head).not.toContain('createdAt');
  expect(route).toContain('scroll-mt-');
  expect(subjects).toContain('size="xs"');
  expect(subjects).toContain('overflow-x-auto');
  expect(composer).toContain('placeholder={');
  expect(composer).toContain('thread_reply_label');
  expect(route).toContain('window.scrollTo(0, 0)');
  expect(route).toContain('scrollIntoView()');
});
