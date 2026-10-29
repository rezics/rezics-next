import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

export type SmokeStoryEntry = { id: string; title: string; name: string; type: string };
export type SmokeStoryIndex = { entries: Record<string, SmokeStoryEntry> };
export type CopyRecording = {
  copies?: Array<{ subject?: { cover?: { media?: string | null } | null } | null }>;
};
export type SmokeStories = {
  shell: SmokeStoryEntry;
  signedInShell: SmokeStoryEntry;
  uiCoverCard: SmokeStoryEntry;
  subject: SmokeStoryEntry;
  copies: SmokeStoryEntry;
  coverMedia: string;
};
type StoryPreview = {
  __STORYBOOK_PREVIEW__?: { currentRender?: { id?: string; phase?: string } };
};

export function selectSmokeStories(
  webIndex: SmokeStoryIndex,
  uiIndex: SmokeStoryIndex,
  copies: CopyRecording,
): SmokeStories {
  const select = (entries: SmokeStoryEntry[], title: string, name?: string) =>
    entries.find(
      (entry) => entry.type === 'story' && entry.title === title && (name === undefined || entry.name === name),
    );
  const webEntries = Object.values(webIndex.entries);
  const uiEntries = Object.values(uiIndex.entries);
  const shell = select(webEntries, 'Pages/Shell', 'Signed Out');
  const signedInShell = select(webEntries, 'Pages/Shell', 'Signed In');
  const uiCoverCard = select(uiEntries, 'Rezics UI/Cover Card');
  const subject = select(webEntries, 'Pages/Subject', 'Signed In');
  const copiesStory = select(webEntries, 'Pages/Library/Copies', 'Many Copies');
  const coverMedia = copies.copies?.[1]?.subject?.cover?.media;

  if (typeof coverMedia !== 'string' || !coverMedia) {
    throw new Error('The recorded second Library Copies member has no cover media.');
  }
  if (!shell || !signedInShell || !uiCoverCard || !subject || !copiesStory) {
    const summaries = {
      pages: webEntries
        .filter((entry) => entry.type === 'story' && entry.title.startsWith('Pages/'))
        .map(({ id, title, name }) => ({ id, title, name })),
      uiTitles: uiEntries.filter((entry) => entry.type === 'story').map(({ id, title, name }) => ({ id, title, name })),
    };
    throw new Error(`A required smoke story is absent from the built index: ${JSON.stringify(summaries)}`);
  }

  return { shell, signedInShell, uiCoverCard, subject, copies: copiesStory, coverMedia };
}

export async function smokeStorybook(origin?: string, suppliedBrowser?: Browser): Promise<void> {
  const app = resolve(import.meta.dir, '..');
  const output = resolve(process.env.STORYBOOK_OUTPUT_DIR ?? `${app}/storybook-static`);
  const ownsBrowser = suppliedBrowser === undefined;
  const browser = suppliedBrowser ?? (await chromium.launch({ headless: true }));
  const server = origin
    ? undefined
    : Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const pathname = decodeURIComponent(new URL(request.url).pathname);
          const filePath = resolve(output, pathname === '/' ? 'index.html' : `.${pathname}`);
          if (!filePath.startsWith(`${output}/`)) return new Response('not found', { status: 404 });
          const file = Bun.file(filePath);
          return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
        },
      });
  const base = origin ?? server!.url.toString();
  const webIndex = JSON.parse(readFileSync(resolve(output, 'index.json'), 'utf8')) as SmokeStoryIndex;
  const uiIndex = JSON.parse(readFileSync(resolve(output, 'ui/index.json'), 'utf8')) as SmokeStoryIndex;
  const copyRecording = JSON.parse(
    readFileSync(resolve(app, 'src/kernel/recorded/library-copies.json'), 'utf8'),
  ) as CopyRecording;
  const stories = selectSmokeStories(webIndex, uiIndex, copyRecording);

  const scenarios: {
    id: string;
    globals: string;
    composed: boolean;
    requiresCover: boolean;
    coverMedia?: string;
  }[] = [
    { id: stories.shell.id, globals: '', composed: false, requiresCover: false },
    { id: stories.signedInShell.id, globals: '', composed: false, requiresCover: false },
    { id: stories.uiCoverCard.id, globals: '', composed: true, requiresCover: false },
    { id: stories.shell.id, globals: 'locale:ja;theme:dark', composed: false, requiresCover: false },
    { id: stories.subject.id, globals: '', composed: false, requiresCover: false },
    { id: stories.copies.id, globals: '', composed: false, requiresCover: true, coverMedia: stories.coverMedia },
  ];
  try {
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        // A composed ref keeps an unused root preview iframe alive; check the active ref frame below.
        if (scenario.composed && !error.stack?.includes('/ui/')) return;
        errors.push(error.message);
      });
      page.on('console', (message) => {
        const location = message.location().url;
        if (scenario.composed && location && !new URL(location).pathname.startsWith('/ui/')) return;
        if (message.type() === 'error') errors.push(`${message.text()} (${location})`);
      });
      try {
        const storyId = scenario.composed ? `ui_${scenario.id}` : scenario.id;
        const globals = scenario.globals ? `&globals=${encodeURIComponent(scenario.globals)}` : '';
        if (scenario.composed) {
          await page.goto(`${base}index.html`, { waitUntil: 'domcontentloaded' });
          await page.getByText('REZICS UI', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
        }
        await page.goto(`${base}index.html?path=/story/${storyId}${globals}`, { waitUntil: 'domcontentloaded' });
        const iframe = page.locator(scenario.composed ? '#storybook-ref-ui' : '#storybook-preview-iframe');
        await iframe.waitFor({ state: 'attached', timeout: 30_000 });
        const frame = await (await iframe.elementHandle())?.contentFrame();
        if (!frame) throw new Error(`Story iframe did not load: ${storyId}`);
        await frame.locator('body').waitFor({ state: 'attached', timeout: 30_000 });
        const body = frame.locator('body');
        const errorOverlay = frame.locator('.sb-errordisplay');
        let rendered: 'ready' | 'error';
        try {
          rendered = await Promise.race([
            body.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'ready' as const),
            errorOverlay.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
          ]);
        } catch {
          const body = await frame
            .locator('body')
            .innerText()
            .catch(() => '<unavailable>');
          throw new Error(`Story ${storyId} did not render: ${body.slice(0, 2_000)}`);
        }
        if (rendered === 'error') {
          throw new Error(`Story ${storyId} failed to render: ${(await errorOverlay.innerText()).slice(0, 2_000)}`);
        }
        const phase = await frame.waitForFunction(
          (id) => {
            const render = (globalThis as StoryPreview).__STORYBOOK_PREVIEW__?.currentRender;
            return render?.id === id && (render.phase === 'finished' || render.phase === 'errored') && render.phase;
          },
          scenario.id,
          { timeout: 30_000 },
        );
        if ((await phase.jsonValue()) !== 'finished') {
          throw new Error(`Story ${storyId} failed its play function: ${errors.join('; ')}`);
        }
        if (scenario.id === stories.shell.id || scenario.id === stories.signedInShell.id) {
          await frame.getByRole('menu').waitFor({ state: 'visible', timeout: 10_000 });
        }
        if (scenario.globals) {
          await frame.locator('html[lang="ja"].dark').waitFor({ state: 'attached', timeout: 30_000 });
        }
        const images = await frame.locator('img').evaluateAll(async (elements) => {
          const images = elements as HTMLImageElement[];
          await Promise.all(
            images.map(async (image) => {
              if (!image.currentSrc && !image.src) return;
              image.loading = 'eager';
              await image.decode().catch(() => undefined);
            }),
          );
          return images
            .filter((image) => image.currentSrc || image.src)
            .map((image) => ({ src: image.currentSrc || image.src, loaded: image.naturalWidth > 0 }));
        });
        if (images.some((image) => !image.loaded)) {
          throw new Error(
            `A story image did not load: ${images
              .filter((image) => !image.loaded)
              .map((image) => image.src)
              .join(', ')}`,
          );
        }
        if (scenario.requiresCover && !images.some((image) => image.src.includes('/media/') && image.loaded)) {
          throw new Error('The recorded cover fixture did not load from /media/.');
        }
        if (
          scenario.coverMedia &&
          !images.some((image) => image.src.includes(`/media/${scenario.coverMedia}/`) && image.loaded)
        ) {
          throw new Error(`The recorded cover media ${scenario.coverMedia} did not load from /media/.`);
        }
        if (errors.length) throw new Error(`Story ${storyId} emitted browser errors: ${errors.join('; ')}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    server?.stop(true);
    if (ownsBrowser) await browser.close();
  }
}

if (import.meta.main) await smokeStorybook();
