import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { cleanupAll, ownBunProcess, type ProcessCustody } from './support/server-custody.ts';
import emptySearch from '../src/kernel/recorded/search-empty.json';

let child: ReturnType<typeof Bun.spawn> | undefined;
let storybookCustody: ProcessCustody | undefined;
let browser: Browser | undefined;
let origin: string;
afterAll(async () => {
  await cleanupAll([
    { label: 'Header search browser', run: () => browser?.close(), timeoutMs: 5000 },
    { label: 'Header search Storybook group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
  ]);
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
  const custody = (storybookCustody = ownBunProcess(child, { label: 'Header search Storybook' }));
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${custody.diagnostics()}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(5000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not become ready:\n${custody.diagnostics()}`);
    await Bun.sleep(500);
  }

  browser = await chromium.launch();
}, 180_000);

// Use the existing PageStory route assembly, including AppShell's default ShellSearch and real filter registration.
test('Header search stays centered and forms one coherent surface across desktop and phone', async () => {
  for (const locale of ['en', 'zh-Hans'])
    for (const theme of ['light', 'dark']) {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(
        `${origin}/iframe.html?id=pages-discovery-search--typed&viewMode=story&globals=locale:${locale};theme:${theme}`,
      );
      await page.locator('html[data-hydrated]').waitFor();
      await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor();
      const owner = page.locator('[data-header-search]');
      const input = owner.getByRole('combobox');
      await input.waitFor();
      const originalInput = await input.elementHandle();
      const originalQuery = await input.inputValue();
      expect(await owner.count()).toBe(1);
      expect(await owner.locator('input:not([type="hidden"])').count()).toBe(1);

      // At the compact breakpoint the real AppShell trigger's name must match all of its visible text.
      await page.setViewportSize({ width: 980, height: 560 });
      const compactTrigger = owner.locator('.header-search-trigger');
      const compactName = (await compactTrigger.innerText()).replace(/\s+/gu, ' ').trim();
      expect(await compactTrigger.isVisible()).toBe(true);
      expect(await compactTrigger.getAttribute('aria-label')).toBe(compactName);
      expect(await page.getByRole('button', { name: compactName, exact: true }).count()).toBe(1);
      expect(await compactTrigger.getAttribute('aria-keyshortcuts')).toBe('Control+k Meta+k');
      const helpId = await compactTrigger.getAttribute('aria-describedby');
      const help = owner.locator('[id$="-keyboard-help"]');
      expect(helpId).toBeTruthy();
      expect(await help.getAttribute('id')).toBe(helpId);
      expect((await help.innerText()).trim().length).toBeGreaterThan(0);

      // Unequal translated control groups must not move the field or intrude into it.
      for (const width of [1280, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await owner.evaluate((element) => {
          const field = element.getBoundingClientRect();
          const track = element.parentElement!;
          const left = track.previousElementSibling!.getBoundingClientRect();
          const right = track.nextElementSibling!.getBoundingClientRect();
          return {
            center: (field.left + field.right) / 2,
            left: field.left,
            right: field.right,
            leftEnd: left.right,
            rightStart: right.left,
          };
        });
        expect(Math.abs(bounds.center - width / 2)).toBeLessThanOrEqual(1);
        expect(bounds.left).toBeGreaterThan(bounds.leftEnd);
        expect(bounds.right).toBeLessThan(bounds.rightStart);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await input.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      const paint = await input.evaluate((element) => {
        const composer = element.closest('[data-search-composer]')!;
        const panel = element.closest('form')!;
        const background = (node: Element): string => {
          const color = getComputedStyle(node).backgroundColor;
          return color === 'rgba(0, 0, 0, 0)' || color === 'transparent' ? background(node.parentElement!) : color;
        };
        const focus = getComputedStyle(element);
        return {
          composer: background(composer),
          panel: background(panel),
          shadow: getComputedStyle(composer).boxShadow,
          outline: focus.outlineStyle,
          width: parseFloat(focus.outlineWidth),
        };
      });
      expect(paint.composer).toBe(paint.panel);
      expect(paint.shadow).toBe('none');
      expect(paint.outline).toBe('solid');
      expect(paint.width).toBeGreaterThanOrEqual(2);

      // The second-row Filters action still opens the route-owned editor and transfers focus.
      const filters = owner.locator('[data-search-composer] button', { hasText: locale === 'en' ? 'Filters' : '筛选' });
      await page.waitForFunction(() => {
        const action = document.querySelector('[data-search-composer] button[data-slot="button"]');
        return action && !action.hasAttribute('disabled');
      });
      await filters.click();
      await page.waitForFunction(() =>
        document.querySelector('#desktop-filter-form')?.contains(document.activeElement),
      );
      expect(await input.inputValue()).toBe(originalQuery);

      await page.setViewportSize({ width: 390, height: 844 });
      const trigger = owner.locator('.header-search-trigger');
      await trigger.click();
      await owner.getByRole('search').waitFor();
      expect(await owner.getAttribute('role')).toBe('dialog');
      expect(await owner.getAttribute('aria-modal')).toBe('true');
      expect(
        await originalInput!.evaluate(
          (element) => element === document.querySelector('[data-header-search] input[role="combobox"]'),
        ),
      ).toBe(true);
      await input.fill('A retained draft');
      await page.keyboard.press('Shift+Tab');
      const back = owner.locator('[data-search-composer] button').first();
      expect(await back.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press('Tab');
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);

      // A reduced visual viewport keeps the composer visible and the remaining panel internally scrollable.
      await page.setViewportSize({ width: 390, height: 360 });
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-header-search] form')!;
        return (
          panel.getBoundingClientRect().bottom <= window.visualViewport!.height + window.visualViewport!.offsetTop + 1
        );
      });
      expect(
        await input.evaluate((element) => element.getBoundingClientRect().bottom <= window.visualViewport!.height),
      ).toBe(true);
      await back.click();
      await page.waitForFunction(() => document.activeElement?.classList.contains('header-search-trigger'));
      expect(await input.inputValue()).toBe('A retained draft');
      await trigger.click();
      await page.keyboard.press('Escape');
      expect(await owner.getAttribute('aria-modal')).toBeNull();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
      expect(await input.inputValue()).toBe('A retained draft');
      await context.close();
    }
}, 300_000);

test('A reader can enter and leave the existing header search using a discoverable keyboard shortcut', async () => {
  for (const locale of ['en', 'zh-Hans'])
    for (const theme of ['light', 'dark']) {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(
          `${origin}/iframe.html?id=pages-discovery-search--typed&viewMode=story&globals=locale:${locale};theme:${theme}`,
        );
        await page.locator('html[data-hydrated]').waitFor();
        await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor();
        await page.locator('[data-header-search]').getByRole('combobox').waitFor();
        await keyboardJourney(page, locale);
      } finally {
        await context.close();
      }
    }
}, 120_000);

test('the signed-in Subject shell trigger has its exact visible accessible name before and after a retained query', async () => {
  const context = await browser!.newContext({ viewport: { width: 980, height: 560 }, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(
      `${origin}/iframe.html?id=pages-subjects-subject--signed-in&viewMode=story&globals=locale:en;theme:light`,
    );
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'The Little Prince' }).waitFor();

    const owner = page.locator('[data-header-search]');
    const trigger = owner.locator('.header-search-trigger');
    const input = owner.locator('input[role="combobox"]');
    const help = owner.locator('[id$="-keyboard-help"]');
    await trigger.waitFor({ state: 'visible' });

    const visibleName = (await trigger.innerText()).replace(/\s+/gu, ' ').trim();
    expect(await trigger.getAttribute('aria-label')).toBe(visibleName);
    expect(await page.getByRole('button', { name: visibleName, exact: true }).count()).toBe(1);
    expect(await trigger.getAttribute('aria-keyshortcuts')).toBe('Control+k Meta+k');
    const helpId = await help.getAttribute('id');
    expect(helpId).toBeTruthy();
    expect(await trigger.getAttribute('aria-describedby')).toBe(helpId);
    expect((await help.innerText()).trim().length).toBeGreaterThan(0);
    expect(await input.getAttribute('aria-label')).toBe('Search subjects');

    await trigger.click();
    const expandedInput = owner.getByRole('combobox', { name: 'Search subjects' });
    await expandedInput.waitFor({ state: 'visible' });
    expect(await expandedInput.getAttribute('aria-label')).toBe('Search subjects');
    expect(await expandedInput.getAttribute('aria-keyshortcuts')).toBe('Control+k Meta+k');
    expect((await expandedInput.getAttribute('aria-describedby'))?.split(/\s+/u)).toContain(helpId);

    await expandedInput.fill('Visible draft');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.classList.contains('header-search-trigger'));
    const queryName = (await trigger.innerText()).replace(/\s+/gu, ' ').trim();
    expect(queryName).toBe('Visible draft Ctrl/⌘ K');
    expect(await trigger.getAttribute('aria-label')).toBe(queryName);
    expect(await page.getByRole('button', { name: queryName, exact: true }).count()).toBe(1);
    expect(await trigger.getAttribute('aria-describedby')).toBe(helpId);
  } finally {
    await context.close();
  }
}, 120_000);

// Extend the same real default composition, retaining every original geometry/filter/phone assertion above.
async function keyboardJourney(page: Page, locale: string) {
  const owner = page.locator('[data-header-search]');
  const input = owner.getByRole('combobox');
  const origin = page.getByRole('main');
  await page.setViewportSize({ width: 1280, height: 900 });
  await origin.focus();

  const ignored = await origin.evaluate((element) => {
    const variants: KeyboardEventInit[] = [
      {},
      { ctrlKey: true, repeat: true },
      { ctrlKey: true, isComposing: true },
      { ctrlKey: true, keyCode: 229 },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, metaKey: true },
    ];
    const results = variants.map((options) => {
      const event = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...options });
      element.dispatchEvent(event);
      return !event.defaultPrevented && document.activeElement === element;
    });
    const prevented = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    element.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    element.dispatchEvent(prevented);
    results.push(document.activeElement === element);

    // Unrelated native/custom editors and a focus trap keep their own shortcut and focus.
    for (const kind of ['input', 'textarea', 'select', 'contenteditable', 'textbox', 'menu', 'trap', 'dialog']) {
      const container = document.createElement(kind === 'dialog' ? 'dialog' : 'div');
      const control = document.createElement(['input', 'textarea', 'select'].includes(kind) ? kind : 'button');
      if (kind === 'contenteditable') container.contentEditable = 'true';
      if (kind === 'textbox') container.setAttribute('role', 'textbox');
      if (kind === 'menu') container.setAttribute('role', 'menu');
      if (kind === 'trap') container.setAttribute('data-focus-trap', 'true');
      container.append(control);
      document.body.append(container);
      if (container instanceof HTMLDialogElement) container.showModal();
      control.focus();
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      control.dispatchEvent(event);
      results.push(!event.defaultPrevented && document.activeElement === control);
      if (container instanceof HTMLDialogElement) container.close();
      container.remove();
    }
    element.focus();
    return results;
  });
  expect(ignored.every(Boolean)).toBe(true);
  expect(await owner.getAttribute('data-expanded')).toBe('false');

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await origin.focus();
    await page.keyboard.press(width === 1280 ? 'Control+k' : 'Meta+k');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await owner.count()).toBe(1);
    expect(await owner.locator('input:not([type="hidden"])').count()).toBe(1);
    expect(await input.getAttribute('aria-keyshortcuts')).toBe('Control+k Meta+k');
    expect(await input.getAttribute('aria-describedby')).toContain('keyboard-help');
    expect(await input.getAttribute('title')).toBeTruthy();
    if (width === 390) expect(await owner.getAttribute('aria-modal')).toBe('true');
    await input.fill('Keyboard draft');
    await page.keyboard.press('Control+k'); // Already in this field: keep the initiating focus target.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    expect(await origin.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await owner.getAttribute('data-expanded')).toBe('false');
    expect(await input.inputValue()).toBe('Keyboard draft');
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    if (width === 390) {
      const trigger = owner.getByRole('button', { name: 'Keyboard draft Ctrl/⌘ K', exact: true });
      expect(await trigger.isVisible()).toBe(true);
      expect(await trigger.getAttribute('aria-label')).toBe('Keyboard draft Ctrl/⌘ K');
      expect((await trigger.innerText()).replace(/\s+/gu, ' ').trim()).toBe('Keyboard draft Ctrl/⌘ K');
      expect(await trigger.locator('kbd').isVisible()).toBe(true);
      expect(await trigger.locator('kbd').innerText()).toBe('Ctrl/⌘ K');
      expect(await trigger.getAttribute('aria-keyshortcuts')).toBe('Control+k Meta+k');
      expect(await trigger.getAttribute('aria-describedby')).toBe(await input.getAttribute('aria-describedby'));

      const quotedDraft = `Keyboard "draft" & reader's note`;
      await trigger.click();
      await input.fill(quotedDraft);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.classList.contains('header-search-trigger'));
      const quotedName = `${quotedDraft} Ctrl/⌘ K`;
      const quotedTrigger = owner.getByRole('button', { name: quotedName, exact: true });
      expect(await quotedTrigger.getAttribute('aria-label')).toBe(quotedName);
      expect((await quotedTrigger.innerText()).replace(/\s+/gu, ' ').trim()).toBe(quotedName);
    }
  }

  // A removed initiator falls back to the compact trigger, rather than focusing a detached node.
  await page.evaluate(() => {
    const initiator = document.createElement('button');
    document.body.append(initiator);
    initiator.focus();
    initiator.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    initiator.remove();
  });
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('header-search-trigger'));

  // Keyboard entry still submits the real GET form to its localized route with retained filters, never cursor.
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  const form = owner.getByRole('search');
  expect(await form.getAttribute('action')).toBe(`/${locale}/search`);
  const retained = await form
    .locator('input[type="hidden"]')
    .evaluateAll((elements) =>
      elements.map((element) => [(element as HTMLInputElement).name, (element as HTMLInputElement).value]),
    );
  expect(retained).toContainEqual(['type', 'schema:Book']);
  expect(retained.some(([name]) => name === 'cursor')).toBe(false);
  await input.fill(emptySearch.query);
  const submitted = form.evaluate(
    (element) =>
      new Promise<[string, string][]>((resolve) => {
        element.addEventListener(
          'submit',
          () => resolve(Array.from(new FormData(element as HTMLFormElement).entries()) as [string, string][]),
          { once: true },
        );
      }),
  );
  await page.keyboard.press('Enter');
  expect(await submitted).toEqual([...retained, ['q', emptySearch.query]]);
  await page
    .getByRole('main')
    .getByText(locale === 'en' ? 'No results found.' : '没有找到结果。', { exact: true })
    .waitFor();
  expect(await owner.getAttribute('data-expanded')).toBe('false');
  expect(await input.inputValue()).toBe(emptySearch.query);
}
