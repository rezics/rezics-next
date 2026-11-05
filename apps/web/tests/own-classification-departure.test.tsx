import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';

test('Stay keeps the exact draft; confirmed Leave retires the original visit before destination admission', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
  const globals = Object.fromEntries(
    'document navigator HTMLElement HTMLButtonElement HTMLInputElement Element Node Document DocumentFragment MutationObserver ResizeObserver'
      .split(' ')
      .map((key) => [key, Reflect.get(window, key)]),
  );
  Object.assign(globals, {
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const router = await import('@tanstack/react-router');
  let block!: (attempt: { current: { pathname: string }; next: { pathname: string } }) => boolean | Promise<boolean>;
  mock.module('@tanstack/react-router', () => ({
    ...router,
    useBlocker: (options: { shouldBlockFn: typeof block }) => {
      block = options.shouldBlockFn;
    },
  }));
  const { createRoot } = await import('react-dom/client');
  const { OwnVotesDeparture } = await import('../src/ratings/own-votes/departure');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const sequence: string[] = [];
  let retired = false;
  function Harness() {
    const [draft, setDraft] = useState('Keep this exact unsent draft');
    return (
      <>
        <input
          aria-label="Unsent assessment draft"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <OwnVotesDeparture
          dirty={draft.length > 0}
          locked={false}
          isCurrent={() => !retired}
          onLeave={() => {
            retired = true;
            sequence.push('retired');
          }}
        />
      </>
    );
  }
  const startNavigation = async () => {
    let promise!: Promise<boolean>;
    await act(async () => {
      promise = Promise.resolve(
        block({ current: { pathname: '/library/classification-assessments' }, next: { pathname: '/away' } }),
      );
    });
    return { promise };
  };
  const button = (label: string) => {
    const value = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!value) throw new Error(`Missing button: ${label}`);
    return value;
  };
  try {
    await act(async () => root.render(<Harness />));
    const draft = host.querySelector('input') as HTMLInputElement;
    expect(draft.value).toBe('Keep this exact unsent draft');

    const { promise: stayAttempt } = await startNavigation();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => button(m.library_my_ratings_stay()).click());
    expect(await stayAttempt).toBe(true);
    expect(draft.value).toBe('Keep this exact unsent draft');
    expect(retired).toBe(false);

    const { promise: leaveAttempt } = await startNavigation();
    await act(async () => button(m.library_my_ratings_leave()).click());
    const admission = leaveAttempt.then((shouldBlock) => {
      if (!shouldBlock) sequence.push('admitted');
      return shouldBlock;
    });
    expect(await admission).toBe(false);
    expect(sequence).toEqual(['retired', 'admitted']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
