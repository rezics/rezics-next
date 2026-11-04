import { expect, test } from 'bun:test';
import { creationFixture, button, dom, flush, leave, open, session } from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import { storePendingAccountOperationStepUp } from '../src/account-operation-step-up';
import { storePendingOrganizationHandle } from '../src/account-operations';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };

test('return and read Retry make bounded session reads but no approval or execution writes', async () => {
  expect(storePendingAccountOperationStepUp({
    kind: 'organization',
    accountId: initial.accountId,
    operationKey: '0123456789abcdef0123456789abcdef',
    operation: { kind: 'organization', handle: 'private-team' },
    submitted: true,
  })).toBe(true);
  storePendingOrganizationHandle('private-team');
  const page = await open(
    <NewOrganizationPage initial={{ kind: 'failure', message: 'Unavailable' }} />,
    body,
  );
  expect(page.host.textContent).toContain('creation result is still unknown');
  expect(page.host.textContent).not.toContain('private-team');
  expect(button(page.host, 'Check current advice')).not.toBeNull();
  expect(button(page.host, 'Retry this creation')).toBeNull();

  const originalFetch = globalThis.fetch;
  let sessionReads = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/session') sessionReads++;
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await flush(() => button(page.host, 'Check current advice')!.click());
    expect(sessionReads).toBe(1);
    expect(page.calls).toHaveLength(0);
    expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('private-team');

    await flush(() => {
      leave();
      expect(page.host.querySelector('input')).toBeNull();
      const pageshow = new dom.Event('pageshow');
      Object.defineProperty(pageshow, 'persisted', { value: true });
      window.dispatchEvent(pageshow as unknown as Event);
    });
    expect(sessionReads).toBe(2);
    expect(page.calls).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
