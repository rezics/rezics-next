import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect as browserExpect, type Browser, type Page } from 'playwright/test';
import type { UiLocale } from '../i18n/define.ts';
import { spaceHref } from '../features/address/path.ts';

interface MenuFixture {
  locale: UiLocale;
  sortHrefs?: { best: string; new: string; top: string };
}
interface TestWindow {
  renderMenus(fixture: MenuFixture): void;
  pushes: string[];
}

const discussion = spaceHref('reader-circle', 'community', ['discussions']);
const newHref = `${discussion}?language=ar&sort=new#comments`;
const topHref = `${discussion}?language=ar&sort=top#comments`;
const periodHref = `${discussion}?language=ar&sort=top&t=all#comments`;

describe('LinkMenu browser navigation', () => {
  let browser: Browser;
  let page: Page;
  let scratch: string;
  let bundle: string;

  beforeAll(async () => {
    await mkdir(resolve('.temp'), { recursive: true });
    scratch = await mkdtemp(resolve('.temp/link-menu-navigation-'));
    const entry = resolve(scratch, 'mount.tsx');
    await writeFile(entry, `import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LinkMenu } from ${JSON.stringify(resolve('apps/web/features/feed/controls.tsx'))};
import { ShellProvider } from ${JSON.stringify(resolve('apps/web/features/shell/shell-provider.tsx'))};
import { messages } from ${JSON.stringify(resolve('apps/web/features/shell/messages.ts'))};
const root = createRoot(document.getElementById('root'));
let generation = 0;
function Menus({ fixture }) {
  const [sort, setSort] = useState('best');
  const [period, setPeriod] = useState('week');
  useEffect(() => {
    window.pushes = [];
    // The router boundary records the exact destination and supplies the next route's selected state.
    window.navigate = href => {
      window.pushes.push(href);
      const query = new URL(href, 'https://web.test').searchParams;
      if (query.has('sort')) setSort(query.get('sort'));
      if (query.has('t')) setPeriod(query.get('t'));
    };
    return () => { delete window.navigate; };
  }, []);
  const hrefs = fixture.sortHrefs ?? {
    best: ${JSON.stringify(discussion)}, new: ${JSON.stringify(newHref)}, top: ${JSON.stringify(topHref)},
  };
  return <ShellProvider locale={fixture.locale} messages={messages} initialTheme="system" initialCollapsed={false}>
    <LinkMenu label="Sort" value={sort} options={[
      { value: 'best', label: 'Best', href: hrefs.best },
      { value: 'new', label: 'New', href: hrefs.new },
      { value: 'top', label: 'Top', href: hrefs.top },
    ]} />
    {sort === 'top' ? <LinkMenu label="Period" value={period} options={[
      { value: 'week', label: 'This week', href: ${JSON.stringify(`${topHref.replace('#comments', '')}&t=week#comments`)} },
      { value: 'all', label: 'All time', href: ${JSON.stringify(periodHref)} },
    ]} /> : null}
  </ShellProvider>;
}
window.renderMenus = fixture => root.render(<Menus key={++generation} fixture={fixture} />);
`);
    // Only this bundle substitutes Next's navigation boundaries. React, ShellProvider and Ark menus are real.
    const built = await Bun.build({
      entrypoints: [entry], target: 'browser', define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [{ name: 'link-menu-router-boundary', setup(build) {
        build.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: 'router', namespace: 'link-menu-router',
        }));
        build.onLoad({ filter: /.*/, namespace: 'link-menu-router' }, () => ({
          loader: 'js', contents: 'export function useRouter() { return { push: href => window.navigate(href) }; }',
        }));
        // Feed controls also import Link; its unused Next module initializes build-time environment constants.
        build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'link-menu-link' }));
        build.onLoad({ filter: /.*/, namespace: 'link-menu-link' }, () => ({
          loader: 'js', contents: 'import { createElement } from "react"; export default function Link(props) { return createElement("a", props); }',
        }));
      } }],
    });
    if (!built.success) throw new Error(built.logs.join('\n'));
    bundle = await built.outputs[0]!.text();
    browser = await chromium.launch({ headless: true });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    const bundleError = new Promise<never>((_resolve, reject) => page.once('pageerror', error => {
      reject(new Error(`LinkMenu browser bundle: ${error.message}`, { cause: error }));
    }));
    await page.setContent('<div id="root"></div>');
    const ready = Promise.race([page.waitForFunction(() => 'renderMenus' in window), bundleError]);
    // An injection failure or early pageerror can settle before addScriptTag returns.
    // Mark it handled now; awaiting the original promise still reports its setup error.
    void ready.catch(() => {});
    await page.addScriptTag({ type: 'module', content: bundle });
    await ready;
  });
  afterEach(async () => { await page?.close(); });

  async function mount(fixture: MenuFixture) {
    await page.evaluate(fixture => (window as unknown as TestWindow).renderMenus(fixture), fixture);
    await browserExpect(page.getByRole('button', { name: 'Sort: Best', exact: true })).toBeVisible();
    await page.waitForFunction(() => 'navigate' in window);
  }
  const pushes = () => page.evaluate(() => (window as unknown as TestWindow).pushes);
  async function choose(trigger: string, choice: string) {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    await page.getByRole('menuitemradio', { name: choice, exact: true }).click();
  }

  test.each(['ja', 'zh-Hant'] as const)('sort and period clicks retain the %s locale, filters and section', async locale => {
    await mount({ locale });
    await choose('Sort: Best', 'New');
    await browserExpect(page.getByRole('button', { name: 'Sort: New', exact: true })).toBeVisible();
    expect(await pushes()).toEqual([`/${locale}${newHref}`]);
    await choose('Sort: New', 'Top');
    await browserExpect(page.getByRole('button', { name: 'Sort: Top', exact: true })).toBeVisible();
    await choose('Period: This week', 'All time');
    await browserExpect(page.getByRole('button', { name: 'Period: All time', exact: true })).toBeVisible();
    expect(await pushes()).toEqual([`/${locale}${newHref}`, `/${locale}${topHref}`, `/${locale}${periodHref}`]);
  });

  test('an already localized page destination keeps one locale prefix', async () => {
    await mount({ locale: 'ja', sortHrefs: { best: discussion, new: `/ja${newHref}`, top: topHref } });
    await choose('Sort: Best', 'New');
    await browserExpect(page.getByRole('button', { name: 'Sort: New', exact: true })).toBeVisible();
    expect(await pushes()).toEqual([`/ja${newHref}`]);
  });

  test.each([
    '/api/main/v1/threads?sort=new#comments',
    `https://other.test${discussion}?sort=new#comments`,
    `//other.test${discussion}?sort=new#comments`,
  ])('a non-page destination remains unchanged: %s', async href => {
    await mount({ locale: 'ja', sortHrefs: { best: discussion, new: href, top: topHref } });
    await choose('Sort: Best', 'New');
    await browserExpect(page.getByRole('button', { name: 'Sort: New', exact: true })).toBeVisible();
    expect(await pushes()).toEqual([href]);
  });
});
