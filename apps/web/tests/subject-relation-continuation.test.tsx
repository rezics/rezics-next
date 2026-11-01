import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

// Authored for controller execution. This exercises the real PageStory route/composition and its local page fixtures.
let child: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
let origin: string;
afterAll(async () => {
  await browser?.close();
  if (child) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await child.exited;
  }
});
beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  child = Bun.spawn(['bun', 'run', 'storybook', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(import.meta.dir, '..'),
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output = (output + Buffer.from(chunk).toString()).slice(-8000);
  };
  void capture(child.stdout as ReadableStream<Uint8Array>);
  void capture(child.stderr as ReadableStream<Uint8Array>);
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(5000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not become ready:\n${output}`);
    await Bun.sleep(500);
  }
  browser = await chromium.launch();
}, 180_000);

async function holdContinuation(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & { continuationHeld?: boolean; releaseContinuation?: () => void };
    state.continuationHeld = false;
    const original = window.fetch;
    window.fetch = (async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      const response = await original(input, init);
      if (new URL(request.url).pathname === '/v1/pages:read' && request.method === 'POST') {
        const body = await request.clone().json();
        if (body.continuation) {
          state.continuationHeld = true;
          return new Promise<Response>((resolve) => {
            state.releaseContinuation = () => {
              window.fetch = original;
              resolve(response);
            };
          });
        }
      }
      return response;
    }) as typeof fetch;
  });
}
async function held(page: Page) {
  await page.waitForFunction(() => (window as typeof window & { continuationHeld?: boolean }).continuationHeld);
}
async function release(page: Page) {
  await page.evaluate(() => (window as typeof window & { releaseContinuation?: () => void }).releaseContinuation?.());
}

test('Make independent Subject relation continuation usable with keyboard and assistive technology', async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const url = `${origin}/iframe.html?id=pages-subjects-subject-relations--continuation&viewMode=story&globals=locale:en;theme:light`;
    await page.goto(url);
    const first = page.locator('[data-slot="relation-stream"][data-node="side-stories"]');
    const other = page.locator('[data-slot="relation-stream"][data-node="adaptations"]');
    const more = first.locator('[data-slot="continue-group"]');
    const otherMore = other.locator('[data-slot="continue-group"]');
    await more.waitFor();
    expect(await first.getByRole('status').textContent()).toBe('');
    expect(await other.getByRole('status').textContent()).toBe('');
    expect(await more.getAttribute('href')).toContain('node=side-stories&cursor=accessible-next');
    expect(await more.getAttribute('aria-describedby')).toBe('side-stories-status');
    expect(await first.getAttribute('aria-live')).toBeNull();
    const target = await more.boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(target!.width).toBeGreaterThanOrEqual(44);

    await page.evaluate(() => {
      const state = window as typeof window & { continuationReads?: unknown[] };
      state.continuationReads = [];
      const original = window.fetch;
      window.fetch = (async (input, init) => {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        if (new URL(request.url).pathname === '/v1/pages:read' && request.method === 'POST') {
          const body = await request.clone().json();
          if (body.continuation) state.continuationReads!.push(body.continuation);
        }
        return original(input, init);
      }) as typeof fetch;
    });
    await more.focus();
    await page.keyboard.press('Enter');
    await first.getByRole('link', { name: 'Side story added', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#side-stories-status')?.textContent?.includes('New visible items in Side stories: 1'));
    expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(1);
    expect(await first.getByRole('status').textContent()).toBe('New visible items in Side stories: 1. You can load more.');
    expect(await first.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(await first.getByRole('status').textContent()).not.toContain('Side story added');
    expect(await first.textContent()).not.toContain('Withheld title');
    expect(await other.getByRole('status').textContent()).toBe('');
    expect(await page.evaluate(() => (window as typeof window & { continuationReads?: unknown[] }).continuationReads))
      .toEqual([{ node: 'side-stories', cursor: 'accessible-next' }]);

    // A successful empty page reports zero and stays continuable, independently of the populated stream.
    await otherMore.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#adaptations-status')?.textContent?.includes('New visible items in Adaptations: 0'));
    expect(await otherMore.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await more.getAttribute('href')).toContain('cursor=accessible-end');

    // Moving focus while a different stream exhausts must win over its local completion focus.
    await holdContinuation(page);
    await page.keyboard.press('Enter');
    await held(page);
    await more.focus();
    await release(page);
    await other.locator('[data-slot="relation-stream-end"]').waitFor();
    expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);

    // A duplicate-only final page adds zero and deliberately replaces the disappearing focused action locally.
    await page.keyboard.press('Enter');
    const end = first.locator('[data-slot="relation-stream-end"]');
    await end.waitFor();
    expect(await first.getByRole('status').textContent()).toBe('New visible items in Side stories: 0. End of this list.');
    expect(await more.count()).toBe(0);
    expect(await end.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(1);

    expect(await page.evaluate(() => (window as typeof window & { continuationReads?: unknown[] }).continuationReads))
      .toEqual([
        { node: 'side-stories', cursor: 'accessible-next' },
        { node: 'adaptations', cursor: 'accessible-next' },
        { node: 'adaptations', cursor: 'accessible-end' },
        { node: 'side-stories', cursor: 'accessible-end' },
      ]);

    // Retire a pending section through ordinary route navigation, then focus a different, fresh stream.
    await page.goto(url);
    await more.waitFor();
    await holdContinuation(page);
    await more.focus();
    await page.keyboard.press('Enter');
    await held(page);
    await page.locator('[data-slot="view-tabs"]').getByRole('link', { name: /^Overview/ }).click();
    await page.waitForFunction(() => !document.querySelector('[data-slot="relation-stream"]'));
    await page.locator('[data-slot="view-tabs"]').getByRole('link', { name: /^Relations/ }).click();
    await otherMore.waitFor();
    await otherMore.focus();
    await release(page);
    // Wait for React's queued completion to settle without triggering another read.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await first.getByRole('status').textContent()).toBe('');
    expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(0);
    expect(await otherMore.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await first.locator('[data-slot="relation-stream-end"]').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 120_000);
