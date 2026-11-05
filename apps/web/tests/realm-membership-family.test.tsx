import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RealmParticipationView } from '../src/community/realm-participation';
import { RealmLeaveRecovery } from '../src/community/realm-leave-recovery.tsx';
import { m } from '../src/paraglide/messages.js';

type Participation = ComponentProps<typeof RealmParticipationView>;
type Recovery = ComponentProps<typeof RealmLeaveRecovery>;
const noop = () => {};
const participation: Participation = { state: 'none', visibility: 'public', onChange: noop, onRetry: noop };
const recovery: Recovery = {
  realmId: 'supplied-realm',
  recovery: { kind: 'refused', ownerReason: 'unavailable' },
  check: null,
  busy: false,
  ready: true,
  onCheck: noop,
  onRetry: noop,
};

function membership(props: Partial<Participation> = {}) {
  return renderToStaticMarkup(<RealmParticipationView {...participation} {...props} />);
}

function leave(props: Partial<Recovery> = {}) {
  return renderToStaticMarkup(<RealmLeaveRecovery {...recovery} {...props} />);
}

// UNRUN: supplied-state presentation regression, not native membership/Access or browser geometry proof.
test('Complete Realm membership and leave recovery hierarchy', () => {
  for (const html of [membership(), leave()]) {
    const headingId = html.match(/<h2\b[^>]*id="([^"]+)"/u)?.[1];
    expect(headingId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${headingId}"`);
    expect(html).toContain('data-content-item-slot="title"');
    expect(html).toContain('data-content-item-slot="actions"');
    expect(html).toContain('has-[:focus-visible]');
    expect(html).not.toMatch(/<(?:details|summary|article|a)\b|aria-hidden|\shidden[=> ]/u);
  }
  expect(membership()).toContain(`>${m.realm_join()}</button>`);
  expect(membership({ state: 'member' })).toContain(`>${m.realm_leave()}</button>`);

  for (const admittedAction of [undefined, null, 'join', 'leave', 'sign-in'] as const) {
    expect(membership({ admittedAction }).includes(`>${m.realm_join()}</button>`)).toBe(
      admittedAction === undefined || admittedAction === 'join',
    );
    expect(membership({ state: 'member', admittedAction }).includes(`>${m.realm_leave()}</button>`)).toBe(
      admittedAction === undefined || admittedAction === 'leave',
    );
    expect(membership({ visibility: 'protected', admittedAction })).not.toContain(`>${m.realm_join()}</button>`);
  }
  const protectedHtml = membership({ visibility: 'protected' });
  expect(protectedHtml).toContain(m.realm_protected_admission());
  expect(membership({ state: 'member', visibility: 'protected' })).toContain(m.realm_protected_note());
  expect(membership({ state: 'banned' })).toContain(m.realm_banned());
  expect(membership({ state: 'banned' })).not.toContain('<button');
  expect(membership({ state: 'loading' })).toContain(m.realm_membership_loading());
  expect(membership({ state: 'loading' })).not.toContain('<button');
  expect(membership({ state: 'unavailable' })).toContain(m.realm_membership_unavailable());
  expect(membership({ state: 'unavailable' })).toContain(m.realm_membership_retry());

  for (const [refresh, status] of [
    [null, m.realm_membership_still_pending()],
    ['pending', m.realm_membership_still_pending()],
    ['checking', m.realm_membership_checking()],
    ['unavailable', m.realm_membership_pending_unavailable()],
  ] as const) {
    const html = membership({ state: 'pending', refresh });
    expect(html).toContain(m.realm_state_pending());
    expect(html).toContain(status);
    expect(html).not.toContain(`>${m.realm_join()}</button>`);
    expect(html).not.toContain(`>${m.realm_leave()}</button>`);
    expect(html.includes(m.realm_membership_retry())).toBe(refresh !== 'checking');
    expect(html.indexOf('data-content-item-slot="state"')).toBeLessThan(
      html.indexOf('data-content-item-slot="actions"'),
    );
  }
  const withheld = 'WITHHELD_NATIVE_DETAIL <private-owner data-private="secret">';
  for (const outcome of ['refused', 'closed'] as const) {
    const problem = { outcome, detail: withheld };
    const html = membership({ state: 'member', problem });
    expect(html).toContain(outcome === 'closed' ? m.realm_change_closed() : m.realm_change_failed());
    expect(html).not.toContain('WITHHELD_NATIVE_DETAIL');
    expect(html).not.toContain('private-owner');
    expect(html).not.toContain('data-slot="badge"');
    expect(html).not.toContain(`>${m.realm_leave()}</button>`);
    expect(html).toContain(m.realm_membership_retry());
    expect(membership({ state: 'pending', refresh: 'checking', problem })).toContain(m.realm_membership_loading());
    expect(membership({ state: 'pending', refresh: 'unavailable', problem })).toContain(
      m.realm_membership_current_pending(),
    );
  }

  const refused = leave();
  expect(refused).toContain(m.realm_leave_refused());
  expect(refused).toContain(m.realm_leave_owner_policy());
  expect(refused).toContain(m.realm_leave_check_before_retry());
  expect(refused).toContain(m.realm_leave_review_access());
  expect(refused).not.toContain(m.realm_leave_owner_required());
  expect(refused).not.toContain(m.realm_leave_retry_same());
  expect(refused).not.toContain('href=');
  expect(refused).not.toContain(recovery.realmId);
  const owner = leave({ recovery: { kind: 'refused', ownerReason: 'last-owner' } });
  expect(owner).toContain(m.realm_leave_owner_required());
  expect(owner).not.toContain(m.realm_leave_owner_policy());
  const uncertain = leave({ recovery: { kind: 'uncertain', ownerReason: 'unavailable' } });
  expect(uncertain).toContain(m.realm_leave_uncertain());
  expect(uncertain).toContain(m.realm_leave_retry_same());
  expect(uncertain).not.toContain(m.realm_leave_review_access());
  expect(uncertain).not.toContain(m.realm_leave_owner_required());
  expect(uncertain).not.toContain(m.realm_leave_owner_policy());
  expect(uncertain).not.toContain('href=');
  for (const [check, status] of [
    ['checking', m.realm_leave_checking()],
    ['unavailable', m.realm_leave_check_unavailable()],
    ['unchanged', m.realm_leave_not_settled()],
  ] as const) {
    const html = leave({ check });
    expect(html).toContain(status);
    expect(html.indexOf(status)).toBeLessThan(html.indexOf('data-content-item-slot="actions"'));
  }
});

// UNRUN: focus and dispatch observations; real Enter/Space and 44px measurements belong to the browser stories.
test('membership controls preserve readiness, manual checks and independent long-text instances at 390/1280 and RTL', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/spaces/atlas' });
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
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const changes: string[] = [];
  const checks: string[] = [];
  const retries: string[] = [];
  const longLabel =
    'A community reading and discussing translated fiction together · '.repeat(8) + 'LongUnbrokenLabel'.repeat(12);
  const button = (scope: Element, label: string) => {
    const node = [...scope.querySelectorAll('button')].find((item) => item.textContent === label);
    if (!node) throw new Error(`Missing button: ${label}`);
    return node as unknown as HTMLButtonElement;
  };
  const paint = async (busy = false, ready = true, refresh: Participation['refresh'] = null) => {
    await act(async () =>
      root.render(
        <div>
          <div data-instance="first">
            <RealmParticipationView
              {...participation}
              state="member"
              memberLabel={longLabel}
              busy={busy}
              ready={ready}
              onChange={(action) => changes.push(`first:${action}`)}
            />
            <RealmLeaveRecovery {...recovery} busy={busy} ready={ready} onCheck={() => checks.push('first')} />
          </div>
          <div data-instance="second">
            <RealmParticipationView
              {...participation}
              busy={busy}
              ready={ready}
              onChange={(action) => changes.push(`second:${action}`)}
            />
            <RealmLeaveRecovery
              {...recovery}
              recovery={{ kind: 'uncertain', ownerReason: 'unavailable' }}
              busy={busy}
              ready={ready}
              onCheck={() => checks.push('second')}
              onRetry={() => retries.push('second')}
            />
          </div>
          <div data-instance="pending">
            <RealmParticipationView
              {...participation}
              state="pending"
              busy={busy}
              refresh={refresh}
              onRetry={() => checks.push('pending')}
            />
          </div>
        </div>,
      ),
    );
  };
  try {
    for (const width of [390, 1280])
      for (const direction of ['ltr', 'rtl']) {
        host.style.width = `${width}px`;
        host.dir = direction;
        await paint();
        const sections = [...host.querySelectorAll('section')];
        const ids = sections.map((section) => section.getAttribute('aria-labelledby'));
        expect(new Set(ids).size).toBe(sections.length);
        for (const section of sections) {
          expect(section.querySelector('h2')?.id).toBe(section.getAttribute('aria-labelledby'));
          expect(section.querySelector('h2')?.textContent).toBe(
            section.hasAttribute('data-member-state') ? m.realm_membership_label() : m.realm_leave_recovery_label(),
          );
        }
        expect(host.textContent).toContain(longLabel);
        expect(host.querySelector('details, [hidden], a, button button, button a')).toBeNull();
        for (const node of host.querySelectorAll('button')) {
          expect(node.className).toContain('min-h-11');
          expect(node.className).toContain('min-w-11');
          expect(node.className).toContain('h-auto');
          expect(node.className).toContain('whitespace-normal');
          expect(node.closest('[data-slot="list-row-control"]')).not.toBeNull();
          await act(async () => node.focus());
          expect(window.document.activeElement).toBe(node);
        }
      }
    const first = host.querySelector('[data-instance="first"]')!;
    const second = host.querySelector('[data-instance="second"]')!;
    const pending = host.querySelector('[data-instance="pending"]')!;
    await act(async () => button(first, m.realm_leave()).click());
    await act(async () => button(second, m.realm_join()).click());
    expect(changes).toEqual(['first:leave', 'second:join']);
    await act(async () => button(first, m.realm_membership_retry()).click());
    await act(async () => button(second, m.realm_membership_retry()).click());
    await act(async () => button(pending, m.realm_membership_retry()).click());
    expect(checks).toEqual(['first', 'second', 'pending']);
    expect(retries).toEqual([]);
    expect(changes).toHaveLength(2);
    await act(async () => button(second, m.realm_leave_retry_same()).click());
    expect(retries).toEqual(['second']);
    expect(checks).toHaveLength(3);

    await paint(true, true);
    for (const node of [
      button(first, m.realm_leave()),
      button(second, m.realm_join()),
      button(second, m.realm_leave_retry_same()),
      button(second, m.realm_membership_retry()),
      button(pending, m.realm_membership_retry()),
    ]) {
      expect(node.disabled).toBe(true);
      await act(async () => node.click());
    }
    expect(changes).toHaveLength(2);
    expect(checks).toHaveLength(3);
    expect(retries).toHaveLength(1);
    await paint(false, false);
    expect(button(first, m.realm_leave()).disabled).toBe(true);
    expect(button(second, m.realm_join()).disabled).toBe(true);
    expect(button(second, m.realm_leave_retry_same()).disabled).toBe(true);
    expect(button(second, m.realm_membership_retry()).disabled).toBe(false);
    await paint(false, true, 'checking');
    expect(pending.querySelector('button')).toBeNull();
    expect(pending.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(pending.textContent).toContain(m.realm_membership_checking());
    await paint(false, true, 'unavailable');
    expect(pending.textContent).toContain(m.realm_membership_pending_unavailable());
    expect(button(pending, m.realm_membership_retry()).disabled).toBe(false);
    expect(changes).toHaveLength(2);
    expect(retries).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
