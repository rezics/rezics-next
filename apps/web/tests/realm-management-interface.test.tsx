import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import realm from '../src/kernel/recorded/realm.json';
import type { ContainerLifecycleAdapter, LifecycleIntent, LifecycleRead } from '../src/community/container-lifecycle';
import type { RealmClaimAdapter, RealmClaimInput, RealmClaimRead } from '../src/community/realm-claim';

// Authored actual-view regression. This file is intentionally UNRUN; no native or backend proof is claimed.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const testWindow = new Window({ url: 'https://site.test/en/realms/recorded', width: 390, height: 844 });
const globals = {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  HTMLButtonElement: testWindow.HTMLButtonElement,
  HTMLTextAreaElement: testWindow.HTMLTextAreaElement,
  Element: testWindow.Element,
  Node: testWindow.Node,
  Document: testWindow.Document,
  DocumentFragment: testWindow.DocumentFragment,
  MutationObserver: testWindow.MutationObserver,
  ResizeObserver: testWindow.ResizeObserver,
  getComputedStyle: testWindow.getComputedStyle.bind(testWindow),
  requestAnimationFrame: testWindow.requestAnimationFrame.bind(testWindow),
  cancelAnimationFrame: testWindow.cancelAnimationFrame.bind(testWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { ContainerLifecycleControls } = await import('../src/community/container-lifecycle-controls');
const { RealmClaimControls } = await import('../src/community/realm-claim-controls');
const { exampleTarget } = await import('../src/stories/patterns/community-lifecycle/example');
const { orphan, eligible, receipt } = await import('../src/stories/patterns/realm-claim/example');
const { getLocale, localizeHref, setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

const longReason =
  'Repeated disruption has affected several discussion areas over an extended period. Preserve the complete review context, including every date, prior notice, response, and resolution step before this removal request.';
const longRealmTitle = `${realm.realm.title} — ${'community review and discussion '.repeat(8)}`;
const exactProblemDetail =
  'The current request could not be accepted.\nReview the current Realm state before deciding what to do next.';

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await tick();
    await Promise.resolve();
  });
}

async function mount(node: ReactNode, width = 390) {
  host = testWindow.document.createElement('main');
  host.style.width = `${width}px`;
  testWindow.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root!.render(node);
    await tick();
  });
  await flush();
  return host;
}

function button(label: string) {
  const found = [...(host?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
  await flush();
}

async function fillReason(value: string) {
  const field = host?.querySelector('textarea');
  expect(field).toBeDefined();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field!.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

beforeEach(() => {
  setLocale('en', { reload: false });
  expect(getLocale()).toBe('en');
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

afterAll(async () => {
  mock.restore();
  await testWindow.happyDOM.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Realm claim keeps current gates, full dates, and independently reachable status and reference actions', async () => {
  let reads = 0;
  const requests: RealmClaimInput[] = [];
  const adapter: RealmClaimAdapter = {
    read: async () => {
      reads++;
      return eligible;
    },
    request: async (input) => {
      requests.push(input);
      return { kind: 'pending', request: receipt };
    },
  };
  const props = {
    realmId: orphan.realmId,
    initial: eligible,
    adapter,
    returnTo: '/spaces/quiet-novel-club',
  };
  const view = await mount(createElement(RealmClaimControls, { ...props, ready: false }), 390);
  const requestButton = button(m.realm_claim_request());
  expect(requestButton.disabled).toBe(true);
  expect(view.querySelector('section')?.getAttribute('aria-labelledby')).toBe(
    view.querySelector('h2')?.getAttribute('id'),
  );
  expect(view.querySelector('[data-content-item-slot="title"]')).toBeDefined();
  expect(view.querySelector('[data-slot="content-item-frame"]')).toBeDefined();
  await click(m.realm_claim_request());
  expect(requests).toHaveLength(0);

  await act(async () => {
    root!.render(createElement(RealmClaimControls, { ...props, ready: true }));
    await tick();
  });
  await click(m.realm_claim_request());
  expect(requests).toHaveLength(1);
  expect(requests[0]!.realmId).toBe(orphan.realmId);
  expect(requests[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/iu);
  expect(reads).toBe(0);
  expect(view.textContent).toContain(m.realm_claim_pending());

  const dates = [...view.querySelectorAll('time')];
  expect(dates.map((date) => date.getAttribute('datetime'))).toEqual([
    orphan.orphanedAt,
    orphan.claimEligibleAt,
    receipt.requestedAt,
  ]);
  expect(dates.every((date) => date.textContent?.includes('UTC'))).toBe(true);

  const details = [...view.querySelectorAll('details')].find(
    (item) => item.querySelector('summary')?.textContent?.trim() === m.community_management_details_claim_summary(),
  );
  expect(details).toBeDefined();
  const summary = details!.querySelector('summary');
  expect(summary?.tagName).toBe('SUMMARY');
  expect(summary?.className).toContain('focus-visible:outline');
  summary!.focus();
  expect(testWindow.document.activeElement).toBe(summary);
  summary!.click();
  await flush();
  const reference = [...details!.querySelectorAll('dd')].find((item) => item.textContent === receipt.requestId);
  expect(reference?.className).toContain('break-all');
  expect(details!.querySelector('button')?.textContent?.trim()).toBe(m.realm_claim_copy());

  const statusLink = [...view.querySelectorAll('a')].find(
    (item) => item.textContent?.trim() === m.realm_claim_status_open(),
  );
  expect(statusLink?.getAttribute('href')).toBe(
    localizeHref(`/realms/${orphan.realmId}/claim-requests/${receipt.requestId}`),
  );
  expect(details!.contains(statusLink)).toBe(false);
  expect(statusLink?.parentElement?.className).toContain('flex-wrap');

  if (root) await act(async () => root!.unmount());
  root = null;
  view.remove();
  host = null;
  const missingAdmission: RealmClaimRead = { kind: 'ready', snapshot: orphan, admission: 'unavailable' };
  let unavailableRequests = 0;
  const unavailableAdapter: RealmClaimAdapter = {
    read: async () => {
      reads++;
      return missingAdmission;
    },
    request: async () => {
      unavailableRequests++;
      return { kind: 'unavailable' };
    },
  };
  const withheld = await mount(
    createElement(RealmClaimControls, {
      realmId: orphan.realmId,
      initial: missingAdmission,
      adapter: unavailableAdapter,
      returnTo: '/spaces/quiet-novel-club',
    }),
    1280,
  );
  expect(withheld.querySelector('button')).toBeNull();
  expect(withheld.textContent).toContain(m.realm_claim_admission_unavailable());
  expect(reads).toBe(0);
  expect(unavailableRequests).toBe(0);
});

test('lifecycle view retains complete reason and refusal details while keeping current actions gated', async () => {
  let reads = 0;
  let changes = 0;
  let destinations = 0;
  let sentIntent: LifecycleIntent | undefined;
  const snapshot = {
    target: exampleTarget,
    head: realm.realm.headRevisionId,
    version: 'current-version',
    contextId: realm.realm.contextId,
    state: 'active' as const,
    actions: ['remove'] as const,
  };
  const adapter: ContainerLifecycleAdapter = {
    read: async () => {
      reads++;
      return { kind: 'ready', snapshot } satisfies LifecycleRead;
    },
    change: async (intent) => {
      changes++;
      sentIntent = intent;
      return { kind: 'refused', status: 403, code: 'review_required', detail: exactProblemDetail };
    },
    destination: async () => {
      destinations++;
      return { kind: 'unavailable' };
    },
  };
  const view = await mount(
    createElement(ContainerLifecycleControls, { target: exampleTarget, title: longRealmTitle, adapter }),
    390,
  );
  expect(reads).toBe(1);
  expect(view.querySelector('section')?.getAttribute('aria-labelledby')).toBe(
    view.querySelector('h2')?.getAttribute('id'),
  );
  expect(view.querySelector('[data-content-item-slot="title"]')).toBeDefined();
  expect(view.textContent).toContain(longRealmTitle);
  expect(view.querySelector('header p')?.className).toContain('[overflow-wrap:anywhere]');

  await fillReason(longReason);
  expect(view.querySelector('textarea')?.value).toBe(longReason);
  await click(m.container_lifecycle_remove());
  await click(m.container_lifecycle_confirm());
  expect(changes).toBe(1);
  expect(sentIntent?.reason).toBe(longReason);
  expect(reads).toBe(1);
  expect(destinations).toBe(0);

  const alert = view.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe(m.container_lifecycle_refused());
  expect(alert?.textContent).not.toContain('403');
  expect(alert?.textContent).not.toContain('review_required');
  expect(alert?.textContent).not.toContain(exactProblemDetail);
  const details = [...view.querySelectorAll('details')].find(
    (item) => item.querySelector('summary')?.textContent?.trim() === m.community_management_details_problem_summary(),
  );
  expect(details).toBeDefined();
  const summary = details!.querySelector('summary');
  summary!.focus();
  expect(testWindow.document.activeElement).toBe(summary);
  summary!.click();
  await flush();
  expect(details!.textContent).toContain('403');
  expect(details!.textContent).toContain('review_required');
  const explanation = [...details!.querySelectorAll('dd')].find((item) => item.textContent === exactProblemDetail);
  expect(explanation?.className).toContain('whitespace-pre-wrap');
  expect(explanation?.className).toContain('[overflow-wrap:anywhere]');
  expect(view.querySelector('textarea')?.value).toBe(longReason);

  if (root) await act(async () => root!.unmount());
  root = null;
  view.remove();
  host = null;
  const readOnlyAdapter: ContainerLifecycleAdapter = {
    read: async () => ({ kind: 'ready', snapshot: { ...snapshot, actions: [] } }),
    change: async () => {
      throw new Error('A current read-only fixture must not submit a command.');
    },
    destination: async () => ({ kind: 'unavailable' }),
  };
  const readOnly = await mount(
    createElement(ContainerLifecycleControls, {
      target: exampleTarget,
      title: longRealmTitle,
      adapter: readOnlyAdapter,
    }),
    1280,
  );
  expect(readOnly.textContent).toContain(m.container_lifecycle_read_only());
  expect(
    [...readOnly.querySelectorAll('button')].some(
      (item) => item.textContent?.trim() === m.container_lifecycle_remove(),
    ),
  ).toBe(false);
  expect(
    [...readOnly.querySelectorAll('button')].some(
      (item) => item.textContent?.trim() === m.container_lifecycle_restore(),
    ),
  ).toBe(false);
});

test('lifecycle controls withhold commands while current state is loading', async () => {
  let reads = 0;
  let changes = 0;
  const adapter: ContainerLifecycleAdapter = {
    read: () => {
      reads++;
      return new Promise<LifecycleRead>(() => {});
    },
    change: async () => {
      changes++;
      return { kind: 'unavailable' };
    },
    destination: async () => ({ kind: 'unavailable' }),
  };
  const view = await mount(
    createElement(ContainerLifecycleControls, { target: exampleTarget, title: longRealmTitle, adapter }),
    390,
  );
  expect(reads).toBe(1);
  expect(view.textContent).toContain(m.container_lifecycle_loading());
  expect(
    [...view.querySelectorAll('button')].some((item) => item.textContent?.trim() === m.container_lifecycle_remove()),
  ).toBe(false);
  expect(
    [...view.querySelectorAll('button')].some((item) => item.textContent?.trim() === m.container_lifecycle_restore()),
  ).toBe(false);
  expect(changes).toBe(0);
});
