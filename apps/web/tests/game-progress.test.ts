import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect as browserExpect, type Browser, type Page } from 'playwright/test';
import type { MainClient } from '../features/discover/types.ts';
import type { EpisodeProgress } from '../features/tracking/episode-api.ts';
import { mainTrackingApi } from '../features/tracking/api.ts';
import { GAME_PART_PAGE_LIMIT, type MediaApi } from '../features/tracking/media-api.ts';
import type { RouteRef } from '../features/tracking/media.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const part = (index: number, required = true): RouteRef => ({ structure,
  occurrence: `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  label: `Part ${index}`, required });
const parts = (count: number) => Array.from({ length: count }, (_, index) => part(index + 1));
const completed: EpisodeProgress = { completed: true, position: 'completed', version: 1 };
const revision = part(9000).occurrence;
type InventoryItem = { occurrence: string; role: 'part' | 'group'; displayLabel: string; inclusion: 'required' | 'optional' };
type InventoryLevel = { parent: string | null; items: InventoryItem[] };
const inventoryPart = (route: RouteRef): InventoryItem => ({ occurrence: route.occurrence,
  role: 'part', displayLabel: route.label, inclusion: route.required ? 'required' : 'optional' });
const group = (index: number): InventoryItem => ({ ...inventoryPart(part(index)), role: 'group' });

interface Fixture {
  parts: RouteRef[];
  marks?: [string, EpisodeProgress][];
  failPage?: string;
  failRead?: string;
  failWrite?: string;
  staleWrite?: string;
  delay?: number;
  emptyFirst?: boolean;
  levels?: InventoryLevel[];
  failParent?: string;
}
interface TestWindow {
  renderGame(api: MediaApi, key: number, work?: string): void;
  inventoryApi(client: MainClient): MediaApi;
  lifecycle: {
    started: boolean; bStarted: boolean;
    calls: { kind: 'routes' | 'progress' | 'mark'; owner: 'A' | 'B'; id: string }[];
    switch(): void; release(): Promise<void>; releaseB(): Promise<void>;
  };
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
import { mainTrackingApi } from ${JSON.stringify(resolve('apps/web/features/tracking/api.ts'))};
const root = createRoot(document.getElementById('root'));
window.inventoryApi = client => mainTrackingApi('reader', () => client).media;
window.renderGame = (api, key, work = ${JSON.stringify(work)}) => root.render(<GameProgress key={key} work={work} api={api} t={copyOf('en')} />);
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
      if (fixture.levels) {
        const client = { v1: { resources: () => ({ parts: {
          get: async ({ query }: { query: { parent?: string; after?: string; limit: number } }) => {
            game.pages.push(JSON.stringify(query));
            if (query.parent === fixture.failParent && fixture.failParent !== undefined) {
              return { data: null, error: { status: 403, value: {} } };
            }
            const items = fixture.levels!.find(level => level.parent === (query.parent ?? null))!.items;
            const start = Number(query.after ?? 0);
            return { error: null, data: { structure: fixture.parts[0]!.structure,
              revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000009010',
              parts: items.slice(start, start + query.limit),
              next: start + query.limit < items.length ? String(start + query.limit) : null } };
          },
        } }) } } as unknown as MainClient;
        game.api.routes = target.inventoryApi(client).routes;
      }
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

  async function pendingSwitch(options: {
    phase: 'initial' | 'page' | 'page-progress' | 'selected' | 'write';
    boundary?: 'work' | 'api'; outcome?: 'success' | 'failure' | 'stale' | 'throw'; holdB?: boolean;
  }) {
    const a = parts(22), b = [part(51), part(52)].map(route => ({ ...route, structure: part(9003).occurrence }));
    await page.evaluate(({ options, a, b, work }) => {
      const target = window as unknown as TestWindow;
      const otherWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
      let resolveA!: () => void, resolveB!: () => void;
      const gateA = new Promise<void>(done => { resolveA = done; });
      const gateB = new Promise<void>(done => { resolveB = done; });
      const rows = new Map<string, EpisodeProgress>([[b[1]!.occurrence,
        { completed: false, position: 'checkpoint', version: 7 }]]);
      const counts = new Map<string, number>();
      const lifecycle: TestWindow['lifecycle'] = {
        started: false, bStarted: false, calls: [], switch: () => {},
        release: async () => { resolveA(); await frames(); },
        releaseB: async () => { resolveB(); await frames(); },
      };
      async function frames() {
        // Let the retired promise and React's resulting work settle without timing-based sleeps.
        await new Promise<void>(done => requestAnimationFrame(() => done()));
        await new Promise<void>(done => requestAnimationFrame(() => done()));
      }
      async function hold() { lifecycle.started = true; await gateA; }
      function result(id: string) { return rows.get(id) ?? { completed: false, position: null, version: 0 }; }
      function client(replacement = false): MediaApi {
        return {
          routes: async (requestedWork, after) => {
            const owner = replacement || requestedWork === otherWork ? 'B' : 'A';
            lifecycle.calls.push({ kind: 'routes', owner, id: after ?? 'root' });
            if (owner === 'A' && (options.phase === 'initial' || options.phase === 'page' && after)) {
              await hold();
              if (options.outcome === 'failure') return { ok: false, failure: 'sign-in' };
            }
            const all = owner === 'A' ? a : b, start = Number(after ?? 0);
            return { ok: true, data: { items: all.slice(start, start + 20), next: start + 20 < all.length ? '20' : null } };
          },
          progress: async route => {
            const owner = route.structure === b[0]!.structure ? 'B' : 'A';
            lifecycle.calls.push({ kind: 'progress', owner, id: route.occurrence });
            const count = (counts.get(route.occurrence) ?? 0) + 1;
            counts.set(route.occurrence, count);
            if (owner === 'A' && (options.phase === 'page-progress' && route.occurrence === a[20]!.occurrence
              || options.phase === 'selected' && route.occurrence === a[0]!.occurrence && count === 2)) {
              await hold();
              if (options.outcome === 'failure') return { ok: false, failure: 'sign-in' };
            }
            return { ok: true, data: result(route.occurrence) };
          },
          mark: async (route, change) => {
            const owner = route.structure === b[0]!.structure ? 'B' : 'A';
            lifecycle.calls.push({ kind: 'mark', owner, id: route.occurrence });
            if (owner === 'A') {
              await hold();
              if (options.outcome === 'failure') return { ok: false, failure: 'unavailable' };
              if (options.outcome === 'throw') throw new Error('Lost old-work response');
              if (options.outcome === 'stale') return { ok: false, failure: 'stale', current: result(route.occurrence),
                submitted: { ...change, position: change.position ?? null } };
            } else if (options.holdB && route.occurrence === b[0]!.occurrence) {
              lifecycle.bStarted = true;
              await gateB;
            }
            const saved = { completed: change.completed, position: change.position ?? null, version: result(route.occurrence).version + 1 };
            rows.set(route.occurrence, saved);
            return { ok: true, data: saved };
          },
        } as MediaApi;
      }
      const original = client();
      lifecycle.switch = () => target.renderGame(options.boundary === 'api' ? client(true) : original,
        0, options.boundary === 'api' ? work : otherWork);
      target.lifecycle = lifecycle;
      target.renderGame(original, 0, work);
    }, { options, a, b, work });
    if (options.phase !== 'initial') await browserExpect(row(a[0]!.occurrence)).toBeVisible();
    return { a, b };
  }
  async function switchToB(b: RouteRef[]) {
    await page.waitForFunction(() => (window as unknown as TestWindow).lifecycle.started);
    await page.evaluate(() => (window as unknown as TestWindow).lifecycle.switch());
    await browserExpect(row(b[1]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await browserExpect(page.getByRole('button', { name: 'Mark completed', exact: true })).toBeEnabled();
  }
  async function releaseA() { await page.evaluate(() => (window as unknown as TestWindow).lifecycle.release()); }
  async function onlyB(b: RouteRef[], aCalls: number) {
    await browserExpect(page.locator('[data-route]')).toHaveCount(b.length);
    await browserExpect(row(b[0]!.occurrence)).toHaveAttribute('data-route-state', 'none');
    await browserExpect(row(b[1]!.occurrence)).toHaveAttribute('data-route-state', 'played');
    await browserExpect(page.getByRole('status')).toBeEmpty();
    await browserExpect(page.getByText('Changed on another device')).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as TestWindow).lifecycle.calls.filter(call => call.owner === 'A').length)).toBe(aCalls);
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await page.evaluate(() => (window as unknown as TestWindow).lifecycle.calls
      .filter(call => call.owner === 'B' && call.kind === 'mark').map(call => call.id))).toEqual(b.map(route => route.occurrence));
  }
  const aCallCount = () => page.evaluate(() => (window as unknown as TestWindow).lifecycle.calls.filter(call => call.owner === 'A').length);

  for (const boundary of ['work', 'api'] as const) {
    for (const action of ['whole-game', 'show-more'] as const) {
      test(`${boundary} switch during a pending ${action} page keeps the new inventory and next action`, async () => {
        const { b } = await pendingSwitch({ phase: 'page', boundary });
        await page.getByRole('button', { name: action === 'whole-game' ? 'Mark completed' : 'Show more', exact: true }).click();
        await switchToB(b);
        const calls = await aCallCount();
        await releaseA();
        await onlyB(b, calls);
      });
    }
    for (const outcome of ['success', 'failure', 'stale', 'throw'] as const) {
      test(`${boundary} switch during a whole-game write drops its ${outcome} result and stops remaining writes`, async () => {
        const { b } = await pendingSwitch({ phase: 'write', boundary, outcome });
        await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
        await switchToB(b);
        const calls = await aCallCount();
        await releaseA();
        await onlyB(b, calls);
      });
    }
    test(`${boundary} switch isolates the new save lock from the old write's finally`, async () => {
      const { b } = await pendingSwitch({ phase: 'write', boundary, holdB: true });
      await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
      await switchToB(b);
      const calls = await aCallCount();
      await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
      await page.waitForFunction(() => (window as unknown as TestWindow).lifecycle.bStarted);
      await releaseA();
      await browserExpect(page.getByRole('button').first()).toBeDisabled();
      await browserExpect(row(b[0]!.occurrence)).toBeDisabled();
      expect(await aCallCount()).toBe(calls);
      await page.evaluate(() => (window as unknown as TestWindow).lifecycle.releaseB());
      await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
      expect(await page.evaluate(() => (window as unknown as TestWindow).lifecycle.calls
        .filter(call => call.owner === 'B' && call.kind === 'mark').map(call => call.id))).toEqual(b.map(route => route.occurrence));
    });
  }
  for (const phase of ['initial', 'page-progress', 'selected'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`work switch drops pending ${phase} ${outcome} without changing new progress or errors`, async () => {
        const { a, b } = await pendingSwitch({ phase, outcome });
        if (phase === 'page-progress') await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
        if (phase === 'selected') await row(a[0]!.occurrence).click();
        await switchToB(b);
        await row(b[1]!.occurrence).click();
        await browserExpect(page.locator('[data-selected]')).toContainText('Played');
        const calls = await aCallCount();
        await releaseA();
        await browserExpect(page.locator('[data-selected]')).toHaveAttribute('data-selected', b[1]!.occurrence);
        await browserExpect(page.locator('[data-selected]')).toContainText('Played');
        await browserExpect(page.locator('[data-route]')).toHaveCount(2);
        await browserExpect(page.getByRole('status')).toBeEmpty();
        expect(await aCallCount()).toBe(calls);
        await state().getByRole('button', { name: 'Mark completed', exact: true }).first().click();
        await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
        expect(await page.evaluate(() => (window as unknown as TestWindow).lifecycle.calls
          .filter(call => call.owner === 'B' && call.kind === 'mark').map(call => call.id))).toEqual(b.map(route => route.occurrence));
      });
    }
  }

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

  test('a completed root part cannot hide a required grouped part; the child remains reachable', async () => {
    const [a, b] = parts(2) as [RouteRef, RouteRef];
    const branch = group(100);
    await mount({ parts: [a, b], marks: [[a.occurrence, completed]], levels: [
      { parent: null, items: [inventoryPart(a), branch] },
      { parent: branch.occurrence, items: [inventoryPart(b)] },
    ] });
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(b.occurrence)).toBeVisible();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await row(b.occurrence).click();
    await browserExpect(page.locator('[data-selected]')).toContainText('Not played yet');
    await reload();
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual([b.occurrence]);
  });

  test('whole-game completion traverses nested groups before writing required parts', async () => {
    const [a, b, c] = parts(3) as [RouteRef, RouteRef, RouteRef];
    const outer = group(100), inner = group(101);
    await mount({ parts: [a, b, c], levels: [
      { parent: null, items: [inventoryPart(a), outer] },
      { parent: outer.occurrence, items: [inventoryPart(b), inner] },
      { parent: inner.occurrence, items: [inventoryPart(c), inventoryPart(part(4, false))] },
    ] });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual([a, b, c].map(route => route.occurrence));
    await reload();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(b.occurrence)).toBeVisible();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'played');
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
  });

  test('whole-game completion exhausts every page within a group', async () => {
    const all = parts(46), branch = group(100);
    await mount({ parts: all, levels: [
      { parent: null, items: [inventoryPart(all[0]!), branch] },
      { parent: branch.occurrence, items: all.slice(1).map(inventoryPart) },
    ] });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual(all.map(route => route.occurrence));
    await browserExpect(row(all[45]!.occurrence)).toHaveAttribute('data-route-state', 'completed');
  });

  test('an unreadable grouped level prevents every whole-game write', async () => {
    const all = parts(2), branch = group(100);
    await mount({ parts: all, failParent: branch.occurrence, levels: [
      { parent: null, items: [inventoryPart(all[0]!), branch] },
      { parent: branch.occurrence, items: [inventoryPart(all[1]!)] },
    ] });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    expect(await writes()).toEqual([]);
  });

  test('a bounded whole-game walk refuses writes but manual paging can still reach deeper required parts', async () => {
    const all = parts(2);
    const branches = Array.from({ length: GAME_PART_PAGE_LIMIT + 1 }, (_, index) => group(index + 100));
    await mount({ parts: all, levels: [
      { parent: null, items: [inventoryPart(all[0]!), branches[0]!] },
      ...branches.map((branch, index) => ({ parent: branch.occurrence,
        items: index + 1 < branches.length ? [branches[index + 1]!] : [inventoryPart(all[1]!)] })),
    ] });
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText('Couldn’t save. Try again.');
    await browserExpect(state()).toHaveAttribute('data-play-state', 'unknown');
    expect(await writes()).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as TestWindow).game.pages.length)).toBe(GAME_PART_PAGE_LIMIT + 1);
    await page.getByRole('button', { name: 'Show more' }).click();
    await browserExpect(row(all[1]!.occurrence)).toBeVisible();
    await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
    await browserExpect(state()).toHaveAttribute('data-play-state', 'completed');
    expect(await writes()).toEqual(all.map(route => route.occurrence));
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
  function inventory(levels: InventoryLevel[], options: {
    missing?: string; changedRevision?: string; changedStructure?: string; loop?: string;
  } = {}) {
    const asked: { parent?: string; after?: string; limit: number; actingSubject: string }[] = [];
    const client = { v1: { resources: () => ({ parts: {
      get: async ({ query }: { query: typeof asked[number] }) => {
        asked.push(query);
        if (query.parent === options.missing && options.missing !== undefined) {
          return { data: null, error: { status: 404, value: {} } };
        }
        const items = levels.find(level => level.parent === (query.parent ?? null))!.items;
        const start = Number(query.after ?? 0);
        return { error: null, data: { structure: options.changedStructure && query.parent === options.changedStructure
          ? part(9002).occurrence : structure,
          revision: options.changedRevision && query.parent === options.changedRevision ? part(9001).occurrence : revision,
          parts: items.slice(start, start + query.limit),
          next: options.loop ?? (start + query.limit < items.length ? String(start + query.limit) : null) } };
      },
    } }) } } as unknown as MainClient;
    return { api: mainTrackingApi('reader', () => client).media!, asked };
  }

  test('pending root pages and nested, paged children share one complete inventory continuation', async () => {
    const all = parts(66), outer = group(100), inner = group(101);
    const { api, asked } = inventory([
      { parent: null, items: [outer, ...all.slice(0, 20).map(inventoryPart)] },
      { parent: outer.occurrence, items: [...all.slice(20, 65).map(inventoryPart), inner] },
      { parent: inner.occurrence, items: [inventoryPart(all[65]!)] },
    ]);
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await api.routes(work, after);
      if (!page.ok) throw new Error(page.failure);
      found.push(...page.data.items.map(route => route.occurrence));
      after = page.data.next ?? undefined;
    } while (after);
    expect(found).toEqual(all.map(route => route.occurrence));
    expect(asked.map(({ parent, after }) => [parent ?? null, after ?? null])).toEqual([
      [null, null], [null, '20'], [outer.occurrence, null], [outer.occurrence, '20'],
      [outer.occurrence, '40'], [inner.occurrence, null],
    ]);
    expect(asked.every(query => query.limit === 20 && query.actingSubject === 'reader')).toBe(true);
  });

  test('a missing child or changed composition/revision cannot establish inventory exhaustion', async () => {
    const branch = group(100);
    const levels = [{ parent: null, items: [inventoryPart(part(1)), branch] },
      { parent: branch.occurrence, items: [inventoryPart(part(2))] }];
    for (const [options, failure] of [[{ missing: branch.occurrence }, 'missing'],
      [{ changedRevision: branch.occurrence }, 'moved'], [{ changedStructure: branch.occurrence }, 'moved']] as const) {
      const { api } = inventory(levels, options);
      const first = await api.routes(work);
      if (!first.ok || !first.data.next) throw new Error('Missing grouped continuation');
      expect(await api.routes(work, first.data.next)).toEqual({ ok: false, failure,
        ...(failure === 'missing' ? { status: 404, problem: {} } : {}) });
    }
  });

  test('page loops and repeated groups fail instead of falsely exhausting inventory', async () => {
    const branch = group(100);
    const cases = [inventory([{ parent: null, items: [inventoryPart(part(1))] }], { loop: '20' }),
      inventory([{ parent: null, items: [branch] }, { parent: branch.occurrence, items: [branch] }])];
    for (const { api, asked } of cases) {
      let after: string | undefined;
      let failure: string | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        const read = await api.routes(work, after);
        if (!read.ok) { failure = read.failure; break; }
        expect(read.data.next).not.toBeNull();
        after = read.data.next!;
      }
      expect(failure).toBe('budget');
      expect(asked).toHaveLength(2);
    }
  });

  test('manual continuation can exhaust an inventory beyond the automatic page budget', async () => {
    const branches = Array.from({ length: GAME_PART_PAGE_LIMIT }, (_, index) => group(index + 100));
    const { api, asked } = inventory([
      { parent: null, items: [branches[0]!] },
      ...branches.map((branch, index) => ({ parent: branch.occurrence,
        items: index + 1 < branches.length ? [branches[index + 1]!] : [inventoryPart(part(1))] })),
    ]);
    let after: string | undefined;
    for (let count = 0; count < GAME_PART_PAGE_LIMIT; count++) {
      const read = await api.routes(work, after);
      if (!read.ok || !read.data.next) throw new Error('Unvisited levels must remain incomplete');
      expect(read.data.items).toEqual([]);
      after = read.data.next;
    }
    const last = await api.routes(work, after);
    expect(last.ok && last.data.items.map(route => route.occurrence)).toEqual([part(1).occurrence]);
    expect(last.ok && last.data.next).toBeNull();
    expect(asked).toHaveLength(GAME_PART_PAGE_LIMIT + 1);
    expect(await api.routes(part(9).occurrence, after)).toEqual({ ok: false, failure: 'invalid' });
    expect(asked).toHaveLength(GAME_PART_PAGE_LIMIT + 1);
  });

  test('parts keep their cursor and required inclusion; occurrence reads retain unfinished play', async () => {
    const all = parts(25);
    const asked: unknown[] = [];
    const client = { v1: {
      resources: ({ resource }: { resource: string }) => {
        expect(resource).toBe(work.split('/').at(-1)!);
        return { parts: { get: async ({ query }: { query: { after?: string } }) => {
          asked.push(query);
          const start = query.after ? Number(query.after) : 0;
          return { error: null, data: { structure, revision, next: start ? null : '20',
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
    expect(first.ok && first.data.next).toBeString();
    if (!first.ok || !first.data.next) throw new Error('Missing inventory continuation');
    const last = await api.routes(work, first.data.next);
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
    expect(await api.progress(part(2))).toEqual({ ok: false, failure: 'sign-in', status: 403, problem: {} });
  });
});
