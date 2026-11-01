import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { cleanupAll, ownBunProcess, type ProcessCustody } from './support/server-custody.ts';
import messages from '../messages/en.json';

let child: ReturnType<typeof Bun.spawn> | undefined;
let storybookCustody: ProcessCustody | undefined;
let browser: Browser | undefined;
afterAll(async () => {
  await cleanupAll([
    { label: 'Shell toast browser', run: () => browser?.close(), timeoutMs: 5000 },
    { label: 'Shell toast Storybook group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
  ]);
});

test('signed-in Subject and Entries use the default AppShell composition for one notification and working undo', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  child = Bun.spawn(['bun', 'run', 'storybook', '--host', '127.0.0.1', '--port', String(port), '--ci'], {
    cwd: join(import.meta.dir, '..'),
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const custody = (storybookCustody = ownBunProcess(child, { label: 'Shell toast Storybook' }));
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${custody.diagnostics()}`);
    try {
      const response = await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not become ready:\n${custody.diagnostics()}`);
    await Bun.sleep(500);
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  for (const journey of ['subject', 'entries'] as const) {
    await page.goto(
      `${origin}/iframe.html?id=${journey === 'subject' ? 'pages-subjects-subject' : 'pages-library-entries'}--signed-in&viewMode=story&globals=locale:en`,
    );
    await page
      .getByRole('heading', {
        level: 1,
        name: journey === 'subject' ? 'The Little Prince' : messages.library_heading,
        exact: true,
      })
      .waitFor();
    expect(await page.getByRole('region', { name: 'Notifications', exact: true }).count()).toBe(1);
    expect((await new AxeBuilder({ page }).withRules(['landmark-unique']).analyze()).violations).toEqual([]);

    let restored: () => Promise<void>;
    if (journey === 'subject') {
      const state = page.getByRole('combobox', { name: messages.library_subject_entry });
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-slot="select-trigger"][aria-label="Library state"]');
        return state && !state.hasAttribute('disabled');
      });
      const initialState = await state.textContent();
      restored = async () => {
        await state.filter({ hasText: initialState! }).waitFor();
        expect(await state.textContent()).toBe(initialState);
      };
      await state.click();
      await page.getByRole('option', { name: messages.library_subject_remove, exact: true }).click();
    } else {
      const actions = page.getByRole('button', { name: /^Actions for / }).first();
      await actions.waitFor();
      const name = (await actions.getAttribute('aria-label'))!;
      const entry = page.getByRole('button', { name, exact: true });
      restored = async () => {
        await entry.waitFor();
      };
      await actions.click();
      await page.getByRole('menuitem', { name: messages.library_remove_from_library, exact: true }).click();
      await page.getByRole('button', { name: messages.library_remove_submit, exact: true }).click();
      await entry.waitFor({ state: 'detached' });
    }

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
    await restored();
  }
}, 300_000);
