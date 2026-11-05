import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { yearlyGoalSearch } from '../src/library/yearly-goal-address';
import {
  YearlyGoalPage,
  type YearlyGoalCommand,
  type YearlyGoalPageApi,
  type YearlyGoalReadResult,
  type YearlyGoalSnapshot,
  type YearlyGoalWriteResult,
} from '../src/library/yearly-goal-page';
import { libraryNavigationEntries } from '../src/library/library-nav';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, overwriteGetLocale } from '../src/paraglide/runtime.js';
import { nativeYearlyGoalSnapshot } from './yearly-goal.native-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/goals?year=2026' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

function nativeApi(initial: YearlyGoalSnapshot['target'] = { state: 'none', revision: null }) {
  let target = initial;
  const receipts = new Map<string, string>();
  const calls: YearlyGoalCommand[] = [];
  const order: string[] = [];
  const api: YearlyGoalPageApi = {
    async read(year) {
      order.push(`read:${year}`);
      return {
        state: 'ready',
        value: nativeYearlyGoalSnapshot(year, structuredClone(target), 'available', '900719925474099312345'),
      };
    },
    async write(command) {
      calls.push(structuredClone(command));
      order.push(`write:${command.target}`);
      const serialized = JSON.stringify(command);
      const receipt = receipts.get(command.idempotencyKey);
      if (receipt !== undefined) {
        if (receipt !== serialized) throw new Error('fixture idempotency key reused with another command');
        return { state: 'applied' };
      }
      const revision = target.state === 'unavailable' ? null : target.revision;
      if (revision !== command.expectedRevision) return { state: 'stale' };
      const next = revision === null ? '1' : (BigInt(revision) + 1n).toString();
      target =
        command.target === null
          ? { state: 'none', revision: next }
          : { state: 'set', target: command.target, revision: next };
      receipts.set(command.idempotencyKey, serialized);
      return { state: 'applied' };
    },
  };
  return { api, calls, order, target: () => target };
}

async function mountPage(api: YearlyGoalPageApi, year = 2026, viewerSubject = 'owner') {
  const restoreLocale = getLocale();
  overwriteGetLocale(() => 'en');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<YearlyGoalPage year={year} sessionState="signed-in" viewerSubject={viewerSubject} api={api} />);
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    async render(nextYear: number, nextViewer: string) {
      await act(async () => {
        root.render(<YearlyGoalPage year={nextYear} sessionState="signed-in" viewerSubject={nextViewer} api={api} />);
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      overwriteGetLocale(() => restoreLocale);
    },
  };
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    button.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function setTargetInput(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('#yearly-goal-target-value');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing target input');
  setter.call(input, value);
  await act(async () => input.dispatchEvent(new window.Event('input', { bubbles: true })));
}

async function submitTarget(container: HTMLElement) {
  const form = container.querySelector<HTMLInputElement>('#yearly-goal-target-value')?.form;
  if (!form) throw new Error('Missing target form');
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('year selection accepts the native Gregorian bounds and keeps invalid addresses distinct', () => {
  expect(yearlyGoalSearch({})).toEqual({ year: undefined });
  for (const year of [1, 2026, 9999]) {
    expect(yearlyGoalSearch({ year })).toEqual({ year });
    expect(yearlyGoalSearch({ year: String(year) })).toEqual({ year });
  }
  for (const year of [0, 10000, -1, 1.5, '', '02026', '1e3', 'invalid', ['2026'], null])
    expect(yearlyGoalSearch({ year })).toEqual({ year: 'invalid' });
});

test('all eight locales expose the goal destination, metric, unavailable coverage and selected-year history', () => {
  const original = getLocale;
  try {
    expect(locales).toHaveLength(8);
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      const { tabs } = libraryNavigationEntries('goals', { state: 'preparing' }, [], locale);
      expect(tabs.find((tab) => tab.id === 'goals')).toEqual({
        id: 'goals',
        label: m.library_yearly_goal_title(),
        href: `/${locale}/library/goals`,
        current: true,
      });
      const html = renderToStaticMarkup(<YearlyGoalPage year={2020} sessionState="signed-in" />);
      for (const text of [
        m.library_yearly_goal_metric(),
        m.library_yearly_goal_coverage(),
        m.library_yearly_goal_unavailable(),
      ])
        expect(html).toContain(renderToStaticMarkup(<p>{text}</p>).slice(3, -4));
      expect(html).toContain(`href="/${locale}/library/history?year=2020"`);
      expect(html).toContain(`action="/${locale}/library/goals"`);
      expect(html).toContain('method="get"');
      expect(html).toContain('value="2020"');
      expect(html).toContain('min-h-11');
      expect(html).not.toContain('progressbar');
      expect(html).not.toContain('name="target"');
    }
  } finally {
    overwriteGetLocale(original);
  }
});

test('year navigation respects bounds and rejects an invalid address without silently linking another year', () => {
  const first = renderToStaticMarkup(<YearlyGoalPage year={1} sessionState="signed-in" />);
  const last = renderToStaticMarkup(<YearlyGoalPage year={9999} sessionState="signed-in" />);
  expect(first).not.toContain('/goals?year=0');
  expect(first).toContain('/goals?year=2');
  expect(last).not.toContain('/goals?year=10000');
  expect(last).toContain('/goals?year=9998');
  const invalid = renderToStaticMarkup(<YearlyGoalPage sessionState="signed-in" />);
  expect(invalid).toContain('role="alert"');
  expect(invalid).toContain('aria-invalid="true"');
  expect(invalid).not.toContain('/history?year=');
});

test('retired, unresolved and signed-out sessions never present a target; sign-in retains the selected year', () => {
  for (const sessionState of ['signed-out', 'unknown', 'unavailable'] as const) {
    const html = renderToStaticMarkup(<YearlyGoalPage year={2020} sessionState={sessionState} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('name="target"');
    expect(html).not.toContain('progressbar');
    if (sessionState === 'signed-out')
      expect(html).toContain(encodeURIComponent(`/${getLocale()}/library/goals?year=2020`));
  }
});

test('mounted owner reads native progress, sets and clears a target, and reads back each new revision', async () => {
  const native = nativeApi();
  const page = await mountPage(native.api);
  try {
    expect(native.order).toEqual(['read:2026']);
    expect(page.container.textContent).toContain('No target has been set.');
    expect(page.container.textContent).toContain('900719925474099312345');
    expect(page.container.querySelectorAll('a[href*="/library/history?year=2026&month="]')).toHaveLength(13);
    expect(page.container.querySelector('a[href="/en/library/history?year=2026"]')).not.toBeNull();

    await click(page.container, m.library_yearly_goal_edit());
    await setTargetInput(page.container, '12');
    await submitTarget(page.container);
    expect(native.calls[0]).toMatchObject({
      year: 2026,
      metric: 'completed_consumption_occurrences',
      target: 12,
      expectedRevision: null,
    });
    expect(native.calls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(native.order).toEqual(['read:2026', 'write:12', 'read:2026']);
    expect(page.container.textContent).toContain('Target revision 1');

    await click(page.container, m.library_yearly_goal_clear());
    await click(page.container, m.library_yearly_goal_clear());
    expect(native.calls[1]).toMatchObject({ target: null, expectedRevision: '1' });
    expect(native.order).toEqual(['read:2026', 'write:12', 'read:2026', 'write:null', 'read:2026']);
    expect(page.container.textContent).toContain('No target has been set.');
    expect(page.container.textContent).toContain('Target revision 2');
  } finally {
    await page.dispose();
  }
});

test('an unset goal remains editable when native summary progress is unavailable', async () => {
  const native = nativeApi();
  const api: YearlyGoalPageApi = {
    read: async (year) => {
      const result = await native.api.read(year);
      return result.state === 'ready'
        ? {
            state: 'ready',
            value: { ...result.value, progress: { state: 'unavailable', reason: 'summary_unavailable' } },
          }
        : result;
    },
    write: native.api.write,
  };
  const page = await mountPage(api);
  try {
    expect(page.container.textContent).toContain('No target has been set.');
    expect(page.container.textContent).toContain(m.library_diary_year_unavailable());
    expect(page.container.querySelector('input#yearly-goal-target-value')).toBeNull();
    await click(page.container, m.library_yearly_goal_edit());
    expect(page.container.querySelector('input#yearly-goal-target-value')).not.toBeNull();
  } finally {
    await page.dispose();
  }
});

test('uncertain delivery retries the exact native command and resolves its receipt before readback', async () => {
  const native = nativeApi();
  const commands: YearlyGoalCommand[] = [];
  let first = true;
  const api: YearlyGoalPageApi = {
    read: native.api.read,
    write: async (command) => {
      commands.push(structuredClone(command));
      if (first) {
        first = false;
        expect(await native.api.write(command)).toEqual({ state: 'applied' });
        return { state: 'uncertain' };
      }
      return native.api.write(command);
    },
  };
  const page = await mountPage(api);
  try {
    await click(page.container, m.library_yearly_goal_edit());
    await setTargetInput(page.container, '5');
    await submitTarget(page.container);
    expect(page.container.textContent).toContain(m.library_yearly_goal_uncertain());
    expect(native.order).toEqual(['read:2026', 'write:5']);
    await click(page.container, m.library_yearly_goal_retry_exact());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(native.order).toEqual(['read:2026', 'write:5', 'write:5', 'read:2026']);
    expect(page.container.textContent).toContain('Target revision 1');
  } finally {
    await page.dispose();
  }
});

test('a stale revision keeps the proposal until explicit refresh and review against the current revision', async () => {
  const commands: YearlyGoalCommand[] = [];
  let target: YearlyGoalSnapshot['target'] = { state: 'none', revision: null };
  let reads = 0;
  const api: YearlyGoalPageApi = {
    async read(year) {
      reads += 1;
      if (reads === 1) return { state: 'ready', value: nativeYearlyGoalSnapshot(year, target) };
      return { state: 'ready', value: nativeYearlyGoalSnapshot(year, target) };
    },
    async write(command) {
      commands.push(structuredClone(command));
      if (commands.length === 1) {
        target = { state: 'set', target: 3, revision: '7' };
        return { state: 'stale' };
      }
      expect(command.expectedRevision).toBe('7');
      target = { state: 'set', target: command.target!, revision: '8' };
      return { state: 'applied' };
    },
  };
  const page = await mountPage(api);
  try {
    await click(page.container, m.library_yearly_goal_edit());
    await setTargetInput(page.container, '9');
    await submitTarget(page.container);
    expect(page.container.textContent).toContain(m.library_yearly_goal_stale());
    expect(reads).toBe(1);
    await click(page.container, m.library_yearly_goal_refresh());
    expect(page.container.querySelector<HTMLInputElement>('#yearly-goal-target-value')?.value).toBe('9');
    expect(page.container.textContent).toContain(m.library_yearly_goal_review());
    expect(page.container.textContent).toContain('Target revision 7');
    await submitTarget(page.container);
    expect(commands[1]).toMatchObject({ target: 9, expectedRevision: '7' });
    expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(page.container.textContent).toContain('Target revision 8');
  } finally {
    await page.dispose();
  }
});

test('year and viewer replacement retire late callbacks and the prior private target', async () => {
  const first = deferred<YearlyGoalReadResult>();
  let reads = 0;
  const api: YearlyGoalPageApi = {
    read: (year) => {
      reads += 1;
      return reads === 1
        ? first.promise
        : Promise.resolve({
            state: 'ready',
            value: nativeYearlyGoalSnapshot(year, { state: 'set', target: 7, revision: '2' }),
          });
    },
    write: async () => ({ state: 'unavailable' }),
  };
  const page = await mountPage(api, 2026, 'viewer-a');
  try {
    await page.render(2027, 'viewer-b');
    expect(page.container.textContent).toContain('7');
    await act(async () => {
      first.resolve({
        state: 'ready',
        value: nativeYearlyGoalSnapshot(2026, { state: 'set', target: 99, revision: '5' }),
      });
      await first.promise;
    });
    expect(page.container.textContent).toContain('2027');
    expect(page.container.textContent).toContain('Target revision 2');
    expect(page.container.textContent).not.toContain('Target revision 5');
    expect(page.container.textContent).not.toContain('99');
  } finally {
    await page.dispose();
  }
});
