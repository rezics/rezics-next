import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { applyReactionChange, reactionKinds } from '../src/components/reactions.tsx';

const packageRoot = join(import.meta.dir, '..');
const tempRoot = join(packageRoot, '../../.temp');
const packageRequire = createRequire(import.meta.url);

type PanelName = 'primary' | 'secondary';
type CallOutcome = 'resolve' | 'reject';
type Call = { id: number; panel: PanelName; callback: string; kind: string | null };

declare global {
  interface Window {
    reactionTest?: {
      calls: Call[];
      update(panel: PanelName, patch: Record<string, unknown>): void;
      settle(id: number, outcome: CallOutcome): void;
      retain(panel: PanelName, surface: 'chip' | 'picker', kind: string): number;
      invokeRetained(id: number): void;
    };
  }
}

function entrySource(componentPath: string): string {
  return `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Reactions } from ${JSON.stringify(componentPath)};

const reactionKinds = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'];
const calls = [];
const deferred = new Map();
const retained = [];
const callbackCache = new Map();
const initialCounts = { upvote: 3, downvote: 1, like: 4, love: 2, laugh: 1, insightful: 1, sad: 1 };
const initial = {
  primary: {
    callback: 'A', counts: initialCounts, value: 'like', locale: 'en', disabled: false,
    signInHref: null, kinds: [...reactionKinds].reverse(), collapse: 2, labels: {}, mounted: true, mountKey: 0,
  },
  secondary: {
    callback: 'S', counts: { like: 8, love: 3 }, value: 'love', locale: 'en', disabled: false,
    signInHref: null, kinds: null, collapse: null, labels: {}, mounted: true, mountKey: 0,
  },
};

function callbackFor(panel, name) {
  const key = panel + ':' + name;
  if (callbackCache.has(key)) return callbackCache.get(key);
  const callback = (kind) => new Promise((resolve, reject) => {
    const id = calls.length;
    calls.push({ id, panel, callback: name, kind });
    deferred.set(id, { resolve, reject });
  });
  callbackCache.set(key, callback);
  return callback;
}

function retainClick(button) {
  const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
  const props = key ? button[key] : null;
  if (!props || typeof props.onClick !== 'function') throw new Error('The mounted reaction button has no retained click handler.');
  retained.push(props.onClick);
  return retained.length - 1;
}

function Harness() {
  const [panels, setPanels] = useState(initial);
  window.reactionTest = {
    calls,
    update(panel, patch) {
      flushSync(() => setPanels((previous) => ({ ...previous, [panel]: { ...previous[panel], ...patch } })));
    },
    settle(id, outcome) {
      const pending = deferred.get(id);
      if (!pending) throw new Error('There is no deferred reaction callback ' + id + '.');
      deferred.delete(id);
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('The deferred reaction was rejected.'));
    },
    retain(panel, surface, kind) {
      const root = surface === 'chip'
        ? document.querySelector('[data-panel="' + panel + '"]')
        : document.querySelector('[role="dialog"]');
      if (!root) throw new Error('Cannot retain the ' + surface + ' handler for ' + kind + '.');
      const buttons = [...root.querySelectorAll('button')];
      const button = surface === 'chip'
        ? buttons.find((candidate) => candidate.getAttribute('data-slot') === 'reaction-chip' && candidate.querySelector('.sr-only')?.textContent === kind)
        : buttons.find((candidate) => candidate.textContent?.trim().startsWith(kind));
      if (!button) throw new Error('Cannot find the ' + surface + ' button for ' + kind + '.');
      return retainClick(button);
    },
    invokeRetained(id) {
      const handler = retained[id];
      if (typeof handler !== 'function') throw new Error('There is no retained handler ' + id + '.');
      handler();
    },
  };

  return <main>
    {(['primary', 'secondary']).map((panel) => {
      const config = panels[panel];
      return <section aria-label={panel === 'primary' ? 'Primary' : 'Secondary'} data-panel={panel} key={panel} role="region">
        {config.mounted && <Reactions
          key={config.mountKey}
          counts={config.counts}
          value={config.value}
          locale={config.locale}
          disabled={config.disabled}
          kinds={config.kinds === null ? undefined : config.kinds}
          collapse={config.collapse === null ? undefined : config.collapse}
          labels={config.labels}
          signInHref={config.signInHref === null ? undefined : config.signInHref}
          onChange={callbackFor(panel, config.callback)}
        />}
      </section>;
    })}
  </main>;
}

createRoot(document.getElementById('app')).render(<Harness />);
`;
}

async function update(page: Page, panel: PanelName, patch: Record<string, unknown>) {
  await page.evaluate(({ panelName, values }) => window.reactionTest?.update(panelName, values), {
    panelName: panel,
    values: patch,
  });
}

async function waitForCalls(page: Page, count: number) {
  await page.waitForFunction((minimum) => (window.reactionTest?.calls.length ?? 0) >= minimum, count);
}

async function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => window.reactionTest?.calls.map((call) => ({ ...call })) ?? []);
}

async function settle(page: Page, id: number, outcome: CallOutcome) {
  await page.evaluate(
    async ({ callId, result }) => {
      window.reactionTest?.settle(callId, result);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    { callId: id, result: outcome },
  );
}

async function retain(page: Page, panel: PanelName, surface: 'chip' | 'picker', kind: string): Promise<number> {
  return page.evaluate(
    ({ panelName, buttonSurface, reactionKind }) =>
      window.reactionTest?.retain(panelName, buttonSurface, reactionKind) ?? -1,
    { panelName: panel, buttonSurface: surface, reactionKind: kind },
  );
}

async function invokeRetained(page: Page, id: number) {
  await page.evaluate((handlerId) => window.reactionTest?.invokeRetained(handlerId), id);
}

async function openPicker(page: Page, panel: PanelName = 'primary') {
  const dialog = page.getByRole('dialog');
  if (!(await dialog.isVisible().catch(() => false))) {
    const label = panel === 'primary' ? 'Primary' : 'Secondary';
    await page.getByRole('region', { name: label }).getByRole('button', { name: 'React' }).click();
  }
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  return page.getByRole('dialog');
}

async function chooseFromPicker(page: Page, kind: string, panel: PanelName = 'primary') {
  const dialog = await openPicker(page, panel);
  await dialog.getByRole('button', { name: new RegExp(`^${kind}(?:\\s|$)`) }).click();
}

async function waitBusy(page: Page, panel: PanelName, busy: boolean) {
  const name = panel === 'primary' ? 'Primary' : 'Secondary';
  await page.waitForFunction(
    ({ region, expected }) =>
      document
        .querySelector('[role="region"][aria-label="' + region + '"] [data-slot="reactions"]')
        ?.getAttribute('aria-busy') === String(expected),
    { region: name, expected: busy },
  );
}

test('shared Reactions serialize original choices and retire every obsolete visit', async () => {
  expect(reactionKinds).toEqual(['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad']);
  const zero = { like: 0 };
  expect(applyReactionChange(zero, 'like', null)).toEqual({ like: 0 });
  expect(applyReactionChange(zero, 'like', 'like')).toBe(zero);

  mkdirSync(tempRoot, { recursive: true });
  const output = mkdtempSync(join(tempRoot, 'ui-reactions-lifetime-'));
  const entry = join(output, 'entry.tsx');
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    writeFileSync(entry, entrySource(join(packageRoot, 'src/components/reactions.tsx')));
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
      plugins: [
        {
          name: 'workspace-react',
          setup(build) {
            build.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: packageRequire.resolve(path) }));
          },
        },
      ],
    });
    expect(built.success, built.logs.map(String).join('\n')).toBe(true);

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent('<!doctype html><html lang="en"><body><div id="app"></div></body></html>');
    await page.addScriptTag({ content: built.outputs[0]!.text() });

    const primary = page.getByRole('region', { name: 'Primary' });
    const secondary = page.getByRole('region', { name: 'Secondary' });
    const primaryGroup = primary.getByRole('group', { name: 'Reactions' });
    await primaryGroup.waitFor({ state: 'visible' });
    expect(await primaryGroup.getAttribute('aria-busy')).toBe('false');
    expect(await primary.locator('[data-slot="reaction-chip"] .sr-only').allTextContents()).toEqual([
      'Upvote',
      'Downvote',
      'Like',
      'Love',
      'Laugh',
      'Insightful',
      'Sad',
    ]);
    expect(await primary.getByRole('button', { name: 'Like 4' }).getAttribute('aria-pressed')).toBe('true');
    expect(await primary.getByRole('button', { name: 'Like 4' }).getAttribute('class')).toContain('text-primary');

    await update(page, 'primary', {
      counts: { upvote: 20_000, downvote: 1, like: 12_000, love: 2, laugh: 1, insightful: 1, sad: 1 },
      locale: 'ja',
      collapse: 1,
    });
    const japaneseLike = primary.getByRole('button', {
      name: `Like ${new Intl.NumberFormat('ja', { notation: 'compact' }).format(12_000)} (${new Intl.NumberFormat('ja').format(12_000)})`,
    });
    await japaneseLike.waitFor({ state: 'visible' });
    expect(await japaneseLike.getAttribute('class')).not.toContain('max-sm:hidden');
    expect(await primary.getByRole('button', { name: 'Downvote 1' }).getAttribute('class')).toContain('max-sm:hidden');

    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 1, like: 4, love: 2, laugh: 1, insightful: 1, sad: 1 },
      locale: 'en',
      collapse: 2,
      kinds: [...reactionKinds].reverse(),
    });

    // Clear through a chip, then queue replacement and another choice through the open picker.
    await primary.getByRole('button', { name: 'Like 4' }).click();
    await waitForCalls(page, 1);
    expect((await calls(page))[0]).toEqual({ id: 0, panel: 'primary', callback: 'A', kind: null });
    expect(await primary.getByRole('button', { name: 'Like 3' }).getAttribute('aria-pressed')).toBe('false');
    await openPicker(page);
    await chooseFromPicker(page, 'Love');
    await chooseFromPicker(page, 'Upvote');
    expect(await calls(page)).toHaveLength(1);
    await update(page, 'primary', {
      callback: 'B',
      labels: { choose: 'Choose a reaction now', failed: 'This reaction could not be saved.' },
      locale: 'de',
      kinds: [...reactionKinds].reverse(),
      counts: { upvote: 3, downvote: 1, like: 3, love: 2, laugh: 1, insightful: 1, sad: 1 },
      value: null,
    });
    await waitBusy(page, 'primary', true);
    expect(await primaryGroup.getAttribute('aria-label')).toBe('Reactions');
    expect(await primary.getByRole('button', { name: 'Like 3' }).getAttribute('aria-pressed')).toBe('false');
    expect(await page.getByRole('dialog').getAttribute('aria-label')).toBe('Choose a reaction now');
    await settle(page, 0, 'resolve');
    await waitForCalls(page, 2);
    expect((await calls(page))[1]).toEqual({ id: 1, panel: 'primary', callback: 'A', kind: 'love' });
    expect(await primary.getByRole('button', { name: 'Love 3' }).getAttribute('aria-pressed')).toBe('true');
    await settle(page, 1, 'resolve');
    await waitForCalls(page, 3);
    expect((await calls(page))[2]).toEqual({ id: 2, panel: 'primary', callback: 'A', kind: 'upvote' });
    expect(await primary.getByRole('button', { name: 'Upvote 4' }).getAttribute('aria-pressed')).toBe('true');
    await settle(page, 2, 'resolve');
    await waitBusy(page, 'primary', false);

    // The controlled echo becomes the new baseline; a current rejection restores it and a fresh choice recovers.
    await update(page, 'primary', {
      counts: { upvote: 4, downvote: 1, like: 3, love: 2, laugh: 1, insightful: 1, sad: 1 },
      value: 'upvote',
    });
    await primary.getByRole('button', { name: 'Upvote 4' }).click();
    await waitForCalls(page, 4);
    expect((await calls(page))[3]).toEqual({ id: 3, panel: 'primary', callback: 'B', kind: null });
    await settle(page, 3, 'reject');
    await page.getByRole('status', { name: 'This reaction could not be saved.' }).waitFor({ state: 'visible' });
    expect(await primary.getByRole('button', { name: 'Upvote 4' }).getAttribute('aria-pressed')).toBe('true');
    expect(await primary.getByRole('button', { name: 'Upvote 4' }).getAttribute('class')).toContain('text-primary');
    await chooseFromPicker(page, 'Love');
    await waitForCalls(page, 5);
    expect((await calls(page))[4]).toEqual({ id: 4, panel: 'primary', callback: 'B', kind: 'love' });
    await page.getByRole('status', { name: 'This reaction could not be saved.' }).waitFor({ state: 'hidden' });
    await settle(page, 4, 'resolve');
    await waitBusy(page, 'primary', false);
    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 1, like: 3, love: 3, laugh: 1, insightful: 1, sad: 1 },
      value: 'love',
    });

    // Two mounted instances own independent runners and can settle in either order.
    await primary.getByRole('button', { name: 'Laugh 1' }).click();
    await waitForCalls(page, 6);
    await secondary.getByRole('button', { name: 'Love 3' }).click();
    await waitForCalls(page, 7);
    expect((await calls(page)).slice(5)).toEqual([
      { id: 5, panel: 'primary', callback: 'B', kind: 'laugh' },
      { id: 6, panel: 'secondary', callback: 'S', kind: null },
    ]);
    await settle(page, 6, 'resolve');
    await waitBusy(page, 'secondary', false);
    await waitBusy(page, 'primary', true);
    await settle(page, 5, 'resolve');
    await waitBusy(page, 'primary', false);
    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 1, like: 3, love: 2, laugh: 2, insightful: 1, sad: 1 },
      value: 'laugh',
    });
    await update(page, 'secondary', { counts: { like: 8, love: 2 }, value: null });

    // Disabling an open picker retires its old runner, queued choices and retained event handlers.
    await openPicker(page);
    await chooseFromPicker(page, 'Sad');
    await waitForCalls(page, 8);
    await chooseFromPicker(page, 'Insightful');
    const retiredDisableHandler = await retain(page, 'primary', 'picker', 'Upvote');
    const retiredDisableChipHandler = await retain(page, 'primary', 'chip', 'Like');
    await update(page, 'primary', { disabled: true });
    await waitBusy(page, 'primary', false);
    expect(
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^Upvote/ })
        .isDisabled(),
    ).toBe(true);
    expect(await primary.getByRole('button', { name: 'Like 3' }).isDisabled()).toBe(true);
    expect(await primary.getByRole('button', { name: 'Laugh 2' }).getAttribute('aria-pressed')).toBe('true');
    await invokeRetained(page, retiredDisableHandler);
    await invokeRetained(page, retiredDisableChipHandler);
    expect(await calls(page)).toHaveLength(8);
    await update(page, 'primary', { disabled: false, callback: 'C' });
    await invokeRetained(page, retiredDisableHandler);
    await invokeRetained(page, retiredDisableChipHandler);
    expect(await calls(page)).toHaveLength(8);
    await chooseFromPicker(page, 'Downvote');
    await waitForCalls(page, 9);
    expect((await calls(page))[8]).toEqual({ id: 8, panel: 'primary', callback: 'C', kind: 'downvote' });
    await waitBusy(page, 'primary', true);
    await settle(page, 7, 'reject');
    await waitBusy(page, 'primary', true);
    expect(await calls(page)).toHaveLength(9);
    expect(await primary.getByRole('button', { name: 'Downvote 2' }).getAttribute('aria-pressed')).toBe('true');
    expect(await primary.getByRole('status').count()).toBe(0);
    await settle(page, 8, 'resolve');
    await waitBusy(page, 'primary', false);
    expect(await primary.getByRole('button', { name: 'Downvote 2' }).getAttribute('aria-pressed')).toBe('true');
    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 2, like: 3, love: 2, laugh: 1, insightful: 1, sad: 1 },
      value: 'downvote',
    });

    // Sign-out and link replacement retire a separate open queue. A new visit progresses while the old one waits.
    await openPicker(page);
    await chooseFromPicker(page, 'Laugh');
    await waitForCalls(page, 10);
    await chooseFromPicker(page, 'Insightful');
    const retiredSignOutHandler = await retain(page, 'primary', 'picker', 'Love');
    await update(page, 'primary', { signInHref: '/sign-in-one' });
    await page.getByRole('link', { name: 'React' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('link', { name: 'React' }).getAttribute('href')).toBe('/sign-in-one');
    expect(await primary.getByRole('img', { name: 'Downvote 2' }).count()).toBe(1);
    expect(await primary.getByRole('button').count()).toBe(0);
    await invokeRetained(page, retiredSignOutHandler);
    expect(await calls(page)).toHaveLength(10);
    await update(page, 'primary', { signInHref: '/sign-in-two' });
    expect(await page.getByRole('link', { name: 'React' }).getAttribute('href')).toBe('/sign-in-two');
    await update(page, 'primary', { signInHref: null, callback: 'D' });
    await invokeRetained(page, retiredSignOutHandler);
    expect(await calls(page)).toHaveLength(10);
    await chooseFromPicker(page, 'Love');
    await waitForCalls(page, 11);
    expect((await calls(page))[10]).toEqual({ id: 10, panel: 'primary', callback: 'D', kind: 'love' });
    await waitBusy(page, 'primary', true);
    await settle(page, 9, 'resolve');
    await waitBusy(page, 'primary', true);
    expect(await calls(page)).toHaveLength(11);
    expect(await primary.getByRole('button', { name: 'Love 3' }).getAttribute('aria-pressed')).toBe('true');
    await settle(page, 10, 'resolve');
    await waitBusy(page, 'primary', false);
    expect(await calls(page)).toHaveLength(11);
    expect(await primary.getByRole('button', { name: 'Love 3' }).getAttribute('aria-pressed')).toBe('true');
    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 1, like: 3, love: 3, laugh: 1, insightful: 1, sad: 1 },
      value: 'love',
    });

    // A meaningful kind withdrawal and observed A/B/A cannot revive queued or retained old choices.
    await openPicker(page);
    await chooseFromPicker(page, 'Sad');
    await waitForCalls(page, 12);
    await chooseFromPicker(page, 'Laugh');
    const retiredKindsHandler = await retain(page, 'primary', 'picker', 'Sad');
    await update(page, 'primary', { kinds: ['like', 'love', 'sad'] });
    await page.getByRole('dialog').getByRole('button', { name: /^Sad/ }).waitFor({ state: 'visible' });
    expect(
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^Laugh/ })
        .count(),
    ).toBe(0);
    expect(await primary.getByRole('button', { name: /^Upvote/ }).count()).toBe(0);
    await update(page, 'primary', { kinds: [...reactionKinds].reverse() });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Laugh/ })
      .waitFor({ state: 'visible' });
    await invokeRetained(page, retiredKindsHandler);
    expect(await calls(page)).toHaveLength(12);
    await update(page, 'primary', { callback: 'E' });
    await chooseFromPicker(page, 'Insightful');
    await waitForCalls(page, 13);
    expect((await calls(page))[12]).toEqual({ id: 12, panel: 'primary', callback: 'E', kind: 'insightful' });
    await waitBusy(page, 'primary', true);
    await settle(page, 11, 'reject');
    await waitBusy(page, 'primary', true);
    expect(await calls(page)).toHaveLength(13);
    expect(await primary.getByRole('status').count()).toBe(0);
    expect(await primary.getByRole('button', { name: 'Insightful 2' }).getAttribute('aria-pressed')).toBe('true');
    await settle(page, 12, 'resolve');
    await waitBusy(page, 'primary', false);
    expect(await calls(page)).toHaveLength(13);
    expect(await primary.getByRole('button', { name: 'Insightful 2' }).getAttribute('aria-pressed')).toBe('true');
    await update(page, 'primary', {
      counts: { upvote: 3, downvote: 1, like: 3, love: 2, laugh: 1, insightful: 2, sad: 1 },
      value: 'insightful',
    });

    // Unmounting retires the current runner. Its late completion and queued choice cannot touch a remounted visit.
    await openPicker(page);
    await chooseFromPicker(page, 'Laugh');
    await waitForCalls(page, 14);
    await chooseFromPicker(page, 'Sad');
    const retiredUnmountHandler = await retain(page, 'primary', 'picker', 'Love');
    const retiredUnmountChipHandler = await retain(page, 'primary', 'chip', 'Insightful');
    await update(page, 'primary', { mounted: false });
    await primary.getByRole('group', { name: 'Reactions' }).waitFor({ state: 'detached' });
    await invokeRetained(page, retiredUnmountHandler);
    await invokeRetained(page, retiredUnmountChipHandler);
    expect(await calls(page)).toHaveLength(14);
    await update(page, 'primary', { mounted: true, mountKey: 1, callback: 'F' });
    await primary.getByRole('group', { name: 'Reactions' }).waitFor({ state: 'visible' });
    await primary.getByRole('button', { name: 'Insightful 2' }).click();
    await waitForCalls(page, 15);
    expect((await calls(page))[14]).toEqual({ id: 14, panel: 'primary', callback: 'F', kind: null });
    await waitBusy(page, 'primary', true);
    await settle(page, 13, 'resolve');
    await waitBusy(page, 'primary', true);
    expect(await calls(page)).toHaveLength(15);
    expect(await primary.getByRole('button', { name: 'Insightful 1' }).getAttribute('aria-pressed')).toBe('false');
    expect(await primary.getByRole('status').count()).toBe(0);
    await settle(page, 14, 'resolve');
    await waitBusy(page, 'primary', false);
    expect(await primary.getByRole('button', { name: 'Insightful 1' }).getAttribute('aria-pressed')).toBe('false');
    expect(await calls(page)).toHaveLength(15);
    expect(await primary.getByRole('button', { name: 'Insightful 1' }).getAttribute('aria-pressed')).toBe('false');
    expect(await primary.getByRole('status').count()).toBe(0);

    expect((await calls(page)).map(({ id, panel, callback, kind }) => [id, panel, callback, kind])).toEqual([
      [0, 'primary', 'A', null],
      [1, 'primary', 'A', 'love'],
      [2, 'primary', 'A', 'upvote'],
      [3, 'primary', 'B', null],
      [4, 'primary', 'B', 'love'],
      [5, 'primary', 'B', 'laugh'],
      [6, 'secondary', 'S', null],
      [7, 'primary', 'B', 'sad'],
      [8, 'primary', 'C', 'downvote'],
      [9, 'primary', 'C', 'laugh'],
      [10, 'primary', 'D', 'love'],
      [11, 'primary', 'D', 'sad'],
      [12, 'primary', 'E', 'insightful'],
      [13, 'primary', 'E', 'laugh'],
      [14, 'primary', 'F', null],
    ]);
  } finally {
    await page?.close();
    await browser?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
