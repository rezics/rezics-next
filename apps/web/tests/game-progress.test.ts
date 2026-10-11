import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect as browserExpect, type Browser, type Page } from 'playwright/test';
import type { MainClient } from '../features/discover/types.ts';
import type { EpisodeProgress } from '../features/tracking/episode-api.ts';
import { mainTrackingApi } from '../features/tracking/api.ts';
import type { MediaApi } from '../features/tracking/media-api.ts';
import type { RouteRef } from '../features/tracking/media.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const part = (index: number, required = true): RouteRef => ({ structure,
  occurrence: `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  label: `Part ${index}`, required });
const parts = (count: number) => Array.from({ length: count }, (_, index) => part(index + 1));
const completed: EpisodeProgress = { completed: true, position: 'completed', version: 1 };

interface Fixture {
  parts: RouteRef[];
  marks?: [string, EpisodeProgress][];
  failPage?: string;
  failRead?: string;
  failWrite?: string;
  staleWrite?: string;
  delay?: number;
  emptyFirst?: boolean;
}
interface TestWindow {
  renderGame(api: MediaApi, key: number): void;
  game: {
    api: MediaApi;
    rows: Map<string, EpisodeProgress>;
    writes: string[];
    pages: (string | null)[];
    failRead?: string;
    key: number;
  };
}

describe('game progress component', () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;

  beforeAll(async () => {
    const scratch = resolve('.temp/game-progress-component');
    await mkdir(scratch, { recursive: true });
    const entry = resolve(scratch, 'mount.tsx');
    // Use the real React renderer and controls, without adding a separate DOM implementation.
    await writeFile(entry, `import { createRoot } from 'react-dom/client';
import { GameProgress } from ${JSON.stringify(resolve('apps/web/features/tracking/game-progress.tsx'))};
import { copyOf } from ${JSON.stringify(resolve('apps/web/features/tracking/messages.ts'))};
const root = createRoot(document.getElementById('root'));
window.renderGame = (api, key) => root.render(<GameProgress key={key} work=${JSON.stringify(work)} api={api} t={copyOf('en')} />);
`);
    const built = await Bun.build({ entrypoints: [entry], target: 'browser', define: { 'process.env.NODE_ENV': '"development"' } });
    if (!built.success) throw new Error(built.logs.join('\n'));
    bundle = await built.outputs[0]!.text();
    browser = await chromium.launch({ headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ type: 'module', content: bundle });
    await page.waitForFunction(() => 'renderGame' in window);
  });
  afterEach(async () => { await page?.close(); });

  async function mount(fixture: Fixture) {
    await page.evaluate(fixture => {
      const target = window as unknown as TestWindow;
      const game: TestWindow['game'] = { api: {} as MediaApi, rows: new Map(fixture.marks ?? []),
        writes: [], pages: [], failRead: fixture.failRead, key: 0 };
      let failPage = fixture.failPage;
      let failWrite = fixture.failWrite;
      let staleWrite = fixture.staleWrite;
      game.api = {
        routes: async (_work, after) => {
          game.pages.push(after ?? null);
          if (after === failPage && failPage !== undefined) {
            failPage = undefined;
            return { ok: false, failure: 'sign-in' };
          }
          if (!after && fixture.emptyFirst) return { ok: true, data: { items: [], next: '20' } };
          const start = after ? Number(after) : 0;
          return { ok: true, data: { items: fixture.parts.slice(start, start + 20),
            next: start + 20 < fixture.parts.length ? String(start + 20) : null } };
        },
        progress: async route => route.occurrence === game.failRead
          ? { ok: false, failure: 'sign-in' }
          : { ok: true, data: game.rows.get(route.occurrence) ?? { completed: false, position: null, version: 0 } },
        mark: async (route, change) => {
          game.writes.push(route.occurrence);
          if (fixture.delay) await new Promise(done => setTimeout(done, fixture.delay));
          if (route.occurrence === failWrite) { failWrite = undefined; return { ok: false, failure: 'unavailable' }; }
          if (route.occurrence === staleWrite) {
            staleWrite = undefined;
            const current = { completed: false, position: 'played', version: 2 };
            game.rows.set(route.occurrence, current);
            return { ok: false, failure: 'stale', current, submitted: { ...change, position: change.position ?? null } };
          }
          const saved = { completed: change.completed, position: change.position ?? null,
            version: (game.rows.get(route.occurrence)?.version ?? 0) + 1 };
          game.rows.set(route.occurrence, saved);
          return { ok: true, data: saved };
        },
      } as MediaApi;
      target.game = game;
      target.renderGame(game.api, game.key);
    }, fixture);
    await browserExpect(page.locator('[data-game-progress], [role="alert"]')).toBeVisible();
  }
  const state = () => page.locator('[data-game-progress]');
  const row = (id: string) => page.locator(`[data-route="${id}"]`);
  const writes = () => page.evaluate(() => (window as unknown as TestWindow).game.writes);
  const reload = async () => {
    const before = await page.evaluate(() => (window as unknown as TestWindow).game.pages.length);
    await page.evaluate(() => {
      const target = window as unknown as TestWindow;
      target.renderGame(target.game.api, ++target.game.key);
    });
    await page.waitForFunction(before => (window as unknown as TestWindow).game.pages.length > before, before);
    await browserExpect(page.locator('[data-selected]')).toHaveCount(0);
    await browserExpect(state()).toBeVisible();
  };

  test('required parts past 20 are reachable without optional routes; a completed page is only played', async () => {
    const all = parts(45);
    await mount({ parts: all, marks: all.slice(0, 20).map(route => [route.occurrence, completed]) });
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(page.locator('[data-routes]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[39]!.occurrence)).toBeVisible();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[44]!.occurrence)).toBeVisible();
    await browserExpect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    await row(all[44]!.occurrence).click();
    await browserExpect(page.locator('[data-selected]')).toContainText('Not played yet');
  });

  test('whole-game completion discovers all required parts before writing and leaves optional routes alone', async () => {
    const all = [...parts(45), part(46, false)];
    await mount({ parts: all });
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual(all.filter(route => route.required).map(route => route.occurrence));
    await browserExpect(row(all[45]!.occurrence)).toHaveAttribute('data-route-state', 'none');
    await reload();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[39]!.occurrence)).toBeVisible();
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
  });

  test('a later page failure prevents every whole-game write and permits retry', async () => {
    const all = parts(45);
    await mount({ parts: all, failPage: '40' });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    expect(await writes()).toEqual([]);
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    await browserExpect(row(all[39]!.occurrence)).toBeVisible();
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toHaveLength(45);
  });

  test('whole-game Played reaches a required part beyond an optional-only page and survives reloading that page', async () => {
    const all = [...parts(20).map(route => ({ ...route, required: false })), part(21), part(22)];
    await mount({ parts: all });
    await page.getByRole('button', { name: 'Mark played', exact: true }).click();
    await browserExpect(row(all[20]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    expect(await writes()).toEqual([all[20]!.occurrence]);
    await reload();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(row(all[20]!.occurrence)).toHaveAttribute('data-route-state', 'played');
  });

  test('a failed required-part progress read cannot turn a partial inventory into completed', async () => {
    const all = parts(21);
    await mount({ parts: all, marks: all.slice(0, 20).map(route => [route.occurrence, completed]), failRead: all[20]!.occurrence });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    expect(await writes()).toEqual([]);
    await page.evaluate(() => { (window as unknown as TestWindow).game.failRead = undefined; });
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[20]!.occurrence)).toHaveAttribute('data-route-state', 'none');
  });

  test('unfinished play on a later required part survives reload and a repeated Played keeps its position', async () => {
    const all = parts(3);
    await mount({ parts: all });
    await row(all[1]!.occurrence).click();
    const selected = page.locator('[data-selected]');
    await browserExpect(selected).toContainText('Not played yet');
    await selected.getByRole('button', { name: 'Mark played', exact: true }).click();
    await browserExpect(row(all[1]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    await reload();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(row(all[1]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    await page.getByRole('button', { name: 'Mark played', exact: true }).click();
    expect(await writes()).toEqual([all[1]!.occurrence]);
  });

  test('earlier successful writes remain visible after a later failure and retry finishes the remainder', async () => {
    const all = parts(3);
    await mount({ parts: all, failWrite: all[1]!.occurrence });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(row(all[0]!.occurrence)).toHaveAttribute('data-route-state', 'completed');
    await browserExpect(row(all[1]!.occurrence)).toHaveAttribute('data-route-state', 'none');
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual([all[0]!.occurrence, all[1]!.occurrence, all[1]!.occurrence, all[2]!.occurrence]);
    await browserExpect(page.getByRole('status')).toBeEmpty();
  });

  test('partial undo also preserves each successful write and shows the later failure', async () => {
    const all = parts(3);
    await mount({ parts: all, marks: all.map(route => [route.occurrence, completed]), failWrite: all[1]!.occurrence });
    await page.getByRole('button', { name: 'Mark not completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(row(all[0]!.occurrence)).toHaveAttribute('data-route-state', 'none');
    await browserExpect(row(all[1]!.occurrence)).toHaveAttribute('data-route-state', 'completed');
  });

  test('a stale later write shows the conflict beside earlier success, and keeping mine does not hide either part', async () => {
    const all = parts(2);
    await mount({ parts: all, staleWrite: all[1]!.occurrence });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByText('Changed on another device')).toBeVisible();
    await browserExpect(row(all[0]!.occurrence)).toHaveAttribute('data-route-state', 'completed');
    await browserExpect(row(all[1]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    await page.getByRole('button', { name: 'Keep my change' }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
  });

  test('the save lock spans every write rather than enabling a second batch between writes', async () => {
    const all = parts(3);
    await mount({ parts: all, delay: 100 });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('button').first()).toBeDisabled();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual(all.map(route => route.occurrence));
  });

  test('an empty filtered page still exposes its continuation', async () => {
    const all = parts(21);
    await mount({ parts: all, emptyFirst: true });
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[20]!.occurrence)).toBeVisible();
  });
});

describe('game progress tracking adapter', () => {
  test('parts keep their cursor and required inclusion; occurrence reads retain unfinished play', async () => {
    const all = parts(25);
    const asked: unknown[] = [];
    const client = { v1: {
      resources: ({ resource }: { resource: string }) => {
        expect(resource).toBe(work.split('/').at(-1)!);
        return { parts: { get: async ({ query }: { query: { after?: string } }) => {
          asked.push(query);
          const start = query.after ? Number(query.after) : 0;
          return { error: null, data: { structure, next: start ? null : '20',
            parts: all.slice(start, start + 20).map((route, index) => ({ ...route, role: 'part',
              displayLabel: route.label, inclusion: start && index === 0 ? 'optional' : start && index === 1 ? 'extra' : 'required' })) } };
        } } };
      },
      compositions: () => ({ occurrences: ({ occurrence }: { occurrence: string }) => ({ progress: {
        get: async ({ query }: { query: unknown }) => {
          asked.push({ occurrence, query });
          return { error: null, data: { completed: false, position: 'played', version: 7 } };
        },
      } }) }),
    } } as unknown as MainClient;
    const api = mainTrackingApi('reader', () => client).media!;
    const first = await api.routes(work);
    expect(first.ok && first.data.items).toHaveLength(20);
    expect(first.ok && first.data.next).toBe('20');
    const last = await api.routes(work, '20');
    expect(last.ok && last.data.items.map(route => route.required)).toEqual([false, false, true, true, true]);
    expect(last.ok && last.data.next).toBeNull();
    expect(await api.progress(all[1]!)).toEqual({ ok: true, data: { completed: false, position: 'played', version: 7 } });
    expect(asked).toEqual([
      { actingSubject: 'reader', limit: 20 }, { actingSubject: 'reader', limit: 20, after: '20' },
      { occurrence: all[1]!.occurrence.split('/').at(-1)!, query: { actingSubject: 'reader' } },
    ]);
  });

  test('a denied occurrence read remains a failure rather than unplayed progress', async () => {
    const client = { v1: { compositions: () => ({ occurrences: () => ({ progress: {
      get: async () => ({ data: null, error: { status: 403, value: {} } }),
    } }) }) } } as unknown as MainClient;
    const api = mainTrackingApi('reader', () => client).media!;
    expect(await api.progress(part(2))).toEqual({ ok: false, failure: 'sign-in' });
  });
});
