import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import messages from '../messages/en.json';

let child: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
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

test('the signed-in subject composes AppShell and its existing local Toaster with one notification and working undo', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  child = Bun.spawn(['bun', 'run', 'storybook', '--host', '127.0.0.1', '--port', String(port), '--ci', '--no-open'], {
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
      const response = await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not become ready:\n${output}`);
    await Bun.sleep(500);
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(`${origin}/iframe.html?id=pages-subjects-subject--signed-in&viewMode=story&globals=locale:en`);
  await page.getByRole('heading', { level: 1, name: 'The Little Prince', exact: true }).waitFor();
  const state = page.getByRole('combobox', { name: messages.library_subject_entry });
  await page.waitForFunction(() => {
    const state = document.querySelector('[data-slot="select-trigger"][aria-label="Library state"]');
    return state && !state.hasAttribute('disabled');
  });
  const initialState = await state.textContent();
  expect(await page.getByRole('region', { name: 'Notifications', exact: true }).count()).toBe(1);
  expect((await new AxeBuilder({ page }).withRules(['landmark-unique']).analyze()).violations).toEqual([]);

  await state.click();
  await page.getByRole('option', { name: messages.library_subject_remove, exact: true }).click();
  const notification = page.getByRole('dialog').filter({ hasText: messages.library_removed });
  await notification.waitFor();
  expect(await page.getByRole('dialog').count()).toBe(1);
  const announcements = page.locator('[aria-live="polite"]').filter({ hasText: messages.library_removed });
  await announcements.waitFor();
  expect(await announcements.count()).toBe(1);
  expect(await page.getByRole('region', { name: 'Notifications', exact: true }).count()).toBe(1);
  await page.keyboard.press('F6');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-slot') === 'toast-viewport');
  await notification.hover();
  await notification.getByRole('button', { name: messages.editor_undo, exact: true }).focus();
  await page.keyboard.press('Enter');
  await notification.waitFor({ state: 'detached' });
  await state.filter({ hasText: initialState! }).waitFor();
  expect(await state.textContent()).toBe(initialState);
}, 300_000);
