import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { observeStorybook, settle, type StoryPreview } from './screenshots.ts';
import { requireWebCheckCustody, routeWebCheck, WebCheckFailure } from './check-placement.ts';

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
  const shell = select(webEntries, 'Account/Shell', 'Signed out, account menu open');
  const signedInShell = select(webEntries, 'Account/Shell', 'Member, account menu open');
  const uiCoverCard = select(uiEntries, 'Components/Cover Card');
  const subject = select(webEntries, 'Subjects/Subject', 'Member');
  const copiesStory = select(webEntries, 'Library/Copies', 'Owner');
  const coverMedia = copies.copies?.[1]?.subject?.cover?.media;

  if (typeof coverMedia !== 'string' || !coverMedia) {
    throw new Error('The recorded second Library Copies member has no cover media.');
  }
  if (!shell || !signedInShell || !uiCoverCard || !subject || !copiesStory) {
    const summaries = {
      webStories: webEntries
        .filter((entry) => entry.type === 'story' && /^(pages|patterns)-/.test(entry.id))
        .map(({ id, title, name }) => ({ id, title, name })),
      uiTitles: uiEntries.filter((entry) => entry.type === 'story').map(({ id, title, name }) => ({ id, title, name })),
    };
    throw new Error(`A required smoke story is absent from the built index: ${JSON.stringify(summaries)}`);
  }

  return { shell, signedInShell, uiCoverCard, subject, copies: copiesStory, coverMedia };
}

export async function smokeStorybook(origin?: string, suppliedBrowser?: Browser): Promise<void> {
  const app = resolve(import.meta.dir, '..');
  const root = resolve(app, '../..');
  if (suppliedBrowser) requireWebCheckCustody(root, app);
  else {
    const routed = await routeWebCheck({
      root,
      cwd: app,
      command: ['bun', 'scripts/storybook-smoke.ts', ...(origin ? ['--origin', origin] : [])],
    });
    if (routed !== null) {
      if (routed !== 0) throw new WebCheckFailure(routed, 'Storybook smoke');
      return;
    }
  }
  const output = resolve(process.env.STORYBOOK_OUTPUT_DIR ?? `${app}/storybook-static`);
  const ownsBrowser = suppliedBrowser === undefined;
  if (!existsSync(resolve(output, 'index.json')) || !existsSync(resolve(output, 'ui/index.json')))
    throw new Error(
      'Storybook smoke unavailable: both built indexes must exist in this physical snapshot. Use storybook-deploy.ts --validate-only to build and run the six smoke scenarios together.',
    );
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
  const browser = suppliedBrowser ?? (await chromium.launch({ headless: true }));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    server = origin
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
        // Page init scripts also run in each composed ref before its preview installs the channel.
        await page.addInitScript(observeStorybook);
        const storyId = scenario.composed ? `ui_${scenario.id}` : scenario.id;
        const globals = scenario.globals ? `&globals=${encodeURIComponent(scenario.globals)}` : '';
        if (scenario.composed) {
          await page.goto(`${base}index.html`, { waitUntil: 'domcontentloaded' });
          await page.getByText('Components', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
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
        // The manager prefixes composed ids; the active ref emits its own unprefixed story id.
        const outcome = await settle(frame, scenario.id, errors, { timeout: 30_000, fonts: false });
        if (scenario.id === stories.shell.id || scenario.id === stories.signedInShell.id) {
          await frame.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 });
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
        const latest = await frame.evaluate(() => (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read());
        if (
          latest?.storyId !== scenario.id ||
          latest.renderId !== outcome.renderId ||
          latest.cycle !== outcome.cycle ||
          latest.phase !== 'finished' ||
          latest.status !== 'success'
        ) {
          throw new Error(`Story ${storyId} render outcome changed during smoke. ${latest?.errors.join(' | ') ?? ''}`);
        }
      } finally {
        await page.close();
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup: unknown[] = [];
  try {
    server?.stop(true);
  } catch (error) {
    cleanup.push(error);
  }
  if (ownsBrowser) {
    try {
      await browser.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failed && cleanup.length)
    throw new AggregateError([failure, ...cleanup], 'Storybook smoke and cleanup failed', { cause: failure });
  if (failed) throw failure;
  if (cleanup.length) throw new AggregateError(cleanup, 'Storybook smoke cleanup failed');
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--origin' || !args[1]))
      throw new Error('Usage: storybook-smoke.ts [--origin <url>]');
    await smokeStorybook(args[1]);
  } catch (error) {
    console.error(error);
    process.exitCode = error instanceof WebCheckFailure ? error.code : 1;
  }
}
