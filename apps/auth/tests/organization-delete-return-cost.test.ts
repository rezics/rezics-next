import { expect, test } from 'bun:test';
import { creationFixture, approval, fill, flush, leave, open, send, session, dom } from './creation-page-fixture';
import { OrganizationDeleteContent } from '../src/routes/organizations.delete';
import type { OrganizationDeletionReader } from '../src/organization-deletion';

creationFixture();
const human = '10000000-0000-0000-0000-000000000000';
const organization = '20000000-0000-0000-0000-000000000000';
const body = { account_id: human, client_id: session('delete').clientId, scope: session('delete').scopes };

test('return review, preflight and bounded write retries have explicit whole-call counts', async () => {
  let reads = 0;
  const read: OrganizationDeletionReader = async () => {
    reads++;
    return {
      kind: 'ready',
      humanAccountId: human,
      action: 'confirm',
      account: {
        id: organization,
        kind: 'organization',
        handle: 'reading-group',
        displayName: 'Reading group',
      },
    };
  };
  const page = await open(
    <OrganizationDeleteContent
      organizationId={organization}
      privacyContact="mailto:privacy@example.test"
      read={read}
    />,
    body,
  );
  expect(reads).toBe(1);

  await flush(leave);
  await flush(() =>
    window.dispatchEvent(new dom.PageTransitionEvent('pageshow', { persisted: true }) as unknown as Event),
  );
  await flush(() => page.host.querySelector<HTMLButtonElement>('#organization-delete-return-review')!.click());
  expect(reads).toBe(2);
  expect(page.calls).toHaveLength(0);

  await flush(() => {
    fill(page.host.querySelector<HTMLInputElement>('#organization-delete-confirmation')!, '@reading-group');
    send(page.host);
  });
  expect(reads).toBe(3);
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);
  await flush(() => page.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(page.calls.map((call) => call.path)).toEqual([
    '/account-operations/approve',
    '/account-operations/approve',
  ]);
  await flush(() => page.calls[1]!.resolve(approval()));
  expect(page.calls.map((call) => call.path)).toEqual([
    '/account-operations/approve',
    '/account-operations/approve',
    '/account-operations/execute',
  ]);
  await flush(() => page.calls[2]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(page.calls.map((call) => call.path)).toEqual([
    '/account-operations/approve',
    '/account-operations/approve',
    '/account-operations/execute',
    '/account-operations/execute',
  ]);
  await flush(() => page.calls[3]!.resolve(Response.json({ accountId: organization })));
  expect(reads).toBe(3);
  expect(page.host.textContent).toContain('Auth confirmed the organization deletion request');
});
