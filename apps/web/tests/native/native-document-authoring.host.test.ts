import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
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
import {
  createNativeDocumentAuthoringFixture,
  type NativeDocumentAuthoringFixture,
} from './native-document-authoring-fixture.ts';

setDefaultTimeout(600_000);
let fixture: NativeDocumentAuthoringFixture;

beforeAll(async () => {
  fixture = await createNativeDocumentAuthoringFixture();
});

afterAll(async () => fixture?.close());

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

async function createGrowthThreads(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
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
          }),
        },
        writer.persona,
      ),
      'POST /v1/threads growth fixture',
    );
  }
}

async function measureHistoryReads(pageUrl: string, context: BrowserContext): Promise<number> {
  const historyPage = await context.newPage();
  historyPage.setDefaultTimeout(30_000);
  await historyPage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await historyPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  const button = historyPage.getByRole('button', { name: 'Revision history', exact: true });
  await expect(button).toBeVisible();
  await historyPage.waitForTimeout(100);
  const before = fixture.stack.kernelRequests().length;
  await button.click();
  const panel = historyPage.getByRole('region', { name: 'Revision history', exact: true });
  await expect(panel.getByText('Version 2')).toBeVisible();
  const requests = fixture.stack.kernelRequests().slice(before);
  await historyPage.close();
  return requests.length;
}

describe('native document authoring', () => {
  test('the served composer preserves authored documents, revisions, and access through native reads', async () => {
    const aliceJourney = await fixture.auth.signIn('alice');
    const page = await aliceJourney.context.newPage();
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

    await page.getByRole('button', { name: 'More actions' }).click();
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
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('[data-slot="document-body"]')).toContainText('edited in the served editor');

    const revisionsRead = await json<{
      revisions: Post[];
      next: string | null;
    }>(
      await fixture.stack.kernel(`/v1/posts/${original.id}/revisions?limit=20`, undefined, 'alice'),
      'GET /v1/posts/:id/revisions',
    );
    expect(revisionsRead.revisions).toHaveLength(2);
    const [oldRevision, newRevision] = revisionsRead.revisions;
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

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const revisedProse = page.locator('[data-slot="document-body"]').first();
    const visibleBlocks = await revisedProse.locator(':scope > *').allTextContents();
    expect(visibleBlocks[0]).not.toContain('Unicode 雪');
    expect(visibleBlocks.findIndex((text) => text.includes('Unicode 雪'))).toBeGreaterThan(0);
    await expect(revisedProse.locator('blockquote')).toContainText('A quotation stays a quotation.');
    await expect(revisedProse.locator('ul > li')).toContainText('A supported list item.');
    await expect(revisedProse.locator('pre code')).toContainText('const  preserved  = true;');
    await expect(revisedProse).not.toContainText('Private account title sentinel');

    const history = page.getByRole('button', {
      name: 'Revision history',
      exact: true,
    });
    await history.click();
    const historyPanel = page.getByRole('region', {
      name: 'Revision history',
      exact: true,
    });
    const historyVersions = historyPanel.locator(':scope > ol > li');
    await expect(historyVersions).toHaveCount(2);
    await expect(historyVersions.nth(0).getByText('Version 1')).toBeVisible();
    await expect(historyVersions.nth(0)).toContainText('A quotation stays a quotation.');
    await expect(
      historyVersions.nth(0).getByRole('link', {
        name: `@${fixture.aliceHandle}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(historyVersions.nth(0)).not.toContainText('edited in the served editor');
    await expect(historyVersions.nth(1).getByText('Version 2')).toBeVisible();
    await expect(historyVersions.nth(1)).toContainText('edited in the served editor');
    await expect(
      historyVersions.nth(1).getByRole('link', {
        name: `@${fixture.aliceHandle}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(historyPanel).toContainText('LicenseRef-rezics-terms');
    await page.screenshot({
      path: join(import.meta.dir, '../../../.temp/native-document-authoring/revision-history-desktop-dark.png'),
      fullPage: true,
    });

    const bobJourney = await fixture.auth.signIn('bob');
    const bobPage = await bobJourney.context.newPage();
    await bobPage.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await expect(bobPage.getByRole('button', { name: 'More actions' })).toBeVisible();
    await bobPage.getByRole('button', { name: 'More actions' }).click();
    await expect(bobPage.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);

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

    const growthRequests: { unrelated: number; requests: number }[] = [];
    let unrelated = 0;
    for (const target of [1, 8, 64]) {
      await createGrowthThreads(target - unrelated);
      unrelated = target;
      const requests = await measureHistoryReads(page.url(), aliceJourney.context);
      growthRequests.push({ unrelated, requests });
    }
    console.log(`native-document-authoring-growth ${JSON.stringify(growthRequests)}`);
    expect(growthRequests.map(({ requests }) => requests)).toEqual([
      growthRequests[0]!.requests,
      growthRequests[0]!.requests,
      growthRequests[0]!.requests,
    ]);
  });
});
