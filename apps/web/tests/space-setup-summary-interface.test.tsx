import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { SetupCommand, SetupFailure, SetupSnapshot } from '../src/community/space-setup';
import type { SetupTransport } from '../src/stories/patterns/space-setup/space-setup';
import type { BoardChoiceSource } from '../src/community/setup-board-picker';

// Actual canonical view and callbacks with explicit transport fixtures. Authored UNRUN.
// Browser keyboard activation, physical 44px targets, 390/1280 layout and RTL remain integration assertions.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

// Only supply the framework's server import boundary; no cache, session or SSR admission is injected.
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SpaceSetupForm, emptySetup } = await import('../src/stories/patterns/space-setup/space-setup');
const { SpaceSetupCallerLifetimeContext, standaloneSpaceSetupLifetime } =
  await import('../src/community/space-setup-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const { localizeUrl, setLocale } = await import('../src/paraglide/runtime.js');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const context = { id: id(3), label: 'Reading together' };
const scheme = { id: id(4), label: 'Reading topics' };
const topic = { id: id(5), label: 'Introductions' };
const boardId = id(6);
const longTitle = 'Reading across languages — ' + 'UnbrokenCommunityTitle'.repeat(18);
const saved: SetupSnapshot = {
  kind: 'ready',
  space: {
    id: id(1),
    head: id(7),
    title: longTitle,
    summary: 'A supplied Space summary.',
    address: 'reading-together',
    realmId: id(2),
  },
  realm: {
    id: id(2),
    head: id(8),
    title: 'Evening readers',
    summary: '',
    visibility: 'protected',
    contextId: context.id,
    schemeId: scheme.id,
  },
  permitted: { address: true, settings: true, scheme: true, board: true },
};
const unavailable: SetupFailure = { kind: 'failure', reason: 'unavailable', status: 503 };
const source: BoardChoiceSource = {
  schemes: async () => ({ schemes: [scheme], next: null }),
  concepts: async () => ({ concepts: [topic], next: null }),
};
function boundary(initial = saved): SetupTransport {
  return {
    command: async () => unavailable,
    read: async () => initial,
    choice: async (_kind, requested) => ({ id: requested, label: context.label }),
  };
}
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
async function tick(milliseconds = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}
async function mount(
  initial: SetupSnapshot | SetupFailure,
  transport: SetupTransport,
  caller = standaloneSpaceSetupLifetime(),
  dir: 'ltr' | 'rtl' = 'ltr',
) {
  setLocale('en', { reload: false });
  host.dir = dir;
  const route = createRootRoute({
    component: () => (
      <SpaceSetupCallerLifetimeContext.Provider value={caller}>
        <SpaceSetupForm initial={initial} transport={transport} boardChoices={source} />
      </SpaceSetupCallerLifetimeContext.Provider>
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/realms/new'] }) });
  await router.load();
  root = createRoot(host);
  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  await tick();
  return caller;
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await tick();
}
async function edit(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await tick();
}
async function submit() {
  const form = host.querySelector('form');
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await tick();
}
function directlyVisible(text: string) {
  const nodes = [...host.querySelectorAll('p, dt, label')].filter((node) => node.textContent === text);
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) expect(node.closest('details')).toBeNull();
}
function noResult() {
  expect(host.textContent).not.toContain(m.space_setup_complete());
  expect(host.querySelector(`a[href*="/boards/"]`)).toBeNull();
}
afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  root = undefined;
  await tick();
});
afterAll(() => {
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Finish Space setup summary and optional guidance hierarchy: current step, native disclosure and required form stay distinct', async () => {
  let commands = 0;
  let reads = 0;
  await mount(emptySetup, {
    ...boundary(emptySetup),
    command: async () => {
      commands++;
      return unavailable;
    },
    read: async () => {
      reads++;
      return emptySetup;
    },
  });
  expect(host.querySelectorAll('form')).toHaveLength(1);
  expect(host.querySelector('input')?.required).toBe(true);
  expect(host.querySelector('textarea')?.required).toBe(false);
  expect(host.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="step"]')?.textContent?.trim()).toBe(m.space_setup_identity());
  expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_identity());
  const details = host.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  expect(summary.textContent).toBe(m.space_setup_details_heading());
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(m.space_setup_identity_hint());
  expect(summary.hasAttribute('role')).toBe(false);
  expect(summary.hasAttribute('tabindex')).toBe(false);
  expect(summary.className).toContain('focus-visible:outline');
  summary.focus();
  expect(window.document.activeElement).toBe(summary);
  await click(summary);
  expect(details.open).toBe(true);
  await click(summary);
  expect(details.open).toBe(false);
  directlyVisible(m.space_setup_saved_hint());
  directlyVisible(m.space_setup_title_hint());
  expect(host.textContent).toContain(m.space_setup_not_saved());
  expect(host.textContent).not.toContain(saved.space!.title);
  expect(commands).toBe(0);
  expect(reads).toBe(0);
  noResult();
});

test('supplied saved title uses the shared heading; Realm warning, missing choice and exact advanced reference remain visible', async () => {
  const commands: SetupCommand[] = [];
  await mount(saved, {
    ...boundary(),
    command: async (command) => {
      commands.push(command);
      return unavailable;
    },
  });
  const title = host.querySelector('h3[data-content-item-slot="title"]')!;
  expect(title.textContent).toBe(longTitle);
  expect(title.closest('article')?.textContent).toContain(saved.space!.summary);
  expect(title.closest('a')).toBeNull();
  await click(button(m.space_setup_realm()));
  expect(host.querySelector('[aria-current="step"]')?.textContent?.trim()).toBe(m.space_setup_realm());
  expect(window.document.activeElement).toBe(host.querySelector('section h2'));
  expect(host.querySelector('details')?.textContent).toContain(m.space_setup_realm_hint());
  directlyVisible(m.space_setup_authority());
  directlyVisible(m.space_setup_protected_hint());
  expect(button(m.space_setup_continue()).disabled).toBe(false);
  await edit(host.querySelector<HTMLInputElement>('input:not([type="search"])')!, 'Evening readers, updated');
  expect(button(m.space_setup_save_settings()).disabled).toBe(true);
  const advanced = [...host.querySelectorAll('details')].find((node) =>
    node.textContent?.includes(m.space_setup_reference()),
  );
  expect(advanced?.open).toBe(true);
  expect(advanced?.querySelector('input')?.value).toBe(context.id);
  expect(advanced?.querySelector('input')?.maxLength).toBe(36);
  await click(button(m.setup_context_use_current()));
  expect(button(m.space_setup_save_settings()).disabled).toBe(false);
  expect(commands).toHaveLength(0);
  await click(button(m.space_setup_back()));
  expect(host.querySelector('[aria-current="step"]')?.textContent?.trim()).toBe(m.space_setup_identity());
});

test('result keeps supplied context, placement and visibility with independent Open board and home destinations in RTL', async () => {
  const commands: SetupCommand[] = [];
  await mount(
    saved,
    {
      ...boundary(),
      command: async (command) => {
        commands.push(command);
        return { kind: 'board', id: boardId };
      },
    },
    undefined,
    'rtl',
  );
  await click(button(m.space_setup_board()));
  await tick(280);
  await edit(host.querySelector<HTMLInputElement>('input:not([type="search"])')!, longTitle);
  const radio =
    [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (node) => node.getAttribute('value') === topic.id || node.textContent?.includes(topic.label),
    ) ?? host.querySelector<HTMLElement>('[role="radio"]');
  expect(radio).not.toBeNull();
  await click(radio!);
  await submit();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    step: 'board',
    realmId: saved.realm!.id,
    conceptId: topic.id,
    title: longTitle,
    visibility: 'published',
    purpose: 'discussion',
  });
  const result = host.querySelector(`article[aria-label="${m.space_setup_complete()}"]`)!;
  expect(result.querySelector('h3[data-content-item-slot="title"]')?.textContent).toBe(longTitle);
  for (const text of [saved.space!.title, saved.realm!.title, context.label, topic.label, m.space_setup_public()])
    expect(result.textContent).toContain(text);
  const open = result.querySelector<HTMLAnchorElement>('[data-content-item-slot="actions"] a')!;
  expect(open.textContent?.trim()).toBe(m.space_setup_open_board());
  expect(open.getAttribute('href')).toBe(localizeUrl(new URL(`/boards/${boardId}`, 'https://site.test')).pathname);
  const home = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
    (node) => node.textContent?.trim() === m.space_setup_home(),
  )!;
  expect(home.getAttribute('href')).toBe(
    localizeUrl(new URL('/spaces/reading-together', 'https://site.test')).pathname,
  );
  for (const control of [open, home]) {
    expect(control.className).toContain('min-h-11');
    expect(control.parentElement?.closest('a, button')).toBeNull();
    control.focus();
    expect(window.document.activeElement).toBe(control);
  }
  expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('a a, a button, button a')).toBeNull();
});

test('paused setup preserves the entered draft and explicit uncertain retry replays the exact command', async () => {
  const commands: SetupCommand[] = [];
  const transport: SetupTransport = {
    ...boundary(emptySetup),
    command: async (command) => {
      commands.push(command);
      return unavailable;
    },
  };
  await mount(emptySetup, transport);
  await edit(host.querySelector('input')!, 'Keep this entered title');
  await click(button(m.editor_cancel()));
  expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_paused());
  directlyVisible(m.space_setup_paused_hint());
  directlyVisible(m.space_setup_saved_hint());
  expect(host.querySelector('form')).toBeNull();
  expect(commands).toHaveLength(0);
  await click(button(m.space_setup_resume()));
  expect(host.querySelector('input')?.value).toBe('Keep this entered title');
  await submit();
  directlyVisible(m.space_setup_unavailable());
  expect(commands).toHaveLength(1);
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  await click(button(m.space_setup_retry()));
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(Object.isFrozen(commands[0])).toBe(true);
  noResult();
});

test('denied, invalid and stale results stay visible with explicit manual refresh', async () => {
  let reads = 0;
  let reason: 'denied' | 'invalid' | 'conflict' = 'denied';
  await mount(saved, {
    ...boundary(),
    command: async () => ({
      kind: 'failure',
      reason,
      status: reason === 'denied' ? 403 : reason === 'conflict' ? 409 : 422,
    }),
    read: async () => {
      reads++;
      return saved;
    },
  });
  await edit(host.querySelector('input')!, 'updated-address');
  await submit();
  directlyVisible(m.space_setup_denied());
  expect(reads).toBe(0);
  noResult();
  await click(button(m.space_setup_refresh()));
  expect(reads).toBe(1);
  reason = 'invalid';
  await submit();
  directlyVisible(m.space_setup_invalid());
  noResult();
  reason = 'conflict';
  await submit();
  directlyVisible(m.space_setup_conflict());
  expect(reads).toBe(1);
  await click(button(m.space_setup_refresh()));
  expect(reads).toBe(2);
  noResult();
});

test('retirement removes supplied private identity and rejects a late command result and further callbacks', async () => {
  let resolve!: (value: { kind: 'space'; space: NonNullable<SetupSnapshot['space']> }) => void;
  let reads = 0;
  let writes = 0;
  const caller = await mount(saved, {
    ...boundary(),
    command: async () => {
      writes++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    read: async () => {
      reads++;
      return saved;
    },
  });
  await edit(host.querySelector('input')!, 'pending-address');
  const oldSubmit = button(m.space_setup_save_address());
  await submit();
  await act(async () => {
    caller.retire();
  });
  expect(host.textContent).not.toContain(longTitle);
  expect(host.textContent).not.toContain(saved.realm!.title);
  expect(host.querySelectorAll('button, a, input, details')).toHaveLength(0);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.space_setup_unavailable());
  await act(async () => {
    resolve({ kind: 'space', space: { ...saved.space!, title: 'Late private title' } });
  });
  await click(oldSubmit);
  expect(writes).toBe(1);
  expect(reads).toBe(0);
  expect(host.textContent).not.toContain('Late private title');
  noResult();
});

test('current denied rights retain explicit recovery without a writable or success fallback', async () => {
  const denied: SetupSnapshot = {
    ...saved,
    permitted: { address: false, settings: false, scheme: false, board: false },
  };
  let reads = 0;
  let writes = 0;
  await mount(denied, {
    ...boundary(denied),
    command: async () => {
      writes++;
      return unavailable;
    },
    read: async () => {
      reads++;
      return denied;
    },
  });
  directlyVisible(m.space_setup_denied());
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('h3')?.textContent).toBe(longTitle);
  await click(button(m.space_setup_board()));
  directlyVisible(m.space_setup_denied());
  expect(button(m.space_setup_create_board()).disabled).toBe(true);
  await click(button(m.space_setup_refresh()));
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  noResult();
});

test('a withheld Context name remains unavailable in a supplied creation result without inventing a name or reference', async () => {
  await mount(saved, {
    ...boundary(),
    choice: async () => ({ kind: 'failure', reason: 'denied', status: 403 }),
    command: async () => ({ kind: 'board', id: boardId }),
  });
  await click(button(m.space_setup_board()));
  await tick(280);
  await edit(host.querySelector<HTMLInputElement>('input:not([type="search"])')!, 'A supplied board title');
  await click(host.querySelector<HTMLElement>('[role="radio"]')!);
  await submit();
  const result = host.querySelector(`article[aria-label="${m.space_setup_complete()}"]`)!;
  expect(result.querySelector('h3')?.textContent).toBe('A supplied board title');
  expect(result.textContent).toContain(m.space_setup_details_name_unavailable());
  expect(result.textContent).not.toContain(context.label);
  expect(result.textContent).not.toContain(context.id);
  expect(result.querySelector('a')?.getAttribute('href')).toBe(
    localizeUrl(new URL(`/boards/${boardId}`, 'https://site.test')).pathname,
  );
});

test('an unavailable initial read exposes recovery and required fields while keeping creation disabled', async () => {
  let reads = 0;
  let writes = 0;
  await mount(unavailable, {
    ...boundary(emptySetup),
    command: async () => {
      writes++;
      return unavailable;
    },
    read: async () => {
      reads++;
      return unavailable;
    },
  });
  directlyVisible(m.space_setup_unavailable());
  expect(host.querySelector('input')?.required).toBe(true);
  expect(button(m.space_setup_create_space()).disabled).toBe(true);
  expect(host.querySelector('h3')).toBeNull();
  await click(button(m.space_setup_refresh()));
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  noResult();
});
