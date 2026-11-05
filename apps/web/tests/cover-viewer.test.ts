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
      import { Cover as OverviewCover, OverviewContext } from ${JSON.stringify(join(app, 'src/features/pages/overview.tsx'))};

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
      const journeyImage = (value) => value.cover === false ? null : {
        ...image,
        media: value.media || image.media,
        variants: image.variants.map((variant) => ({ ...variant })),
        ...(value.withheld ? { withheld: 'suitability' } : {}),
      };
      const journeySubject = (value) => ({
        id: value.subjectId || 'journey-subject',
        title: value.title,
        types: ['schema:Book'],
      });
      const journeySource = (value) => (media, format, width) =>
        'https://media.test/' + value.base + '/' + media + '/' + format + '/' + width;
      window.mountSubjectJourney = (value) => root.render(React.createElement(SubjectPageCover, {
        subject: journeySubject(value), cover: journeyImage(value), size: 'lg', src: journeySource(value),
        suitability: value.suitability || 'blur', labels: {}, title: value.title, via: 'via',
        openLabel: 'Open cover: ' + value.title, closeLabel: 'Close cover',
      }));
      window.updateSubjectJourney = window.mountSubjectJourney;
      window.mountOverviewJourney = (value) => {
        const subject = journeySubject(value);
        const summary = journeyImage(value)
          ? { id: subject.id, type: 'schema:Book', types: subject.types, cover: journeyImage(value) }
          : { id: subject.id, type: 'schema:Book', types: subject.types, cover: null };
        const readSubject = {
          id: subject.id, labels: { en: value.title }, statements: {}, type: 'schema:Book', types: subject.types,
        };
        const section = {
          ok: true, read: { kind: 'subject' }, body: { subject: readSubject, related: {}, summary },
        };
        const context = {
          locale: 'en', subject: subject.id, reader: { suitability: value.suitability || 'blur' },
          labels: { cover: {} }, unlabelled: 'Untitled subject', cover: 'Cover', coverVia: 'via',
          sections: new Map([['cover', section]]), relations: {}, relationNodes: [], link: () => null,
          spoilerShow: 'Show', details: 'Details', licence: 'Licence', source: 'Source', sources: 'Sources',
        };
        root.render(React.createElement(OverviewContext.Provider, { value: context },
          React.createElement(OverviewCover, { id: 'cover' }),
        ));
      };
      window.updateOverviewJourney = window.mountOverviewJourney;
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

async function harnessPage() {
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  const kernelRequests: string[] = [];
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/v\d+\/pages(?::read|\/)/.test(request.url())) kernelRequests.push(request.url());
  });
  await page.route('https://media.test/**', async (route) => {
    const url = new URL(route.request().url());
    mediaRequests.push(url.href);
    const failed = url.pathname.split('/')[1] === 'failed-source';
    await route.fulfill({
      status: failed ? 404 : 200,
      contentType: 'image/svg+xml',
      headers: { 'cache-control': 'no-store' },
      body: failed
        ? 'not an image'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="6"><rect width="4" height="6" fill="#456"/></svg>',
    });
  });
  await page.setContent(
    '<html><head><base href="https://media.test/"></head><body><main id="app"></main></body></html>',
  );
  await page.addScriptTag({ content: await bundleSubjectCover() });
  return { page, kernelRequests, mediaRequests };
}

async function mountCover(kind: 'loaded' | 'missing' | 'failed' | 'withheld') {
  const mounted = await harnessPage();
  const { page } = mounted;
  await page.evaluate((mode) => (window as Window & { mountCover: (value: string) => void }).mountCover(mode), kind);
  return mounted;
}

async function mountJourney(wrapper: 'subject' | 'overview', value: Record<string, unknown>) {
  const mounted = await harnessPage();
  const mount = wrapper === 'subject' ? 'mountSubjectJourney' : 'mountOverviewJourney';
  await mounted.page.evaluate(
    ({ method, state }) => {
      (window as Window & { [key: string]: (value: unknown) => void })[method]!(state);
    },
    { method: mount, state: value },
  );
  return mounted;
}

async function updateJourney(page: Page, wrapper: 'subject' | 'overview', value: Record<string, unknown>) {
  const update = wrapper === 'subject' ? 'updateSubjectJourney' : 'updateOverviewJourney';
  await page.evaluate(
    ({ method, state }) => {
      (window as Window & { [key: string]: (value: unknown) => void })[method]!(state);
    },
    { method: update, state: value },
  );
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

test('SubjectPageCover and overview Cover close on replacement and preserve only equivalent viewer state', async () => {
  for (const wrapper of ['subject', 'overview'] as const) {
    const first = {
      base: 'journey-a',
      media: 'same-media',
      subjectId: 'journey-subject',
      title: 'Journey A',
    };
    const { page, kernelRequests, mediaRequests } = await mountJourney(wrapper, first);
    try {
      await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
      const firstTrigger = page.getByRole('button', { name: 'Open cover: Journey A' });
      await firstTrigger.click();
      const firstDialog = page.getByRole('dialog', { name: 'Journey A' });
      await firstDialog.waitFor();
      await page.keyboard.press('Tab');
      expect(await firstDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await firstDialog.waitFor({ state: 'detached' });
      expect(await firstTrigger.evaluate((element) => element === document.activeElement)).toBe(true);

      await firstTrigger.click();
      await page.getByRole('dialog', { name: 'Journey A' }).waitFor();
      const requestsBeforeEquivalentRender = mediaRequests.length;
      await updateJourney(page, wrapper, { ...first, title: 'Translated title' });
      await page.getByRole('dialog', { name: 'Translated title' }).waitFor();
      expect(await page.locator('[data-slot="cover"]').getAttribute('data-state')).toBe('loaded');
      expect(mediaRequests.length).toBe(requestsBeforeEquivalentRender);

      // The same media id with a changed published URL is a new image incarnation. An open A viewer closes before B.
      await updateJourney(page, wrapper, { ...first, base: 'journey-b', title: 'Journey B' });
      await page.getByRole('dialog', { name: 'Translated title' }).waitFor({ state: 'detached' });
      await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
      expect(await page.getByRole('dialog').count()).toBe(0);

      // Equivalent allocations retain the new current image and labels while its viewer is open.
      const secondTrigger = page.getByRole('button', { name: 'Open cover: Journey B' });
      await secondTrigger.click();
      await page.getByRole('dialog', { name: 'Journey B' }).waitFor();
      const requestsBeforeBRender = mediaRequests.length;
      await updateJourney(page, wrapper, { ...first, base: 'journey-b', title: 'Journey B' });
      await page.getByRole('dialog', { name: 'Journey B' }).waitFor();
      expect(mediaRequests.length).toBe(requestsBeforeBRender);

      // A suitability replacement closes the open viewer and sends no source request until the explicit reveal.
      const requestsBeforeWithheld = mediaRequests.length;
      await updateJourney(page, wrapper, {
        ...first,
        base: 'withheld-b',
        media: 'sensitive-media',
        title: 'Withheld B',
        withheld: true,
        suitability: 'blur',
      });
      await page.getByRole('dialog', { name: 'Journey B' }).waitFor({ state: 'detached' });
      await page.locator('[data-slot="cover"][data-state="withheld"]').waitFor();
      expect(await page.locator('[data-slot="cover"] img').count()).toBe(0);
      expect(mediaRequests.length).toBe(requestsBeforeWithheld);

      await page.getByRole('button', { name: 'Show cover' }).click();
      await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
      await page.getByRole('button', { name: 'Open cover: Withheld B' }).click();
      await page.getByRole('dialog', { name: 'Withheld B' }).waitFor();
      await updateJourney(page, wrapper, {
        ...first,
        base: 'missing-b',
        title: 'Missing B',
        cover: false,
      });
      await page.getByRole('dialog', { name: 'Withheld B' }).waitFor({ state: 'detached' });
      await page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
      if (wrapper === 'subject') {
        const focusFallback = page.getByRole('group', { name: 'Missing B cover' });
        expect(await focusFallback.evaluate((element) => element === document.activeElement)).toBe(true);
      }
      expect(await page.getByRole('dialog').count()).toBe(0);

      // Removal and A-to-B-to-A do not revive the first A viewer activation.
      await updateJourney(page, wrapper, first);
      await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(kernelRequests).toEqual([]);
      expect(mediaRequests.some((request) => /\/v\d+\/|session/i.test(request))).toBe(false);
    } finally {
      await closePage(page);
    }
  }
});
