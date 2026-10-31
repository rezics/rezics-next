import { afterAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

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

// Use the existing PageStory route assembly, including AppShell's default ShellSearch and real filter registration.
test('Header search stays centered and forms one coherent surface across desktop and phone', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
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
  for (const locale of ['en', 'zh-Hans'])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
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
