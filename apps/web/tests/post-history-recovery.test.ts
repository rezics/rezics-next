import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { m } from '../src/paraglide/messages.js';
import revisions from '../src/kernel/recorded/thread-history-revisions.json';

const app = join(import.meta.dir, '..');
const first = revisions.revisions[0]!;
const second = revisions.revisions[1]!;
const cursor = 'native-signed/+=continuation';
type Props = { postId?: string; viewerId?: string; authority?: string };
type Driver = {
  mountHistory(props?: Props): void;
  unmountHistory(): void;
  finishHistory(body: unknown, status: number): void;
  rejectHistory(): void;
  historyCalls: { postId: string; cursor: string | null; limit: string | null; authorization: string | null }[];
  pendingHistory: unknown[];
};
let browser: Browser | undefined;
let bundle: Promise<string> | undefined;

// Only the native transport and request environment are controlled. The mounted component, reader,
// validator, native client and revision renderer are the delivered implementations. No server is started.
async function componentBundle() {
  bundle ??= (async () => {
    const directory = join(app, '../../.temp/post-history-recovery');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'entry.tsx');
    await writeFile(
      entry,
      `
      import React from ${JSON.stringify(Bun.resolveSync('react', app))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', app))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync('react-dom', app))};
      import { PostHistory } from ${JSON.stringify(join(app, 'src/threads/post-history.tsx'))};
      import accounts from ${JSON.stringify(join(app, 'src/kernel/recorded/thread-history-accounts.json'))};
      import subject from ${JSON.stringify(join(app, 'src/kernel/recorded/subject.json'))};
      import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
      setLocale('en', { reload: false });
      window.historyCalls = [];
      window.pendingHistory = [];
      window.historyFetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const history = new RegExp('^/v1/posts/([^/]+)/revisions$').exec(url.pathname);
        if (history) {
          window.historyCalls.push({ postId: history[1], cursor: url.searchParams.get('cursor'),
            limit: url.searchParams.get('limit'), authorization: request.headers.get('authorization') });
          return new Promise((resolve, reject) => window.pendingHistory.push({ resolve, reject }));
        }
        if (url.pathname === '/v1/accounts') return Response.json(accounts);
        if (url.pathname.endsWith('/vote')) return Response.json({ units: 9000, revision: 2 });
        if (url.pathname.startsWith('/v1/subjects/')) return Response.json(subject);
        throw new Error('Unexpected native request: ' + url.pathname);
      };
      window.finishHistory = (body, status) => window.pendingHistory.shift().resolve(Response.json(body, { status }));
      window.rejectHistory = () => window.pendingHistory.shift().reject(new Error('History transport unavailable'));
      const authorities = new Map();
      let root;
      window.mountHistory = ({ postId = ${JSON.stringify(first.id)}, viewerId, authority = 'one' } = {}) => {
        window.historyViewer = viewerId;
        if (!authorities.has(authority)) authorities.set(authority, {});
        root ??= createRoot(document.getElementById('app'));
        flushSync(() => root.render(<React.StrictMode><PostHistory postId={postId} viewerId={viewerId}
          readAuthority={authorities.get(authority)} review /></React.StrictMode>));
      };
      window.unmountHistory = () => { flushSync(() => root.unmount()); root = undefined; };
      `,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
      plugins: [
        {
          name: 'history-request-boundary',
          setup(build) {
            build.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
              path: join(app, '.storybook/react-start.ts'),
            }));
            build.onResolve(
              { filter: /^@tanstack\/react-start\/server$|^cloudflare:workers$|^\.\.\/kernel\/client$/ },
              ({ path }) => ({ path, namespace: 'history-boundary' }),
            );
            build.onLoad({ filter: /.*/, namespace: 'history-boundary' }, ({ path }) => ({
              loader: 'js',
              contents: path === '@tanstack/react-start/server'
                ? `export * from ${JSON.stringify(join(app, '.storybook/react-start.ts'))};
                   export const getRequest = () => new Request('https://site.test/en/thread', { headers:
                    window.historyViewer ? { cookie: '__Host-rezics_session=${'a'.repeat(43)}' } : {} });
                   export const setResponseHeader = () => {};`
                : path === 'cloudflare:workers'
                  ? `export const env = { AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test',
                      WEBSITE_SCOPES: 'openid', WEBSITE_CLIENT_ID: 'history-test', WEBSITE_CLIENT_KEY: '{}',
                      SESSIONS: { idFromName: id => id, get: () => ({ credential: async () => ({ status: 'active',
                        subject: window.historyViewer, accessToken: window.historyViewer, csrfToken: 'test' }) }) } };`
                  : `import { createKernelClient } from ${JSON.stringify(Bun.resolveSync('@rezics/client', app))};
                     export const kernelClient = () => createKernelClient('https://kernel.test', { fetch: window.historyFetch });`,
            }));
          },
        },
      ],
    });
    expect(result.success, result.logs.map(String).join('\n')).toBe(true);
    return result.outputs[0]!.text();
  })();
  return bundle;
}

async function mounted() {
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  await page.route('https://site.test/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<main id="app"></main>',
  }));
  await page.goto('https://site.test/en/thread');
  await page.addScriptTag({ content: await componentBundle() });
  await mount(page);
  return page;
}
async function mount(page: Page, props: Props = {}) {
  await page.evaluate((props) => (window as unknown as Driver).mountHistory(props), props);
}
async function open(page: Page, count = 1) {
  await page.getByRole('button', { name: m.thread_history_show() }).click();
  await pending(page, count);
}
async function pending(page: Page, count = 1) {
  await page.waitForFunction((count) => (window as unknown as Driver).pendingHistory.length === count, count);
}
async function finish(page: Page, body: unknown, status = 200) {
  await page.evaluate(({ body, status }) => (window as unknown as Driver).finishHistory(body, status), { body, status });
}
async function unavailable(page: Page) {
  await page.getByText(m.thread_history_unavailable(), { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('section button');
    return button && !button.disabled;
  });
}
async function versions(page: Page, count: number) {
  await page.waitForFunction((count) => document.querySelectorAll('section > ol > li').length === count, count);
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as Driver).historyCalls);
}

afterAll(async () => {
  await browser?.close();
});

test('A failed immutable revision history read can be explicitly retried through the existing reader without keeping stale viewer-bound history or losing the requested continuation', async () => {
  const page = await mounted();
  try {
    await open(page);
    await finish(page, { code: 'dependency_unavailable' }, 503);
    await unavailable(page);
    const retry = page.getByRole('button', { name: m.exact_revision_retry() });
    await retry.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await pending(page);
    expect(await retry.isDisabled()).toBe(true);
    expect(await page.getByText(m.thread_history_unavailable(), { exact: true }).isVisible()).toBe(true);
    expect(await calls(page)).toHaveLength(2);
    await finish(page, { revisions: [first], next: cursor });
    await versions(page, 1);
    expect(
      await page.getByRole('link', { name: m.thread_history_version({ number: '1' }), exact: true }).getAttribute('href'),
    ).toContain(`/posts/${first.id}/revisions/${first.revisionId}`);
    expect(await page.getByRole('region', { name: m.thread_history_heading() }).textContent()).toContain(first.licence);
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
    await unavailable(page);
    expect(await page.locator('section > ol').count()).toBe(0);
    await page.getByRole('button', { name: m.thread_history_hide() }).click();
    await page.getByRole('button', { name: m.thread_history_show() }).click();
    expect(await calls(page)).toHaveLength(3);
    await retry.click();
    await pending(page);
    expect(await page.locator('section > ol').count()).toBe(0);
    expect(await page.getByText(m.thread_history_unavailable(), { exact: true }).isVisible()).toBe(true);
    await finish(page, { revisions: [second], next: null });
    await versions(page, 2);
    expect(await page.locator('section > ol > li').count()).toBe(2);
    expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(0);
    expect((await calls(page)).map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: null, limit: '20' },
      { cursor: null, limit: '20' },
      { cursor, limit: '20' },
      { cursor, limit: '20' },
    ]);
  } finally {
    await page.close();
  }
});

test('mounted post, viewer and read-authority changes discard disclosure, comparison, continuation and late results, including unmount', async () => {
  const page = await mounted();
  try {
    const scored = { ...first, subjectIds: ['subject'], voteCitation: { questionId: 'question', units: 6000, revision: 1 } };
    for (const change of [{ viewerId: 'another-viewer' }, { postId: second.revisionId }, { authority: 'two' }]) {
      await mount(page, { viewerId: first.authorId });
      await open(page);
      await finish(page, { revisions: [scored], next: cursor });
      await versions(page, 1);
      await page.getByText(m.thread_provenance_current_vote(), { exact: true }).waitFor();
      await page.getByRole('button', { name: m.thread_history_more() }).click();
      await pending(page);
      await mount(page, { viewerId: first.authorId, ...change });
      expect(await page.getByRole('region', { name: m.thread_history_heading() }).count()).toBe(0);
      expect(await page.getByText(m.thread_provenance_current_vote(), { exact: true }).count()).toBe(0);
      await open(page, 2);
      // The old scope's successful continuation cannot populate or unlock the new disclosure.
      await finish(page, { revisions: [second], next: cursor });
      expect(await page.locator('section > ol').count()).toBe(0);
      await finish(page, { code: 'forbidden' }, 403);
      await unavailable(page);
      await page.getByRole('button', { name: m.exact_revision_retry() }).click();
      await pending(page);
      expect((await calls(page)).at(-1)?.cursor).toBeNull();
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
      await mount(page);
      await finish(page, { revisions: [scored], next: cursor });
      expect(await page.getByRole('region', { name: m.thread_history_heading() }).count()).toBe(0);
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
    }
  } finally {
    await page.close();
  }
});
