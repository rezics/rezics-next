import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { m } from '../src/paraglide/messages.js';
import revisions from '../src/kernel/recorded/thread-history-revisions.json';
import subject from '../src/kernel/recorded/subject.json';

const app = join(import.meta.dir, '..');
const first = revisions.revisions[0]!;
const second = revisions.revisions[1]!;
const cursor = 'native-signed/+=continuation';
type Props = { postId?: string; viewerId?: string; authority?: string; client?: string };
type Session = { state: string; subject?: string | null; csrfToken: string | null };
const signedIn: Session = { state: 'signed-in', subject: first.authorId, csrfToken: 'original-csrf' };
const signedOut: Session = { state: 'signed-out', subject: null, csrfToken: null };
const mediaId = '00000000-0000-7000-8000-000000000001';
const scored = {
  ...first,
  subjectIds: [subject.subject.id],
  voteCitation: { questionId: 'question', units: 6000, revision: 1 },
  mediaIds: [mediaId],
  body: {
    ...first.body,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Original private reading lifetime' },
            { type: 'mention', attrs: { accountId: first.authorId } },
          ],
        },
        { type: 'image', attrs: { src: mediaId, alt: 'Original revision illustration' } },
      ],
    },
  },
};
type Driver = {
  mountHistory(props?: Props): void;
  unmountHistory(): void;
  setHistorySession(session: Session | null, client?: string): void;
  retainHistory(label: string): void;
  invokeHistory(): void;
  replayHistoryConnection(): void;
  historyRelatedCalls: { path: string; authorization: string | null }[];
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
      import { QueryClient, QueryClientProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-query', app))};
      import { Button } from ${JSON.stringify(Bun.resolveSync('@rezics/ui/shadcn/button', app))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync('react-dom', app))};
      import { PostHistory } from ${JSON.stringify(join(app, 'src/threads/post-history.tsx'))};
      import accounts from ${JSON.stringify(join(app, 'src/kernel/recorded/thread-history-accounts.json'))};
      import subject from ${JSON.stringify(join(app, 'src/kernel/recorded/subject.json'))};
      import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
      setLocale('en', { reload: false });
      window.historyCalls = [];
      window.historyRelatedCalls = [];
      window.pendingHistory = [];
      window.historyCsrfToken = null;
      window.historyFetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const history = new RegExp('^/v1/posts/([^/]+)/revisions$').exec(url.pathname);
        if (history) {
          window.historyCalls.push({ postId: history[1], cursor: url.searchParams.get('cursor'),
            limit: url.searchParams.get('limit'), authorization: request.headers.get('authorization') });
          return new Promise((resolve, reject) => window.pendingHistory.push({ resolve, reject }));
        }
        window.historyRelatedCalls.push({ path: url.pathname, authorization: request.headers.get('authorization') });
        if (url.pathname === '/v1/media/presentations') return Response.json({ images: [{
          id: ${JSON.stringify(mediaId)}, containerId: ${JSON.stringify(first.threadId)}, digest: 'a'.repeat(64),
          width: 1, height: 1, variants: [{ format: 'webp', width: 1, height: 1 }],
          placeholder: null, focalPoint: null, credit: null,
        }] });
        if (url.pathname === '/v1/accounts') return Response.json(accounts);
        if (url.pathname.endsWith('/vote')) return Response.json({ units: 9000, revision: 2 });
        if (url.pathname.startsWith('/v1/subjects/')) return Response.json(subject);
        throw new Error('Unexpected native request: ' + url.pathname);
      };
      window.finishHistory = (body, status) => window.pendingHistory.shift().resolve(Response.json(body, { status }));
      window.rejectHistory = () => window.pendingHistory.shift().reject(new Error('History transport unavailable'));
      const authorities = new Map();
      const clients = new Map();
      const clientFor = (name) => {
        if (!clients.has(name)) clients.set(name, new QueryClient());
        return clients.get(name);
      };
      let selectedClient;
      window.setHistorySession = (session, name = selectedClient ?? 'browser') => {
        const client = clientFor(name);
        window.historyViewer = session?.state === 'signed-in' ? session.subject : undefined;
        window.historyCsrfToken = session?.csrfToken ?? null;
        if (session === null) client.removeQueries({ queryKey: ['session'], exact: true });
        else client.setQueryData(['session'], session);
      };
      let retained;
      // Retain the real component's Button callback, rather than a detached DOM click or a replacement loader.
      window.retainHistory = (label) => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent === label);
        let fiber = button[Object.keys(button).find(key => key.startsWith('__reactFiber$'))];
        while (fiber && fiber.type !== Button) fiber = fiber.return;
        if (!fiber?.memoizedProps.onClick) throw new Error('History callback not found');
        retained = fiber.memoizedProps.onClick;
      };
      window.invokeHistory = () => retained();
      let root;
      let hidden = false;
      let lastProps;
      window.mountHistory = (props = lastProps ?? {}) => {
        lastProps = props;
        const { postId = ${JSON.stringify(first.id)}, viewerId, authority = 'one', client } = props;
        selectedClient = client;
        const session = client ? clientFor(client).getQueryData(['session']) : undefined;
        window.historyViewer = client ? (session?.state === 'signed-in' ? session.subject : undefined) : viewerId;
        window.historyCsrfToken = session?.csrfToken ?? null;
        if (!authorities.has(authority)) authorities.set(authority, {});
        root ??= createRoot(document.getElementById('app'));
        const history = <PostHistory postId={postId} viewerId={viewerId} readAuthority={authorities.get(authority)} review />;
        flushSync(() => root.render(<React.StrictMode><React.Activity mode={hidden ? 'hidden' : 'visible'}>{client
          ? <QueryClientProvider client={clientFor(client)}>{history}</QueryClientProvider> : history}</React.Activity></React.StrictMode>));
      };
      window.replayHistoryConnection = () => {
        hidden = true;
        window.mountHistory(lastProps);
        window.invokeHistory();
        hidden = false;
        window.mountHistory(lastProps);
        window.invokeHistory();
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
              contents:
                path === '@tanstack/react-start/server'
                  ? `export * from ${JSON.stringify(join(app, '.storybook/react-start.ts'))};
                   export const getRequest = () => new Request('https://site.test/en/thread', { headers:
                    window.historyViewer ? { cookie: '__Host-rezics_session=${'a'.repeat(43)}' } : {} });
                   export const setResponseHeader = () => {};`
                  : path === 'cloudflare:workers'
                    ? `export const env = { AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test',
                      WEBSITE_SCOPES: 'openid', WEBSITE_CLIENT_ID: 'history-test', WEBSITE_CLIENT_KEY: '{}',
                      SESSIONS: { idFromName: id => id, get: () => ({ credential: async () => ({ status: 'active',
                        subject: window.historyViewer, accessToken: window.historyViewer, csrfToken: window.historyCsrfToken }) }) } };`
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
  await page.route('https://site.test/media/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.route('https://site.test/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/media/')
      ? route.fallback()
      : route.fulfill({
          contentType: 'text/html',
          body: '<main id="app"></main>',
        }),
  );
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
  await page.evaluate(({ body, status }) => (window as unknown as Driver).finishHistory(body, status), {
    body,
    status,
  });
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

test('A transport failure keeps admitted revisions readable through close, reopen and exact continuation retry without duplicates', async () => {
  const page = await mounted();
  try {
    await open(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
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
      await page
        .getByRole('button', { name: m.thread_history_hide() })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    expect(await page.locator('[data-history-focus-boundary]').count()).toBe(0);
    expect(
      await page
        .getByRole('link', { name: m.thread_history_version({ number: '1' }), exact: true })
        .getAttribute('href'),
    ).toContain(`/posts/${first.id}/revisions/${first.revisionId}`);
    expect(await page.getByRole('region', { name: m.thread_history_heading() }).textContent()).toContain(first.licence);
    const readingHierarchy = await page
      .locator('section > ol > li')
      .first()
      .evaluate(
        (entry, labels) => {
          const documentBody = entry.querySelector('[data-slot="document-body"]');
          const provenance = Array.from(entry.querySelectorAll('aside')).find(
            (aside) => aside.getAttribute('aria-label') === labels.provenance,
          );
          const licence = provenance
            ? Array.from(provenance.querySelectorAll('p')).find((paragraph) =>
                paragraph.textContent?.includes(labels.licence),
              )
            : undefined;
          const exactLink = entry.querySelector<HTMLAnchorElement>('h4 a');
          return {
            documentBeforeProvenance: Boolean(
              documentBody &&
              provenance &&
              documentBody.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            licenceVisible: Boolean(licence && licence.getClientRects().length > 0),
            exactLink: exactLink?.getAttribute('href') ?? null,
            exactLinkVisible: Boolean(exactLink && exactLink.getClientRects().length > 0),
          };
        },
        { provenance: m.thread_provenance_heading(), licence: first.licence },
      );
    expect(readingHierarchy).toEqual({
      documentBeforeProvenance: true,
      licenceVisible: true,
      exactLink: `/en/posts/${first.id}/revisions/${first.revisionId}`,
      exactLinkVisible: true,
    });
    const firstEntry = await page.locator('section > ol > li').elementHandle();
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
    await page.getByText(m.thread_history_page_failed(), { exact: true }).waitFor();
    const continuationRetry = page.getByRole('button', { name: m.exact_revision_retry() });
    expect(await continuationRetry.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await firstEntry!.isVisible()).toBe(true);
    await page.getByRole('button', { name: m.thread_history_hide() }).click();
    await page.getByRole('button', { name: m.thread_history_show() }).click();
    expect(await calls(page)).toHaveLength(3);
    await retry.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await pending(page);
    expect(await firstEntry!.isVisible()).toBe(true);
    expect(await page.getByText(m.thread_history_page_failed(), { exact: true }).isVisible()).toBe(true);
    await finish(page, { revisions: [second], next: null });
    await versions(page, 2);
    const boundary = page.locator('h4[data-history-focus-boundary]');
    expect(await boundary.evaluate((heading) => heading === document.activeElement)).toBe(true);
    expect(await boundary.getAttribute('tabindex')).toBe('-1');
    expect(await page.getByText(m.thread_history_complete(), { exact: true }).count()).toBe(1);
    expect(await page.locator('section > ol > li').count()).toBe(2);
    expect(await firstEntry!.isVisible()).toBe(true);
    expect(await page.getByText(m.thread_history_page_failed(), { exact: true }).count()).toBe(0);
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

test('empty continuation pages keep the admitted window, move focus to their boundary and explain the terminal page', async () => {
  const page = await mounted();
  try {
    const nextCursor = 'older/continuation';
    await open(page);
    await finish(page, { revisions: [first], next: cursor });
    await versions(page, 1);
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await finish(page, { revisions: [], next: nextCursor });

    const emptyBoundary = page.locator('h4[data-history-focus-boundary]');
    await emptyBoundary.waitFor();
    expect(await emptyBoundary.evaluate((heading) => heading === document.activeElement)).toBe(true);
    expect(await emptyBoundary.textContent()).toBe(m.thread_history_page_empty());
    expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(1);
    expect(await page.locator('section > ol > li').count()).toBe(1);

    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await finish(page, { revisions: [], next: null });
    const terminalBoundary = page.locator('h4[data-history-focus-boundary]');
    await terminalBoundary.waitFor();
    expect(await terminalBoundary.evaluate((heading) => heading === document.activeElement)).toBe(true);
    expect(await terminalBoundary.textContent()).toBe(m.thread_history_complete());
    expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(0);
    expect(await page.locator('section > ol > li').count()).toBe(1);
    expect((await calls(page)).map(({ cursor }) => cursor)).toEqual([null, cursor, nextCursor]);
  } finally {
    await page.close();
  }
});

test('mounted post, viewer and read-authority changes discard disclosure, comparison, continuation and late results, including unmount', async () => {
  const page = await mounted();
  try {
    const scored = {
      ...first,
      subjectIds: ['subject'],
      voteCitation: { questionId: 'question', units: 6000, revision: 1 },
    };
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

async function session(page: Page, value: Session | null, client = 'browser') {
  await page.evaluate(({ value, client }) => (window as unknown as Driver).setHistorySession(value, client), {
    value,
    client,
  });
}
async function authorHistory(page: Page) {
  await session(page, signedIn);
  await mount(page, { client: 'browser', viewerId: first.authorId });
  await open(page);
  await finish(page, { revisions: [scored], next: cursor });
  await versions(page, 1);
  await page.getByText(m.thread_provenance_current_vote(), { exact: true }).waitFor();
  await page.locator('picture img').waitFor();
  expect(await page.locator('picture img').getAttribute('src')).toBe(`/media/${mediaId}/webp-1`);
  expect(await page.locator('[data-slot="document-body"] a').count()).toBe(1);
  expect(await page.getByRole('link', { name: 'The Little Prince', exact: true }).count()).toBe(1);
}
async function retiredDisclosure(page: Page) {
  expect(await page.locator('[data-slot="document-body"], picture, section > ol, section aside').count()).toBe(0);
  expect(await page.getByText(m.thread_provenance_current_vote(), { exact: true }).count()).toBe(0);
  expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(0);
}

// This is the default component -> original server function -> validator -> generated client/native
// transport composition above, with the real browser QueryClient as the session producer.
test('The default immutable revision history retires original session disclosure and queued reads across actual browser session replacement while current anonymous and signed-in cursor recovery remains usable', async () => {
  const page = await mounted();
  try {
    const replacements: (Session | null)[][] = [
      [{ ...signedIn, csrfToken: 'replacement-csrf' }],
      [{ ...signedIn }], // Same-account replacement, including structural sharing of an identical tuple.
      [{ ...signedIn, subject: 'another-account' }, signedIn],
      [signedOut, signedIn],
      [{ ...signedIn, csrfToken: 'temporary-csrf' }, signedIn],
      [null],
      [{ state: 'unknown', csrfToken: null }],
      [{ state: 'preparing', csrfToken: null }],
      [{ state: 'unavailable', csrfToken: null }],
      [{ ...signedIn, csrfToken: null }],
      [{ ...signedIn, subject: 'another-account' }],
    ];
    for (const replacement of replacements) {
      await authorHistory(page);
      const before = (await calls(page)).length;
      await page.evaluate(
        ({ replacement, label }) => {
          const driver = window as unknown as Driver;
          driver.retainHistory(label);
          // Queue an otherwise valid continuation and replace the session before its microtask sends.
          [...document.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
          for (const value of replacement) driver.setHistorySession(value);
          // A retained old callback also fails before passive cleanup and before React renders the final tuple.
          driver.invokeHistory();
        },
        { replacement, label: m.thread_history_more() },
      );
      await retiredDisclosure(page);
      expect(await calls(page)).toHaveLength(before);
      expect(await page.evaluate(() => (window as unknown as Driver).pendingHistory.length)).toBe(0);
      await page.evaluate(() => (window as unknown as Driver).invokeHistory());
      expect(await calls(page)).toHaveLength(before);
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
    }

    // Current anonymous reads need no CSRF token, and still use the native anonymous floor.
    await session(page, signedOut);
    await mount(page, { client: 'browser' });
    await open(page);
    expect((await calls(page)).at(-1)).toMatchObject({ cursor: null, limit: '20', authorization: null });
    await finish(page, { revisions: [], next: cursor });
    await page.getByRole('button', { name: m.thread_history_more() }).waitFor();
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
    await page.getByText(m.thread_history_page_failed(), { exact: true }).waitFor();
    await page.getByRole('button', { name: m.exact_revision_retry() }).click();
    await pending(page);
    expect((await calls(page)).at(-1)).toMatchObject({ cursor, limit: '20', authorization: null });
    await finish(page, { revisions: [scored], next: null });
    await versions(page, 1);
    expect(await page.getByText(m.thread_provenance_current_vote(), { exact: true }).count()).toBe(0);
    await page.locator('picture img').waitFor();
    expect((await calls(page)).slice(-3).map(({ cursor }) => cursor)).toEqual([null, cursor, cursor]);

    const anonymousCalls = (await calls(page)).length;
    const anonymousControl = page.getByRole('button', { name: m.thread_history_hide() });
    expect(await anonymousControl.getAttribute('aria-expanded')).toBe('true');
    expect(await anonymousControl.getAttribute('aria-controls')).toBe(
      await page.getByRole('region', { name: m.thread_history_heading() }).getAttribute('id'),
    );
    await anonymousControl.click();
    expect(await page.getByRole('button', { name: m.thread_history_show() }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(await page.getByRole('region', { name: m.thread_history_heading() }).count()).toBe(0);
    await page.getByRole('button', { name: m.thread_history_show() }).click();
    expect(await calls(page)).toHaveLength(anonymousCalls);

    // A fresh signed-in lifetime recovers explicitly, preserving exact failed continuation and native20.
    await session(page, { ...signedIn, csrfToken: 'fresh-current-csrf' });
    await mount(page, { client: 'browser', viewerId: first.authorId });
    await retiredDisclosure(page);
    const beforeOpen = (await calls(page)).length;
    await open(page);
    expect(await calls(page)).toHaveLength(beforeOpen + 1); // Strict Mode never duplicates the initial request.
    expect((await calls(page)).at(-1)).toMatchObject({
      cursor: null,
      limit: '20',
      authorization: `Bearer ${first.authorId}`,
    });
    await finish(page, { revisions: [scored], next: cursor });
    await versions(page, 1);
    await page.getByText(m.thread_provenance_current_vote(), { exact: true }).waitFor();
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
    await page.getByText(m.thread_history_page_failed(), { exact: true }).waitFor();
    await page.getByRole('button', { name: m.exact_revision_retry() }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await pending(page);
    expect((await calls(page)).slice(-2).map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor, limit: '20' },
      { cursor, limit: '20' },
    ]);
    await finish(page, { revisions: [second], next: null });
    await versions(page, 2);
    expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

test('default history rejects unknown, preparing and mismatched admission and permits a fresh explicit recovery', async () => {
  const page = await mounted();
  try {
    for (const value of [
      null,
      { state: 'unknown', csrfToken: null },
      { state: 'preparing', csrfToken: null },
      { ...signedIn, subject: 'another-account' },
    ]) {
      await session(page, value);
      await mount(page, { client: 'browser', viewerId: first.authorId });
      const before = (await calls(page)).length;
      const related = await page.evaluate(() => (window as unknown as Driver).historyRelatedCalls.length);
      await page.getByRole('button', { name: m.thread_history_show() }).click();
      await unavailable(page);
      await page.getByRole('button', { name: m.exact_revision_retry() }).click();
      await unavailable(page);
      expect(await calls(page)).toHaveLength(before);
      expect(await page.evaluate(() => (window as unknown as Driver).historyRelatedCalls.length)).toBe(related);
      await retiredDisclosure(page);
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
    }
    await session(page, signedIn);
    await mount(page, { client: 'browser', viewerId: first.authorId });
    await open(page);
    await finish(page, { code: 'forbidden' }, 403);
    await unavailable(page);
    await retiredDisclosure(page);
    await page.getByRole('button', { name: m.exact_revision_retry() }).click();
    await pending(page);
    expect((await calls(page)).at(-1)).toMatchObject({
      cursor: null,
      limit: '20',
      authorization: `Bearer ${first.authorId}`,
    });
    await finish(page, { revisions: [scored], next: null });
    await versions(page, 1);
    await page.getByText(m.thread_provenance_current_vote(), { exact: true }).waitFor();
  } finally {
    await page.close();
  }
}, 30_000);

test('healthy authenticated history without CSRF clears private history on native denial and recovers from the first page', async () => {
  const page = await mounted();
  try {
    await session(page, { ...signedIn, csrfToken: null });
    await mount(page, { client: 'browser', viewerId: first.authorId });
    await open(page);
    expect((await calls(page)).at(-1)).toMatchObject({
      postId: first.id,
      cursor: null,
      limit: '20',
      authorization: `Bearer ${first.authorId}`,
    });
    await finish(page, { revisions: [scored], next: cursor });
    await versions(page, 1);
    await page.getByText(m.thread_provenance_current_vote(), { exact: true }).waitFor();
    expect(
      await page.evaluate(
        (reader) =>
          (window as unknown as Driver).historyRelatedCalls.some(
            ({ path, authorization }) => path.endsWith('/vote') && authorization === `Bearer ${reader}`,
          ),
        first.authorId,
      ),
    ).toBe(true);
    expect(await page.locator('section > ol a').first().getAttribute('href')).toContain(first.revisionId);

    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    expect((await calls(page)).at(-1)).toMatchObject({
      postId: first.id,
      cursor,
      limit: '20',
      authorization: `Bearer ${first.authorId}`,
    });
    await finish(page, { code: 'forbidden' }, 403);
    await unavailable(page);
    await retiredDisclosure(page);

    await page.getByRole('button', { name: m.exact_revision_retry() }).click();
    await pending(page);
    expect((await calls(page)).at(-1)).toMatchObject({
      postId: first.id,
      cursor: null,
      limit: '20',
      authorization: `Bearer ${first.authorId}`,
    });
    await finish(page, { revisions: [second], next: null });
    await versions(page, 1);
    const links = await page
      .locator('section > ol h4 a')
      .evaluateAll((entries) => entries.map((entry) => entry.getAttribute('href')));
    expect(links).toEqual([`/en/posts/${second.id}/revisions/${second.revisionId}`]);
    expect(await page.getByRole('button', { name: m.thread_history_more() }).count()).toBe(0);
    expect((await calls(page)).slice(-3).map(({ cursor: value, limit }) => ({ cursor: value, limit }))).toEqual([
      { cursor: null, limit: '20' },
      { cursor, limit: '20' },
      { cursor: null, limit: '20' },
    ]);
    expect(
      await page.evaluate(() => (window as unknown as { historyCsrfToken: string | null }).historyCsrfToken),
    ).toBeNull();
  } finally {
    await page.close();
  }
});

test('a transport failure with a changed actual reader clears private history instead of retaining it', async () => {
  const page = await mounted();
  try {
    await authorHistory(page);
    await page.evaluate(() => {
      (window as unknown as { historyViewer?: string }).historyViewer = undefined;
    });
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    await page.evaluate(() => (window as unknown as Driver).rejectHistory());
    await unavailable(page);
    await retiredDisclosure(page);
  } finally {
    await page.close();
  }
});

test('queued and retained history callbacks cannot send across post, viewer, readAuthority, QueryClient replacement or unmount', async () => {
  const page = await mounted();
  try {
    for (const change of ['post', 'viewer', 'authority', 'source', 'unmount']) {
      await authorHistory(page);
      await session(page, signedIn, 'successor');
      const before = (await calls(page)).length;
      await page.evaluate(
        ({ change, label, postId, viewerId }) => {
          const driver = window as unknown as Driver;
          driver.retainHistory(label);
          [...document.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
          if (change === 'unmount') driver.unmountHistory();
          else
            driver.mountHistory({
              client: change === 'source' ? 'successor' : 'browser',
              viewerId: change === 'viewer' ? 'another-viewer' : viewerId,
              ...(change === 'post' ? { postId } : {}),
              ...(change === 'authority' ? { authority: 'two' } : {}),
            });
          driver.invokeHistory();
        },
        { change, label: m.thread_history_more(), postId: second.revisionId, viewerId: first.authorId },
      );
      await retiredDisclosure(page);
      expect(await calls(page)).toHaveLength(before);
      expect(await page.evaluate(() => (window as unknown as Driver).pendingHistory.length)).toBe(0);
      if (change !== 'unmount') await page.evaluate(() => (window as unknown as Driver).unmountHistory());
      // Returning the original caller tuple creates an empty current visit, never a revived continuation.
      await mount(page, { client: 'browser', viewerId: first.authorId });
      await retiredDisclosure(page);
      await page.evaluate(() => (window as unknown as Driver).invokeHistory());
      expect(await calls(page)).toHaveLength(before);
      await open(page);
      expect((await calls(page)).at(-1)?.cursor).toBeNull();
      await finish(page, { revisions: [first], next: null });
      await versions(page, 1);
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
    }
  } finally {
    await page.close();
  }
}, 30_000);

test('obsolete success, unavailable, rejection and finally cannot revive data or release the current history request', async () => {
  const page = await mounted();
  try {
    for (const settlement of ['success', 'unavailable', 'reject']) {
      await authorHistory(page);
      await page.getByRole('button', { name: m.thread_history_more() }).click();
      await pending(page);
      await page.evaluate(() => (window as unknown as Driver).rejectHistory());
      await page.getByText(m.thread_history_page_failed(), { exact: true }).waitFor();
      await versions(page, 1);
      await page.getByRole('button', { name: m.exact_revision_retry() }).click();
      await pending(page);
      await session(page, { ...signedIn, csrfToken: 'successor-csrf' });
      await retiredDisclosure(page);
      await open(page, 2);
      if (settlement === 'reject') await page.evaluate(() => (window as unknown as Driver).rejectHistory());
      else
        await finish(
          page,
          settlement === 'success' ? { revisions: [scored], next: cursor } : { code: 'forbidden' },
          settlement === 'success' ? 200 : 403,
        );
      await pending(page);
      if (settlement === 'success') {
        expect(await page.locator('[data-history-focus-boundary]').count()).toBe(0);
        expect(await page.getByText(m.thread_history_page_loaded(), { exact: true }).count()).toBe(0);
      }
      const count = (await calls(page)).length;
      expect(await page.locator('section > ol').count()).toBe(0);
      expect(await page.getByText(m.thread_history_unavailable(), { exact: true }).count()).toBe(0);
      expect(await page.getByText(m.thread_history_loading(), { exact: true }).isVisible()).toBe(true);
      // Closing/reopening while the successor owns the pending guard cannot send a duplicate.
      await page.getByRole('button', { name: m.thread_history_hide() }).click();
      await page.getByRole('button', { name: m.thread_history_show() }).click();
      expect(await calls(page)).toHaveLength(count);
      await finish(page, { code: 'dependency_unavailable' }, 503);
      await unavailable(page);
      await page.getByRole('button', { name: m.exact_revision_retry() }).evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await pending(page);
      expect(await calls(page)).toHaveLength(count + 1);
      expect((await calls(page)).at(-1)?.cursor).toBeNull();
      await finish(page, { revisions: [second], next: null });
      await versions(page, 1);
      expect(await page.locator('h4 a').getAttribute('href')).toContain(second.revisionId);
      await page.evaluate(() => (window as unknown as Driver).unmountHistory());
    }
  } finally {
    await page.close();
  }
}, 30_000);

test('Strict Mode same-visit reconnect clears disclosure and fences a former connection request and callback', async () => {
  const page = await mounted();
  try {
    await authorHistory(page);
    await page.evaluate((label) => (window as unknown as Driver).retainHistory(label), m.thread_history_more());
    await page.getByRole('button', { name: m.thread_history_more() }).click();
    await pending(page);
    const count = (await calls(page)).length;
    // Activity performs real layout disconnect/reconnect in one turn, the same ownership replay as Strict Mode.
    await page.evaluate(() => (window as unknown as Driver).replayHistoryConnection());
    await retiredDisclosure(page);
    await unavailable(page);
    expect(await calls(page)).toHaveLength(count);
    await page.getByRole('button', { name: m.exact_revision_retry() }).click();
    await pending(page, 2);
    await finish(page, { revisions: [scored], next: cursor });
    await pending(page);
    expect(await page.locator('section > ol').count()).toBe(0);
    expect(await page.getByRole('button', { name: m.exact_revision_retry() }).isDisabled()).toBe(true);
    await page.evaluate(() => (window as unknown as Driver).invokeHistory());
    expect(await calls(page)).toHaveLength(count + 1);
    await finish(page, { revisions: [first], next: null });
    await versions(page, 1);
    expect((await calls(page)).at(-1)?.cursor).toBeNull();
  } finally {
    await page.close();
  }
}, 30_000);
