import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThreadActivity } from '../src/threads/thread-activity/view';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/example/title?cursor=opaque' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('mounted activity retry keeps the reader request and retires late UI on replacement', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const original = { cursor: 'opaque:/+?=&版', post: 'selected-post' };
  const requests: object[] = [];
  let finish!: () => void;
  let current = true;
  const retry = async () => {
    requests.push(original);
    if (requests.length === 1) throw new Error('Temporary page failure');
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  try {
    await act(async () =>
      root.render(
        <ThreadActivity activity={{ state: 'withheld' }} current onRetry={retry} isCurrent={() => current} />,
      ),
    );
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe(m.thread_post_refresh());
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => {
      button.click();
    });
    expect(host.textContent).toContain(m.board_thread_activity_unavailable());
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(true);
    expect(requests).toEqual([original, original]);
    current = false;
    await act(async () =>
      root.render(
        <ThreadActivity
          key="replacement"
          activity={{ state: 'current', count: { kind: 'exact', value: 17 }, lastActivityAt: null }}
          current
          onRetry={async () => {}}
          isCurrent={() => true}
        />,
      ),
    );
    await act(async () => finish());
    expect(host.textContent).toContain('Replies: 17');
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
