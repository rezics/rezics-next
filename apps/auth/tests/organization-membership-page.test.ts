import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { MembershipPage } from '../src/organization-membership';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { OrganizationMembershipRoster } = await import('../src/routes/organizations.members');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const organizationId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const ownerPage: Extract<MembershipPage, { kind: 'ready' }> = {
  kind: 'ready',
  organizationId,
  viewer: { accountId: ownerId, role: 'owner', leave: 'unavailable' },
  members: {
    state: 'ready',
    holders: [
      { accountId: ownerId, account: null, role: 'owner', actions: { changeRole: 'last-owner', remove: 'last-owner' } },
      {
        accountId: memberId,
        account: { id: memberId, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' },
        role: 'member',
        actions: { changeRole: 'allowed', remove: 'allowed' },
      },
    ],
    next: null,
  },
};
const memberPage: Extract<MembershipPage, { kind: 'ready' }> = {
  kind: 'ready',
  organizationId,
  viewer: { accountId: memberId, role: 'member', leave: 'unavailable' },
  members: { state: 'unavailable' },
};
const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
async function render(page: typeof ownerPage | typeof memberPage) {
  await act(async () => {
    root.render(
      createElement(OrganizationMembershipRoster, {
        page,
        busy: false,
        pending: false,
        onSelect: () => {},
        onReload: () => {},
      }),
    );
  });
}
afterAll(async () => {
  await act(async () => root.unmount());
  host.remove();
  await dom.happyDOM.close();
});

test('shows disclosed identity and last-owner advice, while a member has no owner editor', async () => {
  await render(ownerPage);
  expect(host.textContent).toContain('Rae Reader');
  expect(host.textContent).toContain(m.auth_members_identity_unavailable());
  expect(host.querySelector('details code')?.textContent).toBe(ownerId);
  expect(host.textContent).toContain(m.auth_members_last_owner());
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent === m.auth_members_remove() && button.disabled,
    ),
  ).toBe(true);
  await render(memberPage);
  expect(host.textContent).toContain(m.auth_members_leave_unavailable());
  expect(host.textContent).toContain(m.auth_members_inventory_unavailable());
  expect(
    [...host.querySelectorAll('button')].some((button) => button.textContent === m.auth_members_change_role()),
  ).toBe(false);
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.auth_members_remove())).toBe(
    false,
  );
});
