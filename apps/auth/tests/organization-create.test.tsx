import { expect, spyOn, test } from 'bun:test';
import { creationFixture, approval, button, fill, flush, leave, open, send, session } from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import {
  readPendingAccountOperationStepUp,
  storePendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
import { readPendingOrganizationHandle, storePendingOrganizationHandle } from '../src/account-operations';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };
test('initial read retries the saved draft; uncertain creation requires the same handle and command', async () => {
  storePendingOrganizationHandle('Team-Alpha');
  const page = await open(<NewOrganizationPage initial={{ kind: 'failure', message: 'Unavailable' }} />, body);
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('Team-Alpha');
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const saved = readPendingAccountOperationStepUp()!;
  storePendingOrganizationHandle('another-draft');
  await page.render(<NewOrganizationPage key="restored" initial={initial} />);
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('team-alpha');
  expect(page.host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true);
  expect(page.calls).toHaveLength(2);
  await flush(() => send(page.host));
  expect(page.calls[2]!.body.operationKey).toBe(saved.operationKey);
  expect(page.calls[2]!.body.operation).toEqual(saved.operation);
  await flush(() => page.calls[2]!.resolve(approval()));
  await flush(() => page.calls[3]!.resolve(Response.json({ accountId: '20000000-0000-7000-8000-000000000002' })));
  expect(page.host.textContent).toContain('@team-alpha');
  expect(page.host.querySelector('a[href^="/organizations/members?"]')?.getAttribute('href')).toBe(
    '/organizations/members?organizationId=20000000-0000-7000-8000-000000000002',
  );
  expect(readPendingOrganizationHandle()).toBe('');
  expect(readPendingAccountOperationStepUp()).toBeNull();
});
for (const result of ['success', 'step-up', 'approval'] as const)
  test(`departed ${result} cannot clear or redirect a replacement creation`, async () => {
    const page = await open(<NewOrganizationPage initial={initial} />, { ...body });
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    try {
      await flush(() => fill(page.host.querySelector('input')!, 'old-team'));
      await flush(() => send(page.host));
      if (result !== 'approval') await flush(() => page.calls[0]!.resolve(approval()));
      await flush(leave);
      storePendingOrganizationHandle('new-team');
      const operation = { kind: 'organization' as const, handle: 'new-team' };
      storePendingAccountOperationStepUp({
        ...readPendingAccountOperationStepUp()!,
        accountId: 'replacement',
        operation,
      });
      await page.render(<NewOrganizationPage initial={{ ...initial, accountId: 'replacement' }} />);
      await flush(() =>
        (result === 'approval' ? page.calls[0]! : page.calls[1]!).resolve(
          result === 'approval'
            ? approval()
            : result === 'success'
              ? Response.json({ accountId: 'old-created' })
              : Response.json({ error: 'step_up_required' }, { status: 401 }),
        ),
      );
      expect(readPendingOrganizationHandle()).toBe('new-team');
      expect(readPendingAccountOperationStepUp()!.accountId).toBe('replacement');
      expect(assign).not.toHaveBeenCalled();
      expect(page.calls).toHaveLength(result === 'approval' ? 1 : 2);
    } finally {
      assign.mockRestore();
    }
  });
