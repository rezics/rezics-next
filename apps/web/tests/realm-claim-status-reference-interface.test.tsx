import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { RealmClaimStatusView } from '../src/community/realm-claim-status-page';
import { createRealmClaimCallerLifetime } from '../src/community/realm-claim-caller-lifetime';
import type {
  RealmClaimStatus,
  RealmClaimStatusAdapter,
  RealmClaimStatusRead,
} from '../src/community/realm-claim-status';
import { orphan, receipt } from '../src/stories/patterns/realm-claim/example';
import { m } from '../src/paraglide/messages.js';
import { localizeHref, setLocale } from '../src/paraglide/runtime.js';

// Reuse the claim controller's declared examples. These are not native recordings or authority proof.
const pending: RealmClaimStatus = {
  realmId: receipt.realmId,
  requestId: receipt.requestId,
  orphanedAt: receipt.orphanedAt,
  requestedAt: receipt.requestedAt,
  approvedAt: null,
  currentEpisode: true,
  state: 'pending',
};
const approved: RealmClaimStatus = {
  ...pending,
  state: 'approved',
  approvedAt: '2026-10-31T12:34:56.123456Z',
};
function own(claimRequest: RealmClaimStatus = pending): RealmClaimStatusRead {
  return {
    kind: 'ready',
    claimRequest,
    source:
      claimRequest.state === 'approved'
        ? { ...orphan, ownershipState: 'owned', governanceReadOnly: false, orphanedAt: null, claimEligibleAt: null }
        : claimRequest.currentEpisode
          ? orphan
          : { ...orphan, orphanedAt: '2026-10-30T00:00:00.000Z', claimEligibleAt: '2026-11-29T00:00:00.000Z' },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type ViewProps = ComponentProps<typeof RealmClaimStatusView>;
async function mounted(
  run: (view: {
    host: HTMLElement;
    render: (initial: RealmClaimStatusRead, props?: Partial<ViewProps>) => Promise<void>;
    tab: () => Promise<void>;
    click: (element: HTMLElement) => Promise<void>;
  }) => Promise<void>,
) {
  // Same happy-dom and user-event resolution as realm-governance-content-item.test.tsx.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/realms/example' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const adapter: RealmClaimStatusAdapter = { read: async () => own() };
  try {
    setLocale('en', { reload: false });
    await run({
      host,
      render: async (initial, props = {}) => {
        await act(async () =>
          root.render(
            <RealmClaimStatusView
              realmId={orphan.realmId}
              requestId={receipt.requestId}
              initial={initial}
              adapter={adapter}
              {...props}
            />,
          ),
        );
      },
      tab: async () => {
        await act(async () => user.tab());
      },
      click: async (element) => {
        await act(async () => user.click(element));
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    setLocale('en', { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function noReceipt(host: HTMLElement) {
  expect(host.innerHTML).not.toContain(receipt.requestId);
  for (const value of [pending.orphanedAt, pending.requestedAt, approved.approvedAt!])
    expect(host.innerHTML).not.toContain(value);
  expect(host.querySelectorAll('time, details')).toHaveLength(0);
  expect(host.querySelectorAll('h2')).toHaveLength(0);
}
function refresh(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('button');
  expect(button).not.toBeNull();
  return button!;
}

test('Own Realm claim status keeps human outcome and episode dates primary with reachable exact request reference and unchanged native retirement and refresh', async () => {
  await mounted(async ({ host, render, tab, click }) => {
    const reads: unknown[] = [];
    const adapter: RealmClaimStatusAdapter = {
      read: async (input) => {
        reads.push(input);
        return own();
      },
    };
    await render(own(), { adapter });
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(m.realm_claim_status_heading());
    expect(host.querySelectorAll('h2')).toHaveLength(1);
    const heading = host.querySelector('h2')!;
    expect(heading.textContent).toBe(m.realm_claim_pending());
    expect(heading.getAttribute('data-content-item-slot')).toBe('title');
    expect(heading.closest('article')?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(host.textContent).toContain(m.realm_claim_review_help());
    expect(host.textContent).toContain(m.realm_claim_status_authority());
    expect(host.textContent).not.toContain(m.realm_claim_status_old_episode());

    const details = host.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toBe(m.realm_status_details_reference());
    expect(details.open).toBe(false);
    expect(summary.hasAttribute('tabindex')).toBe(false);
    expect(summary.hasAttribute('role')).toBe(false);
    const reference = details.querySelector('dd')!;
    expect(reference.textContent).toBe(receipt.requestId);
    expect(reference.classList.contains('select-all')).toBe(true);
    expect(reference.classList.contains('break-all')).toBe(true);
    expect(reference.getAttribute('dir')).toBe('ltr');
    const outside = host.cloneNode(true) as HTMLElement;
    outside.querySelector('details')!.remove();
    expect(outside.innerHTML).not.toContain(receipt.requestId);
    expect(host.innerHTML.split(receipt.requestId)).toHaveLength(2);

    for (const [label, value] of [
      [m.realm_claim_orphaned_at(), pending.orphanedAt],
      [m.realm_claim_requested_at(), pending.requestedAt],
    ] as const) {
      const time = host.querySelector(`time[datetime="${value}"]`)!;
      expect(time).not.toBeNull();
      expect(time.closest('details')).toBeNull();
      expect(time.textContent).toContain('UTC');
      expect(time.textContent).toContain(value);
      expect(time.parentElement?.previousElementSibling?.textContent).toBe(label);
    }

    const back = host.querySelector<HTMLAnchorElement>('a')!;
    const check = refresh(host);
    expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(back.textContent).toBe(m.realm_claim_status_back());
    expect(back.getAttribute('href')).toBe(localizeHref(`/realms/${orphan.realmId}`));
    expect(check.textContent).toBe(m.realm_claim_status_check_again());
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(back.contains(check)).toBe(false);
    for (const control of [back, summary, check]) {
      expect(control.classList.contains('min-h-11')).toBe(true);
      expect(control.closest('a, button') === control || control === summary).toBe(true);
    }
    expect(back.className).toContain('focus-visible:outline');
    expect(summary.className).toContain('focus-visible:outline');
    await tab();
    expect(document.activeElement).toBe(back);
    await tab();
    expect(document.activeElement).toBe(summary);
    await click(summary);
    expect(details.open).toBe(true);
    await tab();
    expect(document.activeElement).toBe(check);
    expect(reads).toEqual([]);
    expect(host.textContent).not.toContain('Manage Realm');
    expect(host.textContent).not.toContain(m.realm_claim_request());
  });
});

test('current and earlier pending/approved episodes retain visible outcomes, warnings and full UTC precision at narrow, wide and RTL placements', async () => {
  await mounted(async ({ host, render }) => {
    for (const width of [390, 1280]) {
      host.style.width = `${width}px`;
      for (const direction of ['ltr', 'rtl']) {
        host.dir = direction;
        for (const state of [pending, approved]) {
          for (const currentEpisode of [true, false]) {
            const row = { ...state, currentEpisode, requestedAt: '2026-10-31T10:00:00.654321Z' };
            await render(own(row));
            expect(host.querySelector('h2')?.textContent).toBe(
              row.state === 'approved' ? m.realm_claim_status_approved() : m.realm_claim_pending(),
            );
            expect(host.textContent).toContain(
              row.state === 'approved'
                ? m.realm_claim_status_approved_help()
                : currentEpisode
                  ? m.realm_claim_review_help()
                  : m.realm_claim_status_old_pending(),
            );
            expect(host.textContent?.includes(m.realm_claim_status_old_episode())).toBe(!currentEpisode);
            expect(host.querySelectorAll('time')).toHaveLength(row.approvedAt ? 3 : 2);
            for (const value of [row.orphanedAt, row.requestedAt, ...(row.approvedAt ? [row.approvedAt] : [])]) {
              const time = host.querySelector(`time[datetime="${value}"]`)!;
              expect(time.textContent).toContain(value);
              expect(time.textContent).toContain('UTC');
              expect(time.closest('details, [hidden]')).toBeNull();
            }
            const reference = host.querySelector('details dd')!;
            expect(reference.textContent).toBe(receipt.requestId);
            expect(reference.className).not.toMatch(/truncate|line-clamp|whitespace-nowrap/u);
            expect(host.querySelector('article')?.className).toContain('[overflow-wrap:anywhere]');
            expect(host.querySelectorAll('a')).toHaveLength(1);
            expect(host.querySelectorAll('button')).toHaveLength(1);
          }
        }
      }
    }
  });
});

test('manual checks use the original exact input once, hide the receipt while busy, and recover without a new claim or automatic retry', async () => {
  await mounted(async ({ host, render, click }) => {
    const reads: Parameters<RealmClaimStatusAdapter['read']>[0][] = [];
    let reply = deferred<RealmClaimStatusRead>();
    const adapter: RealmClaimStatusAdapter = {
      read: (input) => {
        reads.push(input);
        return reply.promise;
      },
    };
    await render(own(), { adapter });
    expect(reads).toHaveLength(0);
    await click(refresh(host));
    expect(reads).toEqual([{ realmId: orphan.realmId, requestId: receipt.requestId }]);
    noReceipt(host);
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(refresh(host).disabled).toBe(true);
    expect(refresh(host).textContent).toBe(m.realm_claim_status_checking());
    expect(host.querySelector('a')?.textContent).toBe(m.realm_claim_status_back());
    await click(refresh(host));
    expect(reads).toHaveLength(1);
    await act(async () => reply.reject(new Error('Illustrative foreground read failure')));
    noReceipt(host);
    expect(host.textContent).toContain(m.realm_claim_status_unavailable());
    expect(refresh(host).disabled).toBe(false);
    expect(reads).toHaveLength(1);
    reply = deferred<RealmClaimStatusRead>();
    await click(refresh(host));
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual(reads[0]);
    await act(async () => reply.resolve(own(approved)));
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('h2')?.textContent).toBe(m.realm_claim_status_approved());
    expect(host.textContent).toContain(m.realm_claim_status_approved_help());
    expect(refresh(host).disabled).toBe(false);
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(reads).toHaveLength(2);
  });
});

test('withheld projections remove all receipt material from the DOM, including an opened reference disclosure', async () => {
  await mounted(async ({ host, render, click }) => {
    for (const kind of ['signed-out', 'denied', 'closed', 'unavailable'] as const) {
      await render(own(approved));
      await click(host.querySelector('summary')!);
      await render({ kind });
      noReceipt(host);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        kind === 'signed-out'
          ? m.realm_claim_status_signed_out()
          : kind === 'denied'
            ? m.realm_claim_status_denied()
            : kind === 'closed'
              ? m.realm_claim_status_closed()
              : m.realm_claim_status_unavailable(),
      );
    }
    await render(own(approved), { ready: false });
    noReceipt(host);
    expect(refresh(host).disabled).toBe(true);
    await render({ kind: 'signed-out' }, { ready: false });
    noReceipt(host);
    expect(host.textContent).toContain(m.realm_claim_status_signed_out());
  });
});

test('actual caller lifetime retirement withholds an admitted receipt and suppresses its late foreground result', async () => {
  await mounted(async ({ host, render, click }) => {
    const lifetime = createRealmClaimCallerLifetime(() => true);
    const reply = deferred<RealmClaimStatusRead>();
    const reads: unknown[] = [];
    const adapter: RealmClaimStatusAdapter = {
      read: (input) => {
        reads.push(input);
        return reply.promise;
      },
    };
    await render(own(approved), { lifetime, adapter });
    await click(host.querySelector('summary')!);
    await act(async () => lifetime.retire());
    await render(own(approved), { lifetime, adapter, connectionRevision: lifetime.snapshot() });
    noReceipt(host);
    expect(refresh(host).disabled).toBe(true);
    expect(reads).toHaveLength(0);

    const currentLifetime = createRealmClaimCallerLifetime(() => true);
    await render(own(), { lifetime: currentLifetime, adapter });
    await click(refresh(host));
    expect(reads).toHaveLength(1);
    await act(async () => currentLifetime.retire());
    await render(own(), { lifetime: currentLifetime, adapter, connectionRevision: currentLifetime.snapshot() });
    await act(async () => reply.resolve(own(approved)));
    noReceipt(host);
    expect(refresh(host).disabled).toBe(true);
    expect(reads).toHaveLength(1);
  });
});
