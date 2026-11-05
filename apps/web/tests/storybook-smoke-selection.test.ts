import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Browser } from 'playwright';
import { observeStorybook, type StoryPreview } from '../scripts/screenshots.ts';
import {
  selectSmokeStories,
  smokeStorybook,
  type CopyRecording,
  type SmokeStoryEntry,
  type SmokeStoryIndex,
} from '../scripts/storybook-smoke.ts';

const app = resolve(import.meta.dir, '..');

function readRecording<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(app, 'src/kernel/recorded', name), 'utf8')) as T;
}

function story(id: string, title: string, name: string): SmokeStoryEntry {
  return { id, title, name, type: 'story' };
}

const webIndex: SmokeStoryIndex = {
  entries: Object.fromEntries(
    [
      story('pages-subjects-subject--count-unavailable', 'Pages/Subjects/Subject', 'Count Unavailable'),
      story('pages-subjects-subject--signed-in', 'Pages/Subjects/Subject', 'Member'),
      story('pages-library-copies--none', 'Pages/Library/Copies', 'None'),
      story('pages-library-copies--many-copies', 'Pages/Library/Copies', 'Owner'),
      story('patterns-account-shell--signed-out', 'Patterns/Account/Shell', 'Signed out, account menu open'),
      story('patterns-account-shell--member-account-menu-open', 'Patterns/Account/Shell', 'Member, account menu open'),
    ].map((entry) => [entry.id, entry] as const),
  ),
};
const uiIndex: SmokeStoryIndex = {
  entries: {
    'components-cover-card--default': story('components-cover-card--default', 'Components/Cover Card', 'Default'),
  },
};

test('selects named full-page stories for the null-cover subject and recorded-cover copy', () => {
  const subjectPage = readRecording<{
    reads: { r0?: { body?: { summary?: { cover?: unknown } | null } } };
  }>('subject-page.json');
  const copyRecording = readRecording<CopyRecording>('library-copies.json');
  const stories = selectSmokeStories(webIndex, uiIndex, copyRecording);

  expect(subjectPage.reads.r0?.body?.summary?.cover).toBeNull();
  expect(stories.shell.id).toBe('patterns-account-shell--signed-out');
  expect(stories.signedInShell.id).toBe('patterns-account-shell--member-account-menu-open');
  expect(stories.uiCoverCard.id).toBe('components-cover-card--default');
  expect(stories.subject.id).toBe('pages-subjects-subject--signed-in');
  expect(stories.copies.id).toBe('pages-library-copies--many-copies');
  expect(stories.coverMedia).toBe(copyRecording.copies?.[1]?.subject?.cover?.media);
});

test('requires a recorded covered member for the positive media scenario', () => {
  const noCoverRecording: CopyRecording = { copies: [{ subject: { cover: null } }] };
  expect(() => selectSmokeStories(webIndex, uiIndex, noCoverRecording)).toThrow(
    'The recorded second Library Copies member has no cover media.',
  );
});

async function publicationSmoke(failure?: string, failedScenario = 2) {
  const root = resolve(app, '../..');
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const output = mkdtempSync(resolve(root, '.temp/smoke-outcome-'));
  mkdirSync(resolve(output, 'ui'));
  writeFileSync(resolve(output, 'index.json'), JSON.stringify(webIndex));
  writeFileSync(resolve(output, 'ui/index.json'), JSON.stringify(uiIndex));
  const previousOutput = process.env.STORYBOOK_OUTPUT_DIR;
  process.env.STORYBOOK_OUTPUT_DIR = output;
  const visits: string[] = [];
  const assertions: string[] = [];
  let opened = 0;
  let closed = 0;
  const coverMedia = readRecording<CopyRecording>('library-copies.json').copies![1]!.subject!.cover!.media!;
  const browser = {
    newPage: async () => {
      const index = opened++;
      let init: (() => void) | undefined;
      const frames = new Map<string, ReturnType<typeof preview>>();
      const preview = (id: string, issue?: string) => {
        const render = { id, renderId: index + 1, phase: 'preparing', abortController: new AbortController() };
        const scope: StoryPreview = { __STORYBOOK_PREVIEW__: { currentRender: render } };
        const microtasks: (() => void)[] = [];
        const listeners = new Map<string, ((data: unknown) => void)[]>();
        const evaluate = async (fn: Function, arg?: unknown) =>
          runInNewContext(`(${fn.toString()})(arg)`, { ...scope, arg });
        // The init script executes before this frame assigns its real preview channel.
        runInNewContext(`(${init!.toString()})()`, {
          get globalThis() {
            return scope;
          },
          queueMicrotask: (callback: () => void) => microtasks.push(callback),
        });
        scope.__STORYBOOK_ADDONS_CHANNEL__ = {
          on: (event: string, listener: (data: unknown) => void) =>
            listeners.set(event, [...(listeners.get(event) ?? []), listener]),
        };
        const emit = (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data));
        const phase = (newPhase: string, renderId = render.renderId) => {
          render.phase = newPhase;
          emit('storyRenderPhaseChanged', { storyId: id, renderId, newPhase });
        };
        phase('loading');
        if (issue === 'overlap') phase('loading');
        phase('finished', issue === 'render' ? 999 : render.renderId);
        if (issue === 'late') microtasks.splice(0).forEach((callback) => callback());
        if (issue !== 'missing')
          emit('storyFinished', {
            storyId: issue === 'story' ? `ui_${id}` : id,
            status: issue === 'error' ? 'error' : 'success',
            reporters:
              issue === 'reporter'
                ? [{ type: 'interaction', status: 'failed', result: { message: 'Expected enabled Save' } }]
                : [],
          });
        if (issue === 'stale') scope.__STORYBOOK_PREVIEW__!.currentRender = { ...render, renderId: 999 };
        if (issue === 'aborted') render.abortController.abort();
        return {
          evaluate,
          waitForFunction: async (fn: Function, arg: unknown, options: { timeout: number }) => {
            expect(options.timeout).toBe(30_000);
            const value = await evaluate(fn, arg);
            if (!value) throw new Error('Synthetic readiness timeout');
            return { jsonValue: async () => value };
          },
          getByRole: (role: string) => ({
            waitFor: async () => {
              assertions.push(`${index}:${role}`);
            },
          }),
          locator: (selector: string) => ({
            waitFor: async () => {
              if (selector === '.sb-errordisplay') return new Promise(() => {});
              if (selector.startsWith('html')) assertions.push(`${index}:${selector}`);
            },
            evaluateAll: async (fn: Function) =>
              fn([
                {
                  currentSrc: `https://storybook.invalid/media/${coverMedia}/cover.webp`,
                  naturalWidth: 64,
                  decode: async () => {
                    assertions.push(`${index}:decoded`);
                    if (issue === 'changed') emit('updateStoryArgs', { storyId: id });
                  },
                },
              ]),
          }),
        };
      };
      return {
        on: () => undefined,
        addInitScript: async (fn: () => void) => {
          expect(fn).toBe(observeStorybook);
          init = fn;
        },
        goto: async (url: string) => {
          expect(init).toBeDefined();
          const selected = new URL(url).searchParams.get('path')?.slice('/story/'.length);
          if (!selected) return;
          visits.push(selected);
          const composed = selected.startsWith('ui_');
          // An inactive root error must not poison a successful ref, nor its success rescue a failed ref.
          frames.set(
            '#storybook-preview-iframe',
            preview(
              composed ? selected.slice(3) : selected,
              composed ? (failure ? undefined : 'error') : index === failedScenario ? failure : undefined,
            ),
          );
          if (composed)
            frames.set('#storybook-ref-ui', preview(selected.slice(3), index === failedScenario ? failure : undefined));
        },
        getByText: () => ({ waitFor: async () => undefined }),
        locator: (selector: string) => ({
          waitFor: async () => undefined,
          elementHandle: async () => ({ contentFrame: async () => frames.get(selector) }),
        }),
        close: async () => {
          closed++;
        },
      };
    },
  };
  try {
    await smokeStorybook('https://storybook.invalid/', browser as unknown as Browser);
    return { visits, assertions, coverMedia };
  } finally {
    expect(closed).toBe(opened);
    if (previousOutput === undefined) delete process.env.STORYBOOK_OUTPUT_DIR;
    else process.env.STORYBOOK_OUTPUT_DIR = previousOutput;
    rmSync(output, { recursive: true, force: true });
  }
}

test('publication smoke keeps all six scenario assertions with independent finished-success composed outcomes', async () => {
  const { visits, assertions } = await publicationSmoke();
  expect(visits).toEqual([
    webIndex.entries['patterns-account-shell--signed-out']!.id,
    webIndex.entries['patterns-account-shell--member-account-menu-open']!.id,
    'ui_components-cover-card--default',
    webIndex.entries['patterns-account-shell--signed-out']!.id,
    webIndex.entries['pages-subjects-subject--signed-in']!.id,
    webIndex.entries['pages-library-copies--many-copies']!.id,
  ]);
  expect(assertions.filter((entry) => entry.endsWith(':dialog'))).toEqual(['0:dialog', '1:dialog', '3:dialog']);
  expect(assertions).toContain('3:html[lang="ja"].dark');
  expect(assertions.filter((entry) => entry.endsWith(':decoded'))).toEqual(
    [0, 1, 2, 3, 4, 5].map((index) => `${index}:decoded`),
  );
});

test('publication smoke rejects finished error, missing, mismatched and stale outcomes in main and active composed frames', async () => {
  for (const issue of [
    'error',
    'reporter',
    'missing',
    'story',
    'render',
    'late',
    'stale',
    'aborted',
    'overlap',
    'changed',
  ]) {
    for (const failedScenario of [0, 2]) {
      await expect(publicationSmoke(issue, failedScenario)).rejects.toThrow(
        issue === 'changed' ? 'render outcome changed during smoke' : 'did not finish rendering successfully',
      );
    }
  }
});
