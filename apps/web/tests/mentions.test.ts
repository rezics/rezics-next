import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { normalizeDocument, type DocumentSnapshot } from '@rezics/document';
import { readFileSync } from 'node:fs';
import { readDocumentMentions, lookupAccountMention } from '../src/kernel/mentions.ts';
import { loadThreadPage } from '../src/threads/thread-page.ts';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function body(ids: string[]): DocumentSnapshot {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { id: 'q' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p' },
              content: ids.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
            },
          ],
        },
      ],
    },
  });
}
function recording(size: number) {
  const ids = Array.from({ length: size }, (_, i) => id(100 + i));
  const posts = ids.length
    ? ids.map((accountId, index) => ({ id: id(300 + index), body: body([accountId, accountId]) }))
    : [{ id: id(300), body: body([]) }];
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(url);
      if (url.pathname === `/v1/threads/${id(1)}`) return Response.json({ thread: { id: id(1), firstPost: posts[0] } });
      if (url.pathname === `/v1/threads/${id(1)}/posts`) return Response.json({ posts, next: null });
      if (url.pathname === '/v1/accounts')
        return Response.json({
          accounts: (url.searchParams.get('ids')?.split(',') ?? []).map((accountId) => ({
            id: accountId,
            handle: `current-${accountId.slice(-3)}`,
            state: 'active',
          })),
        });
      return new Response(null, { status: 404 });
    },
  });
  return { client, ids, posts, calls };
}

test('one thread page render batches all post mentions into one account read at 1, 10 and 100 accounts, and none at zero', async () => {
  for (const size of [0, 1, 10, 100, 120]) {
    const { client, calls, ids } = recording(size);
    const page = await loadThreadPage(
      client,
      new Request(`https://site.test/en/threads/${id(1)}`),
      {},
      { id: id(1) },
      { sitekey: '', scriptUrl: '' },
    );
    const reads = calls.filter((url) => url.pathname === '/v1/accounts');
    expect(reads).toHaveLength(size ? 1 : 0);
    if (size) expect(reads[0]!.searchParams.get('ids')?.split(',')).toEqual(ids.slice(0, 100));
    expect(Object.keys(page.mentions)).toEqual(ids.slice(0, 100));
    expect(page.posts.posts).toHaveLength(Math.max(size, 1));
  }
});

test('document order, repeated ids, erased bodies, deleted accounts and optional read failures are handled', async () => {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new URL(new Request(input, init).url));
      return Response.json({
        accounts: [
          { id: id(2), state: 'active', handle: 'renamed' },
          { id: id(3), state: 'deleted', handle: null },
          { id: id(4), state: 'active', handle: null },
          { id: id(99), state: 'active', handle: 'unrequested' },
        ],
      });
    },
  });
  expect(await readDocumentMentions(client, [body([id(2), id(3), id(2)]), null, body([id(4)])])).toEqual({
    [id(2)]: { handle: 'renamed' },
  });
  expect(calls[0]!.searchParams.get('ids')).toBe([id(2), id(3), id(4)].join(','));
  for (const fetch of [
    async () => new Response(null, { status: 503 }),
    async () => {
      throw new Error('offline');
    },
  ]) {
    expect(await readDocumentMentions(createKernelClient('https://kernel.test', { fetch }), [body([id(2)])])).toEqual(
      {},
    );
  }
});

test('composer lookup uses the exact active handle endpoint and forwards cancellation', async () => {
  for (const state of ['active', 'deleted', 'missing']) {
    const controller = new AbortController();
    let seen: Request | undefined;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        seen = new Request(input, init);
        return Response.json({
          accounts: state === 'missing' ? [] : [{ id: id(2), handle: 'abcdefghij', displayName: '<b>Name</b>', state }],
        });
      },
    });
    const result = await lookupAccountMention(client, 'abcdefghij', controller.signal);
    expect(new URL(seen!.url).searchParams.get('handle')).toBe('abcdefghij');
    expect(seen!.method).toBe('GET');
    expect(result).toEqual(state === 'active' ? { accountId: id(2), handle: 'abcdefghij', name: '<b>Name</b>' } : null);
    controller.abort();
    expect(seen!.signal.aborted).toBe(true);
  }
});

test('mention labels exist natively in every supported locale and the composer and thread wire the feature', () => {
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es']) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['editor_mention_accounts', 'editor_mention_loading'])
      expect(messages[key]?.length).toBeGreaterThan(0);
  }
  const composer = readFileSync(new URL('../src/threads/composer.tsx', import.meta.url), 'utf8');
  expect(composer).toContain('lookupMention=');
  const route = readFileSync(new URL('../src/routes/threads/$id_.$slug.tsx', import.meta.url), 'utf8');
  expect(route).toContain('mentions={mentions}');
  expect(route).toContain('locale={getLocale()}');
});

test('the real thread route displays mentions and the post composer submits mention nodes', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const app = join(import.meta.dir, '..');
  const output = mkdtempSync(join(app, '../../.temp/web-mentions-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      ['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, 'src/stories/mentions.stories.tsx'],
      { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    const assertions = result.testResults.flatMap((file: any) => file.assertionResults);
    expect(
      code,
      assertions.flatMap((test: any) => test.failureMessages).join('\n') + stdout.slice(-1000) + stderr.slice(-1000),
    ).toBe(0);
    expect(assertions.map((test: any) => `${test.title}: ${test.status}`).sort()).toEqual([
      'Composer Submission: passed',
      'Editor Mention: passed',
      'Thread: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
