import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryRouteContext, useRouter } from '../.storybook/next-navigation.ts';
import { waitForFocus } from '../../../packages/ui/src/test/focus.ts';

function focusWindow() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const document = { activeElement: null as unknown, defaultView: {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++next;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setTimeout(callback: () => void, delay: number) {
      const id = ++next;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  } };
  const child = {};
  const target = { ownerDocument: document, contains: (element: unknown) => element === child };
  return { document, child, target: target as unknown as HTMLElement, frames, timers,
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

test('G-978 loaded overlays still require two consecutive focused frames', async () => {
  const browser = focusWindow();
  let resolved = false;
  const pending = waitForFocus(browser.target, 5000).then(() => { resolved = true; });
  expect([...browser.timers.values()][0]!.delay).toBe(5000);
  browser.frame();
  browser.document.activeElement = browser.child;
  browser.frame();
  await Promise.resolve();
  expect(resolved).toBe(false);
  // Transient autofocus does not satisfy the settling requirement.
  browser.document.activeElement = null;
  browser.frame();
  browser.document.activeElement = browser.child;
  browser.frame();
  await Promise.resolve();
  expect(resolved).toBe(false);
  browser.frame();
  await pending;
  expect(resolved).toBe(true);
  expect(browser.timers.size).toBe(0);
  expect(browser.frames.size).toBe(0);
});

test('G-978 focus that never arrives still fails and cancels the pending frame', async () => {
  const browser = focusWindow();
  const pending = waitForFocus(browser.target, 5000);
  [...browser.timers.values()][0]!.callback();
  await expect(pending).rejects.toThrow('Focus did not settle inside the target');
  expect(browser.frames.size).toBe(0);
});

test('G-978 story navigation observes the command while retaining the fixture route', () => {
  const calls: unknown[][] = [];
  const route = { pathname: '/en/search', search: '?q=river',
    onPush: (...args: unknown[]) => { calls.push(args); } };
  let router: ReturnType<typeof useRouter> | undefined;
  function Probe() { router = useRouter(); return null; }
  renderToStaticMarkup(createElement(StoryRouteContext, { value: route }, createElement(Probe)));
  router!.push('/en/search?q=river&lang=ja', { scroll: false });
  expect(calls).toEqual([['/en/search?q=river&lang=ja', { scroll: false }]]);
  expect(route.pathname).toBe('/en/search');
  expect(route.search).toBe('?q=river');
});
