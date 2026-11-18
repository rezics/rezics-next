import { describe } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkDocument,
  documentText,
  documentVersion,
  fromPlainText,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { BrowserContext, Page } from 'playwright';
import { expect } from 'playwright/test';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import {
  createNativeDocumentAuthoringFixture,
  seedDocumentHistory,
  type NativeDocumentAuthoringFixture,
} from './native-document-authoring-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

const timeout = 600_000;

type Post = {
  id: string;
  authorId: string;
  licence: string;
  revisionId: string;
  body: DocumentSnapshot | null;
  createdAt: string;
};

function collectNodes(snapshot: DocumentSnapshot): DocumentNode[] {
  const nodes: DocumentNode[] = [];
  const visit = (node: DocumentNode) => {
    nodes.push(node);
    node.content?.forEach(visit);
  };
  visit(snapshot.doc);
  return nodes;
}

function ids(snapshot: DocumentSnapshot): string[] {
  return collectNodes(snapshot).flatMap((node) => (typeof node.attrs?.id === 'string' ? [node.attrs.id] : []));
}

function topLevelIds(snapshot: DocumentSnapshot): string[] {
  return (snapshot.doc.content ?? []).flatMap((node) => (typeof node.attrs?.id === 'string' ? [node.attrs.id] : []));
}

async function json<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function pasteHtml(page: Page, editor: ReturnType<Page['locator']>, html: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(async (value) => {
    const item = new ClipboardItem({
      'text/html': new Blob([value], { type: 'text/html' }),
    });
    await navigator.clipboard.write([item]);
  }, html);
  await editor.click();
  await editor.press('Control+V');
}

async function expectKeyboardToolbar(page: Page): Promise<void> {
  const toolbar = page.getByRole('toolbar', { name: 'Formatting toolbar' });
  await expect(toolbar).toBeVisible();
  const bold = toolbar.getByRole('button', { name: 'Bold', exact: true });
  await bold.focus();
  await page.keyboard.press('ArrowRight');
  const focused = toolbar.locator('button:focus');
  await expect(focused).toBeVisible();
  expect(await focused.getAttribute('aria-label')).not.toBe('Bold');
}

async function expectKeyboardReachable(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
  await page.locator('#account-menu-button').focus();
  for (let index = 0; index < 80; index++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Keyboard tab order did not reach the document link');
}

async function createGrowthThreads(fixture: NativeDocumentAuthoringFixture, from: number, to: number): Promise<void> {
  await Promise.all(fixture.growthWriters.map(({ persona }) => fixture.stack.authPersona(persona, 'renew')));
  for (let index = from; index < to; index++) {
    const writer = fixture.growthWriters[index % fixture.growthWriters.length]!;
    await json<{ thread: { id: string } }>(
      await fixture.stack.kernel(
        '/v1/threads',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify({
            title: `Unrelated growth fixture ${index + 1}`,
            body: fromPlainText(`Unrelated growth fixture ${index + 1}`, 'blocks'),
            licence: 'MIT',
            subjectIds: [],
            boardId: fixture.boardId,
            visibility: 'published',
          }),
        },
        writer.persona,
      ),
      `POST /v1/threads growth fixture ${index + 1}`,
    );
  }
}

async function revealHistoryControl(post: ReturnType<Page['locator']>) {
  const details = post.locator('[data-slot="post-reading-inspection"] > details');
  const summary = details.locator(':scope > summary').filter({ hasText: /^Post details$/ });
  await expect(summary).toBeVisible();
  if ((await details.getAttribute('open')) === null) await summary.click();
  return post.getByRole('button', { name: 'Revision history', exact: true, expanded: false });
}

function isMountedRevisionRead(request: NativeKernelRequest, postId: string): boolean {
  return (
    !request.fixtureRequest &&
    request.method === 'GET' &&
    request.url.split('?', 1)[0] === `/v1/posts/${postId}/revisions`
  );
}

function serverFunctionPayload(fixture: NativeDocumentAuthoringFixture, href: string) {
  const url = new URL(href);
  if (url.origin !== new URL(fixture.stack.web).origin || !url.pathname.startsWith('/_serverFn/')) return null;
  return url.searchParams.get('payload');
}

function isHistoryFunctionRead(fixture: NativeDocumentAuthoringFixture, href: string, postId: string): boolean {
  const payload = serverFunctionPayload(fixture, href);
  return payload?.includes('"post-history"') === true && payload.includes(`"${postId}"`);
}

async function observeMountedHistory(
  fixture: NativeDocumentAuthoringFixture,
  page: Page,
  postId: string,
  controlId: string | null,
  nativeFrom: number,
) {
  const [mounted, native] = await Promise.all([
    settledWithin(
      page.evaluate(
        ({ postId, controlId }) => {
          const post = document.getElementById(`post-${postId}`);
          const control = post?.querySelector('button[aria-controls^="post-history-"]');
          const currentId = control?.getAttribute('aria-controls');
          const region = currentId ? document.getElementById(currentId) : null;
          return {
            hydrated: document.documentElement.hasAttribute('data-hydrated'),
            postFound: !!post,
            detailsOpen: control?.closest('details')?.open ?? null,
            sameControl: currentId ? currentId === controlId : null,
            expanded: control?.getAttribute('aria-expanded') ?? null,
            region: region && {
              hidden: region.hasAttribute('hidden'),
              role: region.getAttribute('role'),
              named: region.getAttribute('aria-label') === 'Revision history',
              status: Array.from(region.querySelectorAll(':scope > p[role="status"], :scope > p[role="alert"]'))
                .slice(0, 4)
                .map((status) => status.textContent?.trim().slice(0, 160)),
              summaries: region.querySelectorAll('[data-history-summary]').length,
              lists: Array.from(region.querySelectorAll('ol, ul, [role="list"]'))
                .slice(0, 4)
                .map((list) => ({
                  tag: list.localName,
                  role: list.getAttribute('role'),
                  named: list.getAttribute('aria-label') === 'Revision history',
                  directItems: list.querySelectorAll(':scope > li').length,
                })),
            },
          };
        },
        { postId, controlId },
      ),
      1_500,
    ).catch(() => undefined),
    // Sample pending as well as completed worker requests without draining the Kernel.
    settledWithin(fixture.stack.sampleKernelRequests(), 1_500).catch(() => undefined),
  ]);
  const reads = native?.slice(nativeFrom).filter((request) => isMountedRevisionRead(request, postId));
  return {
    mounted: mounted ?? null,
    kernel: reads
      ? {
          count: reads.length,
          samples: reads.slice(0, 4).map(({ authorization, session, responseStatus, access }) => ({
            status: responseStatus ?? null,
            credentialPresent: Boolean(authorization || session),
            isAlice: access ? access.actorId === fixture.alice.accountId : null,
            authorized: access?.authorized ?? null,
          })),
        }
      : null,
  };
}

async function measureHistoryReads(
  fixture: NativeDocumentAuthoringFixture,
  threadId: string,
  context: BrowserContext,
  postId: string,
): Promise<number> {
  const historyPage = await context.newPage();
  const functionResponses: number[] = [];
  let functionFailures = 0;
  historyPage.on('response', (response) => {
    if (isHistoryFunctionRead(fixture, response.url(), postId)) functionResponses.push(response.status());
  });
  historyPage.on('requestfailed', (request) => {
    if (isHistoryFunctionRead(fixture, request.url(), postId)) functionFailures++;
  });
  try {
    historyPage.setDefaultTimeout(30_000);
    // The account's thread mount makes its own Kernel reads. Finish that exact visit before measuring a click.
    const [personal] = await Promise.all([
      historyPage.waitForResponse((response) => {
        const payload = serverFunctionPayload(fixture, response.url());
        return payload?.includes('"readReactions"') === true && payload.includes(JSON.stringify(threadId));
      }),
      historyPage.goto(`${fixture.stack.web}/en/threads/${threadId}`, { waitUntil: 'domcontentloaded' }),
    ]);
    expect(personal.status()).toBe(200);
    await personal.finished();
    await historyPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const post = historyPage.locator(`#post-${postId}`);
    const button = await revealHistoryControl(post);
    await expect(button).toBeVisible();
    // Shell reads may still be running after the thread's personal response. Start the cost window at idle.
    await historyPage.waitForLoadState('networkidle');
    const controlId = await button.getAttribute('aria-controls');
    // Browser traffic only appears in the test process after sampling the stack host.
    const before = (await fixture.stack.sampleKernelRequests()).length;
    await button.click();
    const panel = post.getByRole('region', { name: 'Revision history', exact: true });
    try {
      await expect(panel.getByRole('link', { name: 'Version 2', exact: true })).toBeVisible();
      expect(await panel.getAttribute('id')).toBe(controlId);
    } catch (error) {
      const observation = await observeMountedHistory(fixture, historyPage, postId, controlId, before);
      console.info(
        `native-document-authoring-growth-history ${JSON.stringify({ functionResponses, functionFailures, ...observation })}`,
      );
      throw error;
    }
    const requests = (await fixture.stack.sampleKernelRequests()).slice(before);
    const revisionReads = requests.filter((request) => isMountedRevisionRead(request, postId));
    expect(revisionReads.map(({ responseStatus }) => responseStatus)).toEqual([200]);
    expect(revisionReads[0]?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(requests.map((request) => request.url.split('?', 1)[0])).toEqual([`/v1/posts/${postId}/revisions`]);
    return requests.length;
  } finally {
    await historyPage.close();
  }
}

describe('native document authoring', () => {
  const lifecycle = new NativeTestLifecycle('native document authoring');
  let fixture: NativeDocumentAuthoringFixture;

  nativeBeforeAll(lifecycle, timeout, async () => {
    fixture = await createNativeDocumentAuthoringFixture();
  });
  nativeAfterAll(lifecycle, timeout);

  nativeTest(
    'the served composer preserves authored documents, revisions, and access through native reads',
    timeout,
    preserveAuthoredDocuments,
    lifecycle,
  );

  async function preserveAuthoredDocuments() {
    const aliceJourney = await fixture.auth.signIn('alice');
    const page = aliceJourney.continueOnPage();
    page.setDefaultTimeout(30_000);
    const network: { url: string; status: number }[] = [];
    const requestFailures: { url: string; failure: string | null }[] = [];
    const pageErrors: string[] = [];
    page.on('response', (response) => network.push({ url: response.url(), status: response.status() }));
    page.on('requestfailed', (request) =>
      requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }),
    );
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${fixture.stack.web}/en/boards/${fixture.boardId}/new`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await page.getByLabel('Title', { exact: true }).fill('Unicode document round trip');
    const editor = page.locator('.ProseMirror').first();
    await editor.waitFor({ state: 'visible' });

    const inaccessibleAccountId = crypto.randomUUID();
    const paste = [
      '<p>Unicode 雪 café authored whitespace  <strong>bold</strong> and <em>emphasis</em> with ',
      '<a href="https://example.test/contract">a safe link</a>.</p>',
      '<blockquote><p>A quotation stays a quotation.</p></blockquote>',
      '<ul><li><p>A supported list item.</p></li></ul>',
      '<pre><code>const  preserved  = true;</code></pre>',
      `<p><span data-mention-account-id="${inaccessibleAccountId}">Private account title sentinel</span></p>`,
      '<p><a href="javascript:window.__hostileLinkRan=true">hostile link</a></p>',
      '<p><x-unsupported-node>Unsupported node content retained.</x-unsupported-node></p>',
      '<script>window.__hostileScriptRan=true</script><iframe src="https://attacker.invalid"></iframe>',
    ].join('');
    await pasteHtml(page, editor, paste);
    await expect(editor).not.toContainText('Private account title sentinel');
    await editor.press('End');
    await page.keyboard.type(` @${fixture.bobHandle}`);
    const suggestion = page.getByRole('option', {
      name: new RegExp(`@${fixture.bobHandle}`, 'i'),
    });
    await suggestion.waitFor({ state: 'visible' });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.keyboard.type(' @hidden-native-account-title');
    await page.waitForTimeout(350);
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expectKeyboardToolbar(page);
    await mkdir(join(import.meta.dir, '../../../.temp/native-document-authoring'), { recursive: true });
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/composer-phone-light.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await expectKeyboardToolbar(page);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/composer-desktop-light.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectKeyboardToolbar(page);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/composer-phone-dark.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectKeyboardToolbar(page);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/composer-desktop-dark.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });

    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();
    const nativeRequestStart = fixture.stack.kernelRequests().length;
    await send.click();
    try {
      await page.waitForURL(/\/en\/threads\//, { waitUntil: 'domcontentloaded' });
    } catch {
      const alerts = await page.locator('[role="alert"]').allTextContents();
      await json<{ accounts: unknown[] }>(
        await fixture.stack.kernel(
          `/v1/accounts?ids=${encodeURIComponent(fixture.alice.accountId)}`,
          undefined,
          'editor',
        ),
        'GET /v1/accounts after failed composer submission',
      );
      const nativeFailures = fixture.stack
        .kernelRequests()
        .slice(nativeRequestStart)
        .filter((request) => request.failure)
        .map(({ method, url, failure }) => ({ method, url, failure }));
      const editorDoc = await page.locator('.ProseMirror').evaluate((element) => {
        const description = (element as HTMLElement & { pmViewDesc?: { node?: { toJSON?: () => unknown } } })
          .pmViewDesc;
        return description?.node?.toJSON?.() ?? null;
      });
      let snapshotFailure = '';
      if (editorDoc && typeof editorDoc === 'object') {
        try {
          normalizeDocument({
            version: documentVersion,
            profile: 'blocks',
            doc: withDocumentIds(editorDoc as DocumentNode),
          });
        } catch (error) {
          snapshotFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
      }
      throw new Error(
        `Composer did not navigate to the created thread: url=${page.url()} alerts=${JSON.stringify(alerts)} nativeFailures=${JSON.stringify(nativeFailures)} editorDoc=${JSON.stringify(editorDoc)} snapshotFailure=${snapshotFailure} responses=${JSON.stringify(network.slice(-12))} requestFailures=${JSON.stringify(requestFailures.slice(-12))} pageErrors=${JSON.stringify(pageErrors)}`,
      );
    }
    const threadId = new URL(page.url()).pathname.split('/')[3]!;
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i);

    const threadRead = await json<{ thread: { firstPost: Post } }>(
      await fixture.stack.kernel(`/v1/threads/${threadId}`, undefined, 'alice'),
      'GET /v1/threads/:id',
    );
    const postsRead = await json<{ posts: Post[] }>(
      await fixture.stack.kernel(`/v1/threads/${threadId}/posts?limit=20`, undefined, 'alice'),
      'GET /v1/threads/:id/posts',
    );
    const original = postsRead.posts[0]!;
    expect(original.id).toBe(threadRead.thread.firstPost.id);
    expect(original.authorId).toBe(fixture.alice.accountId);
    expect(original.licence).toBe('LicenseRef-rezics-terms');
    expect(original.body).not.toBeNull();
    const initial = original.body!;
    expect(checkDocument(initial)).toBe(true);
    expect(initial.profile).toBe('blocks');
    const initialNodes = collectNodes(initial);
    const initialText = documentText(initial);
    expect(initialText).toContain('Unicode 雪 café authored whitespace');
    expect(initialText).toContain('authored whitespace  bold');
    expect(initialText).toContain('A quotation stays a quotation.');
    expect(initialText).toContain('A supported list item.');
    expect(initialText).toContain('const  preserved  = true;');
    expect(initialText).toContain('Unsupported node content retained.');
    expect(initialText).toContain('@');
    expect(initialText).not.toContain('Private account title sentinel');
    expect(initialText).toContain('hostile link');
    expect(JSON.stringify(initial)).not.toContain('javascript:');
    expect(JSON.stringify(initial)).not.toContain('__hostileScriptRan');
    expect(initialNodes.map((node) => node.type)).toContain('blockquote');
    expect(initialNodes.map((node) => node.type)).toContain('bulletList');
    expect(initialNodes.map((node) => node.type)).toContain('codeBlock');
    expect(
      initialNodes.some((node) => node.type === 'mention' && node.attrs?.accountId === fixture.bob.accountId),
    ).toBe(true);
    expect(
      initialNodes.some((node) => node.type === 'mention' && node.attrs?.accountId === inaccessibleAccountId),
    ).toBe(true);
    expect(
      initialNodes.some((node) =>
        node.marks?.some((mark) => mark.type === 'link' && mark.attrs?.href?.startsWith('javascript:')),
      ),
    ).toBe(false);
    expect(initialNodes.some((node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'bold'))).toBe(
      true,
    );
    expect(
      initialNodes.some((node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'italic')),
    ).toBe(true);
    expect(
      initialNodes.some((node) =>
        node.marks?.some((mark) => mark.type === 'link' && mark.attrs?.href === 'https://example.test/contract'),
      ),
    ).toBe(true);
    const originalParagraph = initial.doc.content?.find(
      (node) =>
        node.type === 'paragraph' &&
        documentText({
          ...initial,
          doc: { type: 'doc', content: [node] },
        }).includes('Unicode 雪'),
    );
    const retainedId = originalParagraph?.attrs?.id;
    expect(retainedId).toBeTruthy();
    expect(new Set(ids(initial)).size).toBe(ids(initial).length);
    const unsupported = structuredClone(initial) as DocumentSnapshot;
    (unsupported.doc.content![0] as DocumentNode).type = 'unsupportedExecutableNode';
    expect(checkDocument(unsupported)).toBe(false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const prose = page.locator('[data-slot="document-body"]').first();
    await expect(prose).toContainText(`@${fixture.bobHandle}`);
    await expect(prose.locator('strong')).toContainText('bold');
    await expect(prose.locator('a[href="https://example.test/contract"]')).toContainText('a safe link');
    await expect(prose.locator('blockquote')).toContainText('A quotation stays a quotation.');
    await expect(prose.locator('ul > li')).toContainText('A supported list item.');
    await expect(prose.locator('pre code')).toContainText('const  preserved  = true;');
    await expect(prose).toContainText('Unsupported node content retained.');
    await expect(prose.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(prose.getByRole('link', { name: 'hostile link' })).toHaveCount(0);
    expect(
      await page.evaluate(() => Boolean((window as Window & { __hostileScriptRan?: boolean }).__hostileScriptRan)),
    ).toBe(false);
    await expect(prose).not.toContainText('Private account title sentinel');
    const safeLink = prose.getByRole('link', { name: 'a safe link' });
    await expectKeyboardReachable(page, safeLink);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectKeyboardReachable(page, safeLink);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/thread-phone-dark.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await expectKeyboardReachable(page, safeLink);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/thread-desktop-light.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectKeyboardReachable(page, safeLink);
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/thread-desktop-dark.png'),
      fullPage: true,
    });

    await page
      .getByRole('button', { name: 'More actions', exact: true })
      .and(page.locator('[aria-haspopup="menu"]'))
      .click();
    // The shared Menu contract uses a menu item on desktop and a button in its touch sheet.
    const editAction = page
      .getByRole('menuitem', { name: 'Edit', exact: true })
      .or(page.getByRole('button', { name: 'Edit', exact: true }));
    await editAction.click();
    const editSurface = page.locator('.ProseMirror').first();
    await editSurface.waitFor({ state: 'visible' });
    const movableUnit = editSurface.locator(`[data-id="${retainedId}"]`);
    await expect(movableUnit).toHaveCount(1);
    await expect(movableUnit).toHaveAttribute('draggable', 'true');
    const orderBeforeMove = await editSurface
      .locator(':scope > [data-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')));
    const retainedPositionBeforeMove = orderBeforeMove.indexOf(retainedId);
    expect(retainedPositionBeforeMove).toBeGreaterThanOrEqual(0);
    const finalBlock = editSurface.locator(':scope > [data-id]').last();
    expect(await finalBlock.getAttribute('data-id')).not.toBe(retainedId);
    const finalBlockBox = await finalBlock.boundingBox();
    expect(finalBlockBox).not.toBeNull();
    // Drop at the measured top edge of the last block, the actual parent
    // boundary before that unit in the current editor document.
    await movableUnit.dragTo(finalBlock, {
      sourcePosition: { x: 2, y: 1 },
      targetPosition: { x: Math.max(1, finalBlockBox!.width / 2), y: 0 },
    });
    const orderAfterMove = await editSurface
      .locator(':scope > [data-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')));
    const movedBlockIds = await editSurface
      .locator('[data-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')));
    expect(orderAfterMove).not.toEqual(orderBeforeMove);
    expect(orderAfterMove.indexOf(retainedId)).not.toBe(retainedPositionBeforeMove);
    expect(
      movedBlockIds.filter((id) => id === retainedId),
      JSON.stringify({ orderBeforeMove, orderAfterMove, movedBlockIds }),
    ).toHaveLength(1);
    await editSurface.click();
    await editSurface.press('Control+End');
    await pasteHtml(page, editSurface, `<p data-id="${retainedId}">Copied unit content</p>`);
    await editSurface.press('End');
    await page.keyboard.press('Home');
    for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.type(' edited in the served editor');
    const editedPost = page.locator(`#post-${original.id}`);
    const saveChanges = editedPost.getByRole('button', { name: 'Save changes', exact: true });
    await saveChanges.click();
    // The pending editor also renders the submitted document in its recovery panel.
    // Wait for the acknowledged edit to replace the editor before reading durable history.
    await saveChanges.waitFor({ state: 'detached' });
    await expect(editedPost.locator('[data-slot="document-body"]')).toContainText('edited in the served editor');

    const postPath = `/v1/posts/${original.id}`;
    const historyResponse = await fixture.stack.kernel(`${postPath}/revisions?limit=20`, undefined, 'alice');
    if (!historyResponse.ok) {
      const problem = await historyResponse.text();
      const reads: Record<string, number | string> = {};
      // Observe the same author's native reads after the failed request, including both exact revisions
      // when the current Post discloses its saved head. Keep the original history failure as the result.
      const observe = async (path: string) => {
        try {
          const response = await fixture.stack.kernel(path, undefined, 'alice');
          reads[path] = response.status;
          await response.body?.cancel();
          return response;
        } catch (error) {
          reads[path] = String(error);
          return null;
        }
      };
      const head = await observe(postPath);
      const revisionId = head?.ok ? head.headers.get('etag')?.match(/^"([0-9a-f-]{36})"$/i)?.[1] : undefined;
      await observe(`${postPath}/revisions/${original.revisionId}`);
      if (revisionId && revisionId !== original.revisionId) await observe(`${postPath}/revisions/${revisionId}`);
      await observe(`${postPath}/revision-headers?limit=20`);
      await observe(`/v1/threads/${threadId}`);
      await observe(`/v1/boards/${fixture.boardId}`);
      await observe(`/v1/realms/${fixture.realmId}`);
      await observe(`/v1/spaces/${fixture.spaceId}`);
      throw new Error(
        `GET ${postPath}/revisions?limit=20 returned ${historyResponse.status}: ${problem}\nSubsequent Alice reads: ${JSON.stringify(reads)}`,
      );
    }
    const revisionsRead = await json<{ revisions: Post[] }>(historyResponse, 'GET /v1/posts/:id/revisions');
    expect(revisionsRead.revisions).toHaveLength(2);
    const [oldRevision, newRevision] = revisionsRead.revisions;
    const { post: head } = await json<{ post: Post }>(
      await fixture.stack.kernel(postPath, undefined, 'alice'),
      'GET /v1/posts/:id',
    );
    expect(oldRevision!.id).toBe(original.id);
    expect(oldRevision!.revisionId).toBe(original.revisionId);
    expect(newRevision!.id).toBe(original.id);
    expect(newRevision!.revisionId).not.toBe(original.revisionId);
    expect(newRevision!.revisionId).toBe(head.revisionId);
    expect(newRevision!.body).toEqual(head.body);
    expect(oldRevision!.body).toEqual(initial);
    expect(documentText(oldRevision!.body!)).toContain('Unicode 雪 café authored whitespace  bold');
    expect(documentText(oldRevision!.body!)).not.toContain('edited in the served editor');
    expect(oldRevision!.authorId).toBe(fixture.alice.accountId);
    expect(newRevision!.authorId).toBe(fixture.alice.accountId);
    expect(oldRevision!.licence).toBe('LicenseRef-rezics-terms');
    expect(newRevision!.licence).toBe(oldRevision!.licence);
    expect(new Date(oldRevision!.createdAt).getTime()).toBeLessThanOrEqual(new Date(newRevision!.createdAt).getTime());
    expect(newRevision!.body).not.toBeNull();
    expect(checkDocument(newRevision!.body)).toBe(true);
    expect(ids(newRevision!.body!)).toContain(retainedId);
    expect(new Set(ids(newRevision!.body!)).size).toBe(ids(newRevision!.body!).length);
    expect(ids(newRevision!.body!).filter((id) => id === retainedId)).toHaveLength(1);
    const originalOrder = topLevelIds(initial);
    const storedOrder = topLevelIds(newRevision!.body!);
    expect(storedOrder.filter((id) => originalOrder.includes(id))).not.toEqual(originalOrder);
    expect(storedOrder.indexOf(retainedId)).not.toBe(originalOrder.indexOf(retainedId));
    expect(ids(newRevision!.body!).length).toBeGreaterThan(ids(initial).length);
    expect(documentText(newRevision!.body!)).toContain('edited in the served editor');

    const historyNativeFrom = fixture.stack.kernelRequests().length;
    const reloadedThread = await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const revisedProse = page.locator('[data-slot="document-body"]').first();
    const visibleBlocks = await revisedProse.locator(':scope > *').allTextContents();
    expect(visibleBlocks[0]).not.toContain('Unicode 雪');
    expect(visibleBlocks.findIndex((text) => text.includes('Unicode 雪'))).toBeGreaterThan(0);
    await expect(revisedProse.locator('blockquote')).toContainText('A quotation stays a quotation.');
    await expect(revisedProse.locator('ul > li')).toContainText('A supported list item.');
    await expect(revisedProse.locator('pre code')).toContainText('const  preserved  = true;');
    await expect(revisedProse).not.toContainText('Private account title sentinel');

    const history = await revealHistoryControl(editedPost);
    const historyControlId = await history.getAttribute('aria-controls');
    await history.click();
    const historyPanel = editedPost.getByRole('region', { name: 'Revision history', exact: true });
    const historyVersions = historyPanel
      .getByRole('list', { name: 'Revision history', exact: true })
      .locator(':scope > li');
    try {
      await expect(historyVersions).toHaveCount(2);
    } catch (error) {
      const observation = await observeMountedHistory(fixture, page, original.id, historyControlId, historyNativeFrom);
      const functionResponses = network
        .filter(({ url }) => isHistoryFunctionRead(fixture, url, original.id))
        .slice(0, 4)
        .map(({ status }) => status);
      const functionFailures = requestFailures.filter(({ url }) =>
        isHistoryFunctionRead(fixture, url, original.id),
      ).length;
      const evidence = {
        documentStatus: reloadedThread?.status() ?? null,
        sameThreadPath: reloadedThread ? new URL(reloadedThread.url()).pathname === new URL(page.url()).pathname : null,
        functionResponses,
        functionFailures,
        ...observation,
      };
      console.info(`native-document-authoring-history ${JSON.stringify(evidence)}`);
      throw error;
    }
    for (const [index, revision] of revisionsRead.revisions.entries()) {
      const row = historyVersions.nth(index);
      const version = index + 1;
      const versionLink = row.getByRole('link', { name: `Version ${version}`, exact: true });
      await expect(versionLink).toBeVisible();
      await expect(versionLink).toHaveAttribute('href', `/en/posts/${original.id}/revisions/${revision.revisionId}`);
      await expect(row.getByRole('link').and(row.locator(`a[href="/en/@${fixture.aliceHandle}"]`))).toBeVisible();
    }

    const firstVersion = historyVersions.nth(0);
    await firstVersion.getByRole('button', { name: 'Inspect version 1', exact: true }).click();
    const firstBody = firstVersion.locator('[data-slot="document-body"]');
    await expect(firstBody).toBeVisible();
    await expect(firstBody).toContainText('A quotation stays a quotation.');
    await expect(firstBody).not.toContainText('edited in the served editor');

    const secondVersion = historyVersions.nth(1);
    await secondVersion.getByRole('button', { name: 'Inspect version 2', exact: true }).click();
    const secondBody = secondVersion.locator('[data-slot="document-body"]');
    await expect(secondBody).toBeVisible();
    await expect(secondBody).toContainText('edited in the served editor');
    await expect(historyPanel).toContainText('LicenseRef-rezics-terms');
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/revision-history-desktop-dark.png'),
      fullPage: true,
    });

    const threadUrl = page.url();
    await page.close();

    const bobJourney = await fixture.auth.signIn('bob');
    const bobPage = bobJourney.continueOnPage();
    await bobPage.goto(threadUrl, { waitUntil: 'domcontentloaded' });
    await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await bobPage
      .locator(`#post-${original.id}`)
      .getByRole('button', { name: 'More actions', exact: true })
      .and(bobPage.locator('[aria-haspopup="menu"]'))
      .click();
    const bobMenu = bobPage.getByRole('menu');
    await expect(bobMenu.getByRole('menuitem', { name: 'Copy link', exact: true })).toBeVisible();
    await expect(bobMenu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
    await bobPage.close();

    const forbidden = await fixture.stack.kernel(
      `/v1/posts/${original.id}/revisions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          'if-match': JSON.stringify(newRevision!.revisionId),
        },
        body: JSON.stringify({
          body: initial,
          licence: original.licence,
          mediaIds: [],
        }),
      },
      'bob',
    );
    expect(forbidden.status).toBe(403);
    expect(pageErrors).toEqual([]);
    expect(network.some(({ url, status }) => url.includes('/v1/posts/') && status >= 400)).toBe(false);
  }
});

nativeTest('mounted revision history keeps its request bound as unrelated threads grow', timeout, async () => {
  const fixture = await createNativeDocumentAuthoringFixture();
  const { threadId, postId } = await seedDocumentHistory(fixture);
  const alice = await fixture.auth.signIn('alice', { sessionOnly: true });
  await alice.continueOnPage().close();

  const growthRequests: { unrelated: number; requests: number }[] = [];
  let unrelated = 0;
  for (const target of [1, 8, 64]) {
    await createGrowthThreads(fixture, unrelated, target);
    unrelated = target;
    const requests = await measureHistoryReads(fixture, threadId, alice.context, postId);
    growthRequests.push({ unrelated, requests });
  }
  console.log(`native-document-authoring-growth ${JSON.stringify(growthRequests)}`);
  expect(growthRequests.map(({ requests }) => requests)).toEqual([
    growthRequests[0]!.requests,
    growthRequests[0]!.requests,
    growthRequests[0]!.requests,
  ]);
});
