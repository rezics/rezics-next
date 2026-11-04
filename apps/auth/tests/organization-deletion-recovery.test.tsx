import { expect, test } from 'bun:test';
import {
  creationFixture,
  approval,
  button,
  dom,
  fill,
  flush,
  leave,
  open,
  send,
  session,
} from './creation-page-fixture';
import { OrganizationDeleteContent } from '../src/routes/organizations.delete';
import {
  readOrganizationDeleteStepUp,
  readOrganizationDeleteUnknown,
  storeOrganizationDeleteStepUp,
  storeOrganizationDeleteUnknown,
} from '../src/organization-delete-step-up';
import type { OrganizationDeletionRead, OrganizationDeletionReader } from '../src/organization-deletion';

creationFixture();
const human = '10000000-0000-0000-0000-000000000000';
const first = '20000000-0000-0000-0000-000000000000';
const second = '30000000-0000-0000-0000-000000000000';
const body = { account_id: human, client_id: session('delete').clientId, scope: session('delete').scopes };
const ready = (id: string): OrganizationDeletionRead => ({
  kind: 'ready',
  humanAccountId: human,
  action: 'confirm',
  account: { id, kind: 'organization', handle: 'private-name', displayName: 'Private organization' },
});
const content = (id: string, read: OrganizationDeletionReader) => (
  <OrganizationDeleteContent organizationId={id} privacyContact="mailto:privacy@example.test" read={read} />
);
const hint = {
  version: 1 as const,
  operation: 'delete' as const,
  humanAccountId: human,
  organizationId: first,
  operationKey: 'a'.repeat(32),
  returnTo: '/organizations/delete' as const,
};
const unload = () => {
  const e = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e as unknown as Event);
  return e.defaultPrevented;
};

test('single readback survives storage loss; late advice cannot affect replacement or its continuation', async () => {
  const delayed = Promise.withResolvers<OrganizationDeletionRead>();
  let reads = 0;
  const read: OrganizationDeletionReader = async ({ organizationId }) =>
    ++reads === 3 ? delayed.promise : ready(organizationId);
  const page = await open(content(first, read), body);
  await flush(() => {
    fill(page.host.querySelector('input')!, '@private-name');
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const original = readOrganizationDeleteUnknown(first);
  window.sessionStorage.clear();
  const check = button(page.host, 'Check current organization')!;
  await flush(() => {
    check.click();
    check.click();
  });
  expect(reads).toBe(3);
  expect(check.disabled).toBe(true);
  expect(page.host.querySelector('[role="status"]')!.textContent).toContain('Reading current');
  expect(unload()).toBe(true);
  // Reinstall the same conservative fence before replacing the selected target.
  expect(original.kind).toBe('pending');
  if (original.kind === 'pending') storeOrganizationDeleteUnknown(original.value);
  const replacement = { humanAccountId: human, organizationId: second, operationKey: 'b'.repeat(32) };
  storeOrganizationDeleteStepUp(replacement);
  await page.render(content(second, read));
  const input = page.host.querySelector<HTMLInputElement>('input')!;
  input.focus();
  await flush(() =>
    delayed.resolve({ kind: 'authentication-required', humanAccountId: human, action: 'authenticate' }),
  );
  expect(document.activeElement).toBe(input);
  expect(page.host.textContent).not.toContain('The deletion result is unknown');
  expect(readOrganizationDeleteStepUp()).toMatchObject({ kind: 'pending', value: replacement });
  expect(readOrganizationDeleteUnknown(first)).toEqual(original);
  expect(unload()).toBe(false);
  expect(page.calls).toHaveLength(2);
  await page.render(content(first, read));
  expect(page.host.querySelector('form')).toBeNull();
  expect(unload()).toBe(true);
  expect(page.calls).toHaveLength(2);
});

for (const malformed of [false, true])
  test(`restored ${malformed ? 'malformed' : 'exact'} hint stays conservative through page retirement and account replacement`, async () => {
    if (malformed)
      window.sessionStorage.setItem(`rezics.organization-delete.step-up.unknown.${first}`, '{"oldLabel":"secret"}');
    else storeOrganizationDeleteUnknown(hint);
    const saved = readOrganizationDeleteUnknown(first);
    let result = ready(first);
    const read: OrganizationDeletionReader = async () => result;
    const page = await open(content(first, read), body);
    expect(page.host.querySelector('form')).toBeNull();
    expect(page.host.textContent).not.toContain('Private organization');
    expect(page.host.textContent).not.toContain('secret');
    expect(unload()).toBe(true);
    await flush(leave);
    await flush(() =>
      window.dispatchEvent(new dom.PageTransitionEvent('pageshow', { persisted: true }) as unknown as Event),
    );
    expect(page.host.querySelector('form')).toBeNull();
    expect(page.host.textContent).toContain('The deletion result is unknown');
    result = { ...ready(first), humanAccountId: second } as OrganizationDeletionRead;
    await flush(() => button(page.host, 'Check current organization')!.click());
    expect(page.host.querySelector('form')).toBeNull();
    expect(page.host.textContent).not.toContain(second);
    expect(unload()).toBe(true);
    expect(readOrganizationDeleteUnknown(first)).toEqual(saved);
    expect(page.calls).toHaveLength(0);
  });
