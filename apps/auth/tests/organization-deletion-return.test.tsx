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
import { readOrganizationDeleteUnknown, storeOrganizationDeleteUnknown } from '../src/organization-delete-step-up';
import type { OrganizationDeletionRead, OrganizationDeletionReader } from '../src/organization-deletion';

creationFixture();
const human = '10000000-0000-0000-0000-000000000000';
const replacementHuman = '30000000-0000-0000-0000-000000000000';
const organization = '20000000-0000-0000-0000-000000000000';
const body = { account_id: human, client_id: session('delete').clientId, scope: session('delete').scopes };
const ready = (viewer = human, handle = 'private-name'): OrganizationDeletionRead => ({
  kind: 'ready',
  humanAccountId: viewer,
  action: 'confirm',
  account: { id: organization, kind: 'organization', handle, displayName: 'Private organization' },
});
const content = (read: OrganizationDeletionReader) => (
  <OrganizationDeleteContent organizationId={organization} privacyContact="mailto:privacy@example.test" read={read} />
);
const persistedShow = () =>
  window.dispatchEvent(new dom.PageTransitionEvent('pageshow', { persisted: true }) as unknown as Event);

test('a held preflight returns as known unsent and deliberate review is usable without writes', async () => {
  const held = Promise.withResolvers<OrganizationDeletionRead>();
  let reads = 0;
  const read: OrganizationDeletionReader = async () => (++reads === 2 ? held.promise : ready());
  const page = await open(content(read), body);
  await flush(() => {
    fill(page.host.querySelector<HTMLInputElement>('#organization-delete-confirmation')!, '@private-name');
    send(page.host);
  });
  expect(reads).toBe(2);
  expect(page.calls).toHaveLength(0);

  await flush(leave);
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).not.toContain('Private organization');
  expect(page.host.textContent).not.toContain(human);
  expect(page.host.textContent).toContain('Earlier deletion was not sent');
  await flush(persistedShow);
  await flush(() => held.resolve(ready()));
  expect(page.calls).toHaveLength(0);

  await flush(() => page.host.querySelector<HTMLButtonElement>('#organization-delete-return-review')!.click());
  expect(reads).toBe(3);
  expect(page.calls).toHaveLength(0);
  expect(page.host.textContent).toContain('Earlier deletion was not sent');
  expect(page.host.textContent).toContain('Private organization');
  expect(page.host.querySelector<HTMLInputElement>('#organization-delete-confirmation')!.value).toBe('');
});

test('dispatched history survives BFCache and failed review; late acknowledgement stays generic', async () => {
  let current: OrganizationDeletionRead = ready();
  let reads = 0;
  const read: OrganizationDeletionReader = async () => {
    reads++;
    return current;
  };
  const page = await open(content(read), body);
  await flush(() => {
    fill(page.host.querySelector<HTMLInputElement>('#organization-delete-confirmation')!, '@private-name');
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve', '/account-operations/execute']);
  expect(readOrganizationDeleteUnknown(organization).kind).toBe('pending');

  await flush(leave);
  await flush(persistedShow);
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).toContain('The deletion result is unknown');
  expect(page.host.textContent).not.toContain('Private organization');
  expect(page.host.textContent).not.toContain(human);
  expect(page.calls).toHaveLength(2);

  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: organization })));
  expect(page.host.textContent).toContain('Auth confirmed the organization deletion request');
  expect(page.host.textContent).toContain('cleanup completion');
  expect(page.host.textContent).not.toContain('Private organization');
  expect(page.host.querySelector('form')).toBeNull();
  expect(readOrganizationDeleteUnknown(organization).kind).toBe('absent');

  current = { kind: 'denied' };
  await flush(() => page.host.querySelector<HTMLButtonElement>('#organization-delete-return-review')!.click());
  expect(reads).toBe(3);
  expect(page.host.textContent).toContain('Auth confirmed the organization deletion request');
  expect(page.host.textContent).toContain('Current deletion review was denied');
  expect(page.calls).toHaveLength(2);

  current = ready(replacementHuman, 'current-name');
  await flush(() => page.host.querySelector<HTMLButtonElement>('#organization-delete-return-review')!.click());
  expect(reads).toBe(4);
  expect(page.host.textContent).toContain(replacementHuman);
  expect(page.host.textContent).toContain('@current-name');
  expect(page.host.textContent).not.toContain('@private-name');
  expect(page.host.textContent).toContain('Auth confirmed the organization deletion request');
  expect(page.host.querySelector<HTMLInputElement>('#organization-delete-confirmation')!.value).toBe('');
  expect(page.calls).toHaveLength(2);
});

test('retained uncertainty stays read-only and guarded through denied, successful and replacement-human review', async () => {
  const descriptor = {
    version: 1 as const,
    operation: 'delete' as const,
    humanAccountId: human,
    organizationId: organization,
    operationKey: 'a'.repeat(32),
    returnTo: '/organizations/delete' as const,
  };
  storeOrganizationDeleteUnknown(descriptor);
  const saved = readOrganizationDeleteUnknown(organization);
  let advice: OrganizationDeletionRead = { kind: 'denied' };
  let reads = 0;
  const read: OrganizationDeletionReader = async () => {
    reads++;
    return advice;
  };
  const page = await open(content(read), body);
  expect(reads).toBe(0);
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).not.toContain('Private organization');

  const review = () => page.host.querySelector<HTMLButtonElement>('#organization-delete-return-review')!.click();
  await flush(review);
  expect(reads).toBe(1);
  expect(page.host.textContent).toContain('Current deletion review was denied');
  expect(page.host.textContent).toContain('The deletion result is unknown');
  expect(page.host.querySelector('form')).toBeNull();
  const unload = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload as unknown as Event);
  expect(unload.defaultPrevented).toBe(true);

  advice = ready();
  await flush(review);
  expect(reads).toBe(2);
  expect(page.host.textContent).toContain('The deletion result is unknown');
  expect(page.host.textContent).not.toContain('Private organization');
  expect(page.host.querySelector('form')).toBeNull();
  expect(readOrganizationDeleteUnknown(organization)).toEqual(saved);

  advice = ready(replacementHuman, 'replacement-private-name');
  await flush(review);
  expect(reads).toBe(3);
  expect(page.host.textContent).toContain('account, organization or request changed');
  expect(page.host.textContent).not.toContain(replacementHuman);
  expect(page.host.textContent).not.toContain('replacement-private-name');
  expect(readOrganizationDeleteUnknown(organization)).toEqual(saved);
  expect(page.calls).toHaveLength(0);
});
