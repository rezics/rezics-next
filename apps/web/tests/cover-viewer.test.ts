import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cover, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { coverViewerImage } from '@rezics/ui/cover-viewer';

const subject: CoverSubject = { id: 'subject', title: 'A Book', types: ['schema:Book'] };
const cover: CoverSummary = {
  media: 'media',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '', color: '#456' },
  variants: [
    { format: 'webp', width: 240 },
    { format: 'webp', width: 1200 },
  ],
  focalPoint: null,
  credit: {
    rightsHolder: 'A Long Rights Holder',
    via: { name: 'Open Library', url: 'https://openlibrary.org/' },
    license: 'CC BY 4.0',
  },
};
const app = join(import.meta.dir, '..');
let browser: Browser | undefined;
let componentBundle: Promise<string> | undefined;

async function bundleSubjectCover() {
  componentBundle ??= (async () => {
    const directory = join(app, '../..', '.temp/goal/cover-viewer-browser');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'entry.tsx');
    const react = Bun.resolveSync('react', app);
    const reactDom = Bun.resolveSync('react-dom/client', app);
    const source = `
      import React from ${JSON.stringify(react)};
      import { createRoot } from ${JSON.stringify(reactDom)};
      import { SubjectPageCover } from ${JSON.stringify(join(app, 'src/features/pages/subject-page-cover.tsx'))};

      const subject = { id: 'subject', title: 'The Little Prince', types: ['schema:Book'] };
      const credit = {
        rightsHolder: 'REZICS fixtures',
        via: { name: 'Generated fixture', url: 'https://rezics.com' },
        license: 'CC0-1.0',
      };
      const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="6"><rect width="4" height="6" fill="#456"/></svg>';
      const loaded240 = URL.createObjectURL(new Blob([picture], { type: 'image/svg+xml' }));
      const loaded1200 = URL.createObjectURL(new Blob([picture], { type: 'image/svg+xml' }));
      const failed = URL.createObjectURL(new Blob(['not an image'], { type: 'text/plain' }));
      const sources = { 240: loaded240, 1200: loaded1200 };
      const src = (_media, _format, width) => sources[width];
      const image = {
        media: 'fixture', width: 1200, height: 1800,
        placeholder: { thumbhash: '', color: '#456' },
        variants: [{ format: 'webp', width: 240 }, { format: 'webp', width: 1200 }],
        focalPoint: null, credit,
      };
      const root = createRoot(document.getElementById('app'));
      window.mountCover = (kind) => root.render(React.createElement(SubjectPageCover, {
        subject,
        cover: kind === 'missing' ? null : { ...image, ...(kind === 'withheld' ? { withheld: 'suitability' } : {}) },
        size: 'lg', src: kind === 'failed' ? () => failed : src, suitability: 'blur', labels: {},
        title: subject.title, via: 'via', openLabel: 'Open cover: The Little Prince', closeLabel: 'Close cover',
      }));
      window.coverSources = sources;
    `;
    await writeFile(entry, source);
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
    });
    expect(result.success, result.logs.map(String).join('\n')).toBe(true);
    return result.outputs[0]!.text();
  })();
  return componentBundle;
}

async function mountCover(kind: 'loaded' | 'missing' | 'failed' | 'withheld') {
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  const kernelRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/v\d+\/pages(?::read|\/)/.test(request.url())) kernelRequests.push(request.url());
  });
  await page.setContent('<main id="app"></main>');
  await page.addScriptTag({ content: await bundleSubjectCover() });
  await page.evaluate((mode) => (window as Window & { mountCover: (value: string) => void }).mountCover(mode), kind);
  return { page, kernelRequests };
}

async function closePage(page: Page) {
  await page.close();
}

afterAll(async () => {
  await browser?.close();
});

test('Cover never renders a credit caption or credit control at any size', () => {
  for (const size of ['xs', 'sm', 'md', 'lg', 'xl', 'fill'] as const) {
    const html = renderToStaticMarkup(
      createElement(Cover, {
        subject,
        cover,
        size,
        src: (media, format, width) => `/media/${media}.${format}?w=${width}`,
      }),
    );
    expect(html).not.toContain('A Long Rights Holder');
    expect(html).not.toContain('Cover credit');
    expect(html).not.toContain('<figcaption');
  }
});

test('CoverViewer requests the largest declared variant through the site media source function', () => {
  expect(coverViewerImage(cover, (media, format, width) => `/media/${media}.${format}?w=${width}`)).toBe(
    '/media/media.webp?w=1200',
  );
});

test('the subject cover opens its accessible viewer, traps focus, and restores focus without a kernel read', async () => {
  const { page, kernelRequests } = await mountCover('loaded');
  try {
    const trigger = page.getByRole('button', { name: 'Open cover: The Little Prince' });
    await trigger.waitFor();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'The Little Prince' });
    await dialog.waitFor();
    const image = dialog.getByRole('img', { name: 'The Little Prince' });
    expect(await image.getAttribute('src')).toBe(
      await page.evaluate(() => (window as Window & { coverSources: Record<number, string> }).coverSources[1200]),
    );
    expect(await dialog.innerText()).toContain('© REZICS fixtures');
    expect(await dialog.getByRole('link', { name: 'Generated fixture' }).getAttribute('href')).toBe(
      'https://rezics.com',
    );
    expect(await dialog.innerText()).toContain('CC0-1.0');
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

    await trigger.click();
    const reopened = page.getByRole('dialog', { name: 'The Little Prince' });
    await reopened.waitFor();
    const close = reopened.getByRole('button', { name: 'Close cover' });
    await close.focus();
    await close.press('Enter');
    await reopened.waitFor({ state: 'detached' });
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(kernelRequests).toEqual([]);
  } finally {
    await closePage(page);
  }
}, 60_000);

test('missing, failed, and still-withheld covers have no viewer trigger until a usable image is revealed', async () => {
  const missing = await mountCover('missing');
  try {
    expect(await missing.page.getByRole('button', { name: 'Open cover: The Little Prince' }).count()).toBe(0);
  } finally {
    await closePage(missing.page);
  }

  const failed = await mountCover('failed');
  try {
    await failed.page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
    expect(await failed.page.getByRole('button', { name: 'Open cover: The Little Prince' }).count()).toBe(0);
  } finally {
    await closePage(failed.page);
  }

  const withheld = await mountCover('withheld');
  try {
    const coverFrame = withheld.page.locator('[data-slot="cover"]');
    expect(await coverFrame.getAttribute('data-state')).toBe('withheld');
    expect(await withheld.page.getByRole('button', { name: 'Open cover: The Little Prince' }).count()).toBe(0);
    await withheld.page.getByRole('button', { name: 'Show cover' }).click();
    const trigger = withheld.page.getByRole('button', { name: 'Open cover: The Little Prince' });
    await trigger.waitFor();
    await trigger.click();
    const dialog = withheld.page.getByRole('dialog', { name: 'The Little Prince' });
    await dialog.waitFor();
    const close = dialog.getByRole('button', { name: 'Close cover' });
    await close.focus();
    await close.press('Enter');
    await dialog.waitFor({ state: 'detached' });
  } finally {
    await closePage(withheld.page);
  }
});
