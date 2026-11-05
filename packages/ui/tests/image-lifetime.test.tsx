import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cover, type CoverSubject, type CoverSummary } from '../src/components/cover.tsx';
import { CoverViewer } from '../src/components/cover-viewer.tsx';
import { MediaImage } from '../src/components/media-image.tsx';

type Variant = { format: string; width: number };
type ImageOutcome = { failure?: boolean; delay?: number; failureWidth?: number };
type Scenario = {
  coverBase: string;
  mediaBase: string;
  subjectId?: string;
  title?: string;
  coverMedia?: string;
  mediaMedia?: string;
  cover?: boolean;
  withheld?: boolean;
  coverVariants?: Variant[];
  mediaVariants?: Variant[];
  coverWidth?: number;
  coverHeight?: number;
  credit?: boolean;
};

const widths = [240, 480, 640] as const;
const variants = widths.map((width) => ({ format: 'webp' as const, width }));
const pageRoot = join(import.meta.dir, '../..');
let browser: Browser | undefined;
let browserBundle: Promise<string> | undefined;

const imageBody =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="12"><rect width="8" height="12" fill="#456"/></svg>';

function coverSummary(base: string, media: string, title: string, overrides: Partial<CoverSummary> = {}): CoverSummary {
  return {
    media,
    width: 1800,
    height: 1200,
    placeholder: { thumbhash: '', color: '#456' },
    variants,
    focalPoint: null,
    credit: {
      rightsHolder: `${base} rights holder for ${title}`,
      via: { name: 'Published source', url: 'https://source.test/' },
    },
    ...overrides,
  };
}

function source(base: string, media: string, format: string, width: number) {
  return `https://media.test/${base}/${media}/${format}/${width}`;
}

function serverPair(id: string, base: string, successTitle: string) {
  const subject: CoverSubject = { id: `cached-${id}`, title: successTitle, types: ['schema:Book'] };
  const cover = coverSummary(base, 'same-media', successTitle, { credit: null });
  const media = {
    media: 'same-media',
    width: 1800,
    height: 1200,
    placeholder: { color: '#456', thumbhash: 'cached-hash' },
    variants,
  };
  return createElement(
    'section',
    { key: id, 'data-cache-case': id },
    createElement(Cover, {
      subject,
      cover,
      size: 'md',
      src: (mediaId, format, width) => source(base, mediaId, format, width),
    }),
    createElement(MediaImage, {
      ...media,
      src: ({ media: mediaId, format, width }) => source(base, mediaId, format, width),
      alt: successTitle,
      sizes: '100vw',
    }),
  );
}

async function buildBrowserBundle() {
  browserBundle ??= (async () => {
    const directory = join(pageRoot, '.temp/goal/image-lifetime-browser');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'entry.tsx');
    const react = Bun.resolveSync('react', pageRoot);
    const reactDom = Bun.resolveSync('react-dom/client', pageRoot);
    const coverFile = join(pageRoot, 'packages/ui/src/components/cover.tsx');
    const viewerFile = join(pageRoot, 'packages/ui/src/components/cover-viewer.tsx');
    const mediaFile = join(pageRoot, 'packages/ui/src/components/media-image.tsx');
    const sourceCode = `
      import React, { useState } from ${JSON.stringify(react)};
      import { createRoot, hydrateRoot } from ${JSON.stringify(reactDom)};
      import { Cover } from ${JSON.stringify(coverFile)};
      import { CoverViewer } from ${JSON.stringify(viewerFile)};
      import { MediaImage } from ${JSON.stringify(mediaFile)};

      const widths = [240, 480, 640];
      const defaultVariants = widths.map((width) => ({ format: 'webp', width }));
      window.lifetimeStats = { resolverCalls: 0, activations: 0, resolved: [] };
      const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="12"><rect width="8" height="12" fill="#456"/></svg>';
      const address = (base, media, format, width) => 'https://media.test/' + base + '/' + media + '/' + format + '/' + width;
      const makeCover = (value) => value.cover === false ? null : {
        media: value.coverMedia || 'same-media',
        width: value.coverWidth || 1800,
        height: value.coverHeight || 1200,
        placeholder: { thumbhash: '', color: '#456' },
        variants: (value.coverVariants || defaultVariants).map((variant) => ({ ...variant })),
        focalPoint: null,
        credit: value.credit === false ? null : {
          rightsHolder: value.coverBase + ' rights holder',
          via: { name: 'Published source', url: 'https://source.test/' },
          license: 'CC-BY-4.0',
        },
        ...(value.withheld ? { withheld: 'suitability' } : {}),
      };
      const makeSubject = (value) => ({
        id: value.subjectId || 'subject-a',
        title: value.title || 'A cover title',
        types: value.types || ['schema:Book'],
      });
      const makeMedia = (value) => ({
        media: value.mediaMedia || 'same-media',
        width: 1800,
        height: 1200,
        placeholder: { color: '#456', thumbhash: 'media-hash' },
        variants: (value.mediaVariants || defaultVariants).map((variant) => ({ ...variant })),
      });
      function Harness({ value }) {
        const [open, setOpen] = useState(false);
        const subject = makeSubject(value);
        const cover = makeCover(value);
        const media = makeMedia(value);
        // Callers recreate these route resolvers on every render. Their returned addresses, not function identity,
        // describe the currently published image incarnation.
        const coverSrc = (mediaId, format, width) => {
          window.lifetimeStats.resolverCalls++;
          window.lifetimeStats.resolved.push([value.coverBase, format, width]);
          return address(value.coverBase, mediaId, format, width);
        };
        const mediaSrc = ({ media: mediaId, format, width }) => {
          window.lifetimeStats.resolverCalls++;
          window.lifetimeStats.resolved.push([value.mediaBase, format, width]);
          return address(value.mediaBase, mediaId, format, width);
        };
        const openViewer = () => {
          window.lifetimeStats.activations++;
          setOpen(true);
        };
        return React.createElement(React.Fragment, null,
          React.createElement('main', { id: 'lifetime-ui' },
            React.createElement('div', { 'data-testid': 'cover-wrap' },
              React.createElement(Cover, {
                subject, cover, size: 'md', src: coverSrc, suitability: 'blur',
                action: { label: 'Open cover', onActivate: openViewer },
                labels: { reveal: 'Show cover' },
              }),
            ),
            React.createElement('div', { 'data-testid': 'media-wrap' },
              React.createElement(MediaImage, {
                ...media, src: mediaSrc, alt: value.title || 'A media image', sizes: '100vw',
              }),
            ),
          ),
          cover ? React.createElement(CoverViewer, {
            subject, cover, src: coverSrc,
            labels: { title: value.title || 'A cover title', via: 'via', close: 'Close cover' },
            open, onOpenChange: setOpen,
          }) : null,
        );
      }
      let root;
      let previousValue;
      const renderCachedCases = (base) => React.createElement(React.Fragment, null,
        React.createElement('section', { key: 'success', 'data-cache-case': 'success' },
          React.createElement(Cover, {
            subject: { id: 'cached-success', title: 'Cached success', types: ['schema:Book'] },
            cover: {
              media: 'same-media', width: 1800, height: 1200,
              placeholder: { thumbhash: '', color: '#456' }, variants: defaultVariants,
              focalPoint: null, credit: null,
            }, size: 'md', src: (media, format, width) => address(base, media, format, width),
          }),
          React.createElement(MediaImage, {
            media: 'same-media', width: 1800, height: 1200,
            placeholder: { color: '#456', thumbhash: 'cached-hash' }, variants: defaultVariants,
            src: ({ media, format, width }) => address(base, media, format, width),
            alt: 'Cached success', sizes: '100vw',
          }),
        ),
        React.createElement('section', { key: 'failure', 'data-cache-case': 'failure' },
          React.createElement(Cover, {
            subject: { id: 'cached-failure', title: 'Cached failure', types: ['schema:Book'] },
            cover: {
              media: 'same-media', width: 1800, height: 1200,
              placeholder: { thumbhash: '', color: '#456' }, variants: defaultVariants,
              focalPoint: null, credit: null,
            }, size: 'md', src: (media, format, width) => address('cached-failure', media, format, width),
          }),
          React.createElement(MediaImage, {
            media: 'same-media', width: 1800, height: 1200,
            placeholder: { color: '#456', thumbhash: 'cached-hash' }, variants: defaultVariants,
            src: ({ media, format, width }) => address('cached-failure', media, format, width),
            alt: 'Cached failure', sizes: '100vw',
          }),
        ),
      );
      window.mountLifetime = (value) => {
        previousValue = value;
        root = createRoot(document.getElementById('app'));
        root.render(React.createElement(Harness, { value }));
      };
      window.updateLifetime = (value) => {
        previousValue = value;
        window.obsoleteImages = [
          document.querySelector('[data-slot="cover"] img'),
          document.querySelector('[data-slot="media-image"] img'),
        ];
        root.render(React.createElement(Harness, { value }));
      };
      window.recreateWithInvalidVariants = () => {
        window.updateLifetime({
          ...previousValue,
          coverVariants: [
            { format: 'webp', width: 640 }, { format: 'webp', width: 240 },
            { format: 'webp', width: 240 }, { format: 'webp', width: NaN },
            { format: 'webp', width: Infinity }, { format: 'webp', width: 480.5 }, { format: 'avif', width: 0 },
            { format: 'gif', width: 900 },
          ],
          mediaVariants: [
            { format: 'webp', width: 640 }, { format: 'webp', width: 240 },
            { format: 'webp', width: 240 }, { format: 'webp', width: NaN },
            { format: 'webp', width: Infinity }, { format: 'webp', width: 480.5 }, { format: 'avif', width: -1 },
            { format: 'gif', width: 900 },
          ],
        });
      };
      window.dispatchObsoleteEvents = () => {
        for (const element of window.obsoleteImages || []) {
          if (!element) continue;
          element.dispatchEvent(new Event('error'));
          element.dispatchEvent(new Event('load'));
        }
      };
      window.hydrateCachedCases = () => hydrateRoot(document.getElementById('app'), renderCachedCases('cached-success'));
    `;
    await writeFile(entry, sourceCode);
    const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
    expect(result.success, result.logs.map(String).join('\n')).toBe(true);
    return result.outputs[0]!.text();
  })();
  return browserBundle;
}

async function imagePage(outcomes: Map<string, ImageOutcome>) {
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route('https://media.test/**', async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const base = parts[1] ?? '';
    const width = Number(parts.at(-1));
    requests.push(`image:${base}`);
    const outcome = outcomes.get(base) ?? {};
    if (outcome.delay) await new Promise((resolve) => setTimeout(resolve, outcome.delay));
    try {
      await route.fulfill({
        status: outcome.failure || outcome.failureWidth === width ? 404 : 200,
        contentType: 'image/svg+xml',
        headers: { 'cache-control': 'no-store' },
        body: outcome.failure || outcome.failureWidth === width ? 'not an image' : imageBody,
      });
    } catch {
      // A replaced source may abort its pending browser request before the mock response arrives.
    }
  });
  await page.setContent('<main id="app"></main>');
  await page.addScriptTag({ content: await buildBrowserBundle() });
  return { page, requests };
}

async function update(page: Page, value: Scenario) {
  await page.evaluate((next) => {
    (window as Window & { updateLifetime: (value: unknown) => void }).updateLifetime(next);
  }, value);
}

afterAll(async () => {
  await browser?.close();
});

test('one mounted Cover, MediaImage and CoverViewer journey retires changed sources and callbacks', async () => {
  const outcomes = new Map<string, ImageOutcome>([
    ['failed-a', { failure: true }],
    ['slow-old', { failure: true, delay: 250 }],
    ['loop-a', { failure: true, delay: 0 }],
    ['loop-b', {}],
    ['removed', { failure: true }],
    ['viewer-failure', { failureWidth: 640 }],
  ]);
  const { page, requests } = await imagePage(outcomes);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('https://media.test/')) externalRequests.push(request.url());
  });
  try {
    await page.evaluate(
      (value) => {
        (window as Window & { mountLifetime: (value: unknown) => void }).mountLifetime(value);
      },
      {
        coverBase: 'failed-a',
        mediaBase: 'failed-a',
        coverMedia: 'same-media',
        mediaMedia: 'same-media',
        title: 'Original title',
      } satisfies Scenario,
    );
    await page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
    await page.locator('[data-slot="media-image"][data-state="unavailable"]').waitFor();
    expect(await page.locator('[data-slot="cover"] img').count()).toBe(0);
    expect(await page.locator('[data-slot="media-image"] img').count()).toBe(0);

    // A same-ID replacement with a new resolver result clears both failed states before the new request finishes.
    outcomes.set('same-id-b', { delay: 100 });
    await update(page, {
      coverBase: 'same-id-b',
      mediaBase: 'same-id-b',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Original title',
    });
    await page.waitForFunction(
      () => document.querySelector('[data-slot="cover"]')?.getAttribute('data-state') === 'loading',
    );
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    await page.locator('[data-slot="media-image"] img').waitFor();
    expect(await page.locator('[data-slot="cover"] img').count()).toBe(1);
    expect(await page.locator('[data-slot="media-image"][data-state="image"]').count()).toBe(1);

    await page.getByRole('button', { name: 'Open cover' }).click();
    const dialog = page.getByRole('dialog', { name: 'Original title' });
    await dialog.waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('[data-slot="cover-viewer-image"]');
      return image?.complete && image.naturalWidth > 0;
    });
    const sourceRequestsBeforeEquivalent = requests.filter((request) => request.startsWith('image:')).length;
    const resolverCallsBeforeEquivalent = await page.evaluate(
      () => (window as Window & { lifetimeStats: { resolverCalls: number } }).lifetimeStats.resolverCalls,
    );
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    // Fresh summary objects, arrays and resolver functions with equivalent sorted sources preserve load and dialog.
    await update(page, {
      coverBase: 'same-id-b',
      mediaBase: 'same-id-b',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Translated title',
      coverVariants: [
        { format: 'webp', width: 640 },
        { format: 'webp', width: 240 },
        { format: 'webp', width: 480 },
        { format: 'webp', width: 480 },
      ],
      mediaVariants: [
        { format: 'webp', width: 640 },
        { format: 'webp', width: 240 },
        { format: 'webp', width: 480 },
        { format: 'webp', width: 480 },
      ],
    });
    await page.getByRole('dialog', { name: 'Translated title' }).waitFor();
    expect(await page.locator('[data-slot="cover"]').getAttribute('data-state')).toBe('loaded');
    const sameSourceRequests = requests.filter((request) => request.startsWith('image:')).length;
    const resolverCallsAfterEquivalent = await page.evaluate(
      () => (window as Window & { lifetimeStats: { resolverCalls: number } }).lifetimeStats.resolverCalls,
    );
    expect(sameSourceRequests).toBe(sourceRequestsBeforeEquivalent);
    expect(resolverCallsAfterEquivalent - resolverCallsBeforeEquivalent).toBe(9);

    await page.getByRole('button', { name: 'Close cover' }).click();
    await page.getByRole('dialog', { name: 'Translated title' }).waitFor({ state: 'detached' });

    // An old image element and its delayed error cannot replace the currently loaded backdrop or frame.
    outcomes.set('slow-old', { failure: true, delay: 250 });
    const slowRequest = page.waitForRequest((request) => request.url().includes('/slow-old/'));
    await update(page, {
      coverBase: 'slow-old',
      mediaBase: 'slow-old',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Slow old source',
    });
    await slowRequest;
    await update(page, {
      coverBase: 'fast-current',
      mediaBase: 'fast-current',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Current source',
    });
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    await page.evaluate(() => (window as Window & { dispatchObsoleteEvents: () => void }).dispatchObsoleteEvents());
    await page.waitForTimeout(300);
    expect(await page.locator('[data-slot="cover"]').getAttribute('data-state')).toBe('loaded');
    const backdrop = await page.locator('[data-slot="cover-backdrop"]').getAttribute('style');
    expect(backdrop).toContain('/fast-current/');
    expect(backdrop).not.toContain('/slow-old/');
    expect(await page.locator('[data-slot="media-image"][data-state="image"]').count()).toBe(1);

    // A-to-B-to-A gets a new generation; the first A failure is not revived with the old summary.
    await update(page, {
      coverBase: 'loop-a',
      mediaBase: 'loop-a',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Loop A',
    });
    await page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
    await update(page, {
      coverBase: 'loop-b',
      mediaBase: 'loop-b',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Loop B',
    });
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    outcomes.set('loop-a', { delay: 100 });
    await update(page, {
      coverBase: 'loop-a',
      mediaBase: 'loop-a',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Loop A again',
    });
    await page.waitForFunction(
      () => document.querySelector('[data-slot="cover"]')?.getAttribute('data-state') === 'loading',
    );
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    await page.locator('[data-slot="media-image"][data-state="image"]').waitFor();

    // Removal and reappearance retire an old failure, including when the media identifier is unchanged.
    await update(page, {
      coverBase: 'removed',
      mediaBase: 'removed',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Removed',
    });
    await page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
    await page.locator('[data-slot="media-image"][data-state="unavailable"]').waitFor();
    await update(page, {
      coverBase: 'removed',
      mediaBase: 'removed',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      cover: false,
      mediaVariants: [],
      title: 'Removed',
    });
    await page.locator('[data-slot="cover"][data-state="placeholder"]').waitFor();
    await page.locator('[data-slot="media-image"][data-state="unavailable"]').waitFor();
    outcomes.set('removed', {});
    await update(page, {
      coverBase: 'removed',
      mediaBase: 'removed',
      coverMedia: 'same-media',
      mediaMedia: 'same-media',
      title: 'Reappeared',
    });
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    await page.locator('[data-slot="media-image"][data-state="image"]').waitFor();

    // Only finite, positive, distinct published widths are resolved or offered to the browser.
    await page.evaluate(() =>
      (window as Window & { recreateWithInvalidVariants: () => void }).recreateWithInvalidVariants(),
    );
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    const offered = await page.locator('[data-slot="cover"] img').getAttribute('srcset');
    expect(offered).toContain('240w');
    expect(offered).toContain('640w');
    expect(offered).not.toContain('NaN');
    expect(offered).not.toContain('Infinity');
    expect(offered).not.toContain('480.5w');
    expect(await page.locator('[data-slot="cover"] source').count()).toBe(1);
    const mediaOffered = await page.locator('[data-slot="media-image"] img').getAttribute('srcset');
    expect(mediaOffered).toContain('240w');
    expect(mediaOffered).toContain('640w');
    expect(mediaOffered).not.toContain('480.5w');

    // A withheld incarnation requests no image until reveal; replacement cannot inherit the prior reveal.
    await update(page, {
      coverBase: 'withheld-a',
      mediaBase: 'visible-media',
      coverMedia: 'sensitive-a',
      mediaMedia: 'plain-media',
      withheld: true,
      title: 'Withheld A',
    });
    await page.locator('[data-slot="cover"][data-state="withheld"]').waitFor();
    expect(await page.locator('[data-slot="cover"] img').count()).toBe(0);
    expect(requests).not.toContain('image:withheld-a');
    await page.getByRole('button', { name: 'Show cover' }).click();
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();
    await update(page, {
      coverBase: 'withheld-b',
      mediaBase: 'visible-media',
      coverMedia: 'sensitive-b',
      mediaMedia: 'plain-media',
      withheld: true,
      title: 'Withheld B',
    });
    await page.locator('[data-slot="cover"][data-state="withheld"]').waitFor();
    expect(await page.locator('[data-slot="cover"] img').count()).toBe(0);
    expect(requests).not.toContain('image:withheld-b');
    await page.getByRole('button', { name: 'Show cover' }).click();
    await page.locator('[data-slot="cover"][data-state="loaded"]').waitFor();

    // The viewer's largest variant may fail independently: it hides image and credit while preserving close.
    await page.getByRole('button', { name: 'Open cover' }).click();
    const openDialog = page.getByRole('dialog', { name: 'Withheld B' });
    await openDialog.waitFor();
    await openDialog.getByRole('button', { name: 'Close cover' }).click();
    await openDialog.waitFor({ state: 'detached' });
    await update(page, {
      coverBase: 'viewer-failure',
      mediaBase: 'viewer-failure',
      coverMedia: 'viewer-media',
      mediaMedia: 'viewer-media',
      title: 'Viewer failure',
      coverVariants: [
        { format: 'webp', width: 240 },
        { format: 'webp', width: 480 },
        { format: 'webp', width: 640 },
      ],
    });
    await page.getByRole('button', { name: 'Open cover' }).waitFor();
    const viewerRequest = page.waitForRequest((request) =>
      request.url().includes('/viewer-failure/viewer-media/webp/640'),
    );
    await page.getByRole('button', { name: 'Open cover' }).click();
    const failedViewer = page.getByRole('dialog', { name: 'Viewer failure' });
    await failedViewer.waitFor();
    await viewerRequest;
    await failedViewer.locator('[data-slot="cover-viewer-image"]').waitFor({ state: 'detached' });
    expect(await failedViewer.locator('[data-slot="cover-viewer-image"]').count()).toBe(0);
    expect(await failedViewer.getByText(/rights holder/i).count()).toBe(0);
    await failedViewer.getByRole('button', { name: 'Close cover' }).click();
    await failedViewer.waitFor({ state: 'detached' });

    // No kernel or session read is part of the shared image and viewer lifecycle.
    expect(externalRequests.filter((url) => /\/v\d+\/|session/i.test(url))).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as Window & { lifetimeStats: { activations: number } }).lifetimeStats.activations,
      ),
    ).toBe(3);
  } finally {
    await page.close();
  }

  const hydrationOutcomes = new Map<string, { failure?: boolean }>([['cached-failure', { failure: true }]]);
  const cached = await imagePage(hydrationOutcomes);
  try {
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        serverPair('success', 'cached-success', 'Cached success'),
        serverPair('failure', 'cached-failure', 'Cached failure'),
      ),
    );
    await cached.page.setContent(`<main id="app">${markup}</main>`);
    await cached.page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-cache-case] img')].length === 4 &&
        [...document.querySelectorAll('[data-cache-case] img')].every((image) => (image as HTMLImageElement).complete),
    );
    await cached.page.addScriptTag({ content: await buildBrowserBundle() });
    await cached.page.evaluate(() => (window as Window & { hydrateCachedCases: () => void }).hydrateCachedCases());
    await cached.page.locator('[data-cache-case="success"] [data-slot="cover"][data-state="loaded"]').waitFor();
    await cached.page.locator('[data-cache-case="failure"] [data-slot="cover"][data-state="placeholder"]').waitFor();
    expect(
      await cached.page.locator('[data-cache-case="success"] [data-slot="media-image"]').getAttribute('data-state'),
    ).toBe('image');
    expect(
      await cached.page.locator('[data-cache-case="failure"] [data-slot="media-image"]').getAttribute('data-state'),
    ).toBe('unavailable');
  } finally {
    await cached.page.close();
  }
}, 60_000);
