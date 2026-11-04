import { expect, spyOn, test } from 'bun:test';
import { creationFixture, approval, button, fill, flush, leave, open, send, session } from './creation-page-fixture';
import { OrganizationDeleteContent } from '../src/routes/organizations.delete';
import { readOrganizationDeleteUnknown } from '../src/organization-delete-step-up';
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
  account: { id, kind: 'organization', handle: id === first ? 'first' : 'second', displayName: null },
});
const content = (id: string, read: OrganizationDeletionReader) => (
  <OrganizationDeleteContent organizationId={id} privacyContact="mailto:privacy@example.test" read={read} />
);
const confirm = (host: HTMLElement, phrase: string) =>
  flush(() => {
    fill(host.querySelector('input')!, phrase);
    send(host);
  });

test('unavailable review recovers the selected organization and freshly confirms accepted deletion', async () => {
  let unavailable = true;
  const selections: object[] = [];
  const read: OrganizationDeletionReader = async (selection) => {
    selections.push(selection);
    return unavailable ? { kind: 'unavailable' } : ready(selection.organizationId);
  };
  const page = await open(content(first, read), body);
  expect(page.host.querySelector('form')).toBeNull();
  unavailable = false;
  await flush(() => button(page.host, 'Retry')!.click());
  expect(selections).toEqual(Array(2).fill({ organizationId: first }));
  await confirm(page.host, 'wrong');
  expect(page.calls).toHaveLength(0);
  await confirm(page.host, '@FIRST');
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: first })));
  expect(page.host.textContent).toContain('Organization deletion committed');
  expect(page.host.textContent).toContain('complete erasure is not confirmed');
  expect(page.host.querySelector('form')).toBeNull();
});

test('uncertainty retains the original identity through unavailable, missing, denied and readable readback', async () => {
  let result = ready(first);
  const read: OrganizationDeletionReader = async () => result;
  const page = await open(content(first, read), body);
  await confirm(page.host, '@first');
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const saved = readOrganizationDeleteUnknown(first);
  expect(saved.kind).toBe('pending');
  for (result of [{ kind: 'unavailable' }, { kind: 'missing' }, { kind: 'denied' }, ready(first)]) {
    await flush(() => button(page.host, 'Check current organization')!.click());
    expect(readOrganizationDeleteUnknown(first)).toEqual(saved);
    expect(page.host.querySelector('form')).toBeNull();
    expect(page.calls).toHaveLength(2);
    expect(page.host.textContent).not.toContain('Organization deletion committed');
  }
  await page.render(
    <OrganizationDeleteContent
      key="restored"
      organizationId={first}
      privacyContact="mailto:privacy@example.test"
      read={read}
    />,
  );
  expect(readOrganizationDeleteUnknown(first)).toEqual(saved);
  expect(page.host.querySelector('form')).toBeNull();
});

for (const phase of ['read', 'approval', 'execution', 'step-up'] as const)
  test(`changing organization retires old ${phase} without unlocking the newer submit`, async () => {
    const oldRead = Promise.withResolvers<OrganizationDeletionRead>();
    const newRead = Promise.withResolvers<OrganizationDeletionRead>();
    let reads = 0;
    const read: OrganizationDeletionReader = async ({ organizationId }) =>
      ++reads === 2 ? oldRead.promise : reads === 4 ? newRead.promise : ready(organizationId);
    const page = await open(content(first, read), body);
    await confirm(page.host, '@first');
    if (phase !== 'read') await flush(() => oldRead.resolve(ready(first)));
    if (phase === 'execution' || phase === 'step-up') await flush(() => page.calls[0]!.resolve(approval()));
    if (phase === 'execution') await flush(leave);
    await page.render(content(second, read));
    expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
    await confirm(page.host, '@second');
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    try {
      await flush(() =>
        phase === 'read'
          ? oldRead.resolve(ready(first))
          : page.calls
              .at(-1)!
              .resolve(
                phase === 'approval'
                  ? approval()
                  : phase === 'execution'
                    ? Response.json({ accountId: first })
                    : Response.json({ error: 'step_up_required' }, { status: 401 }),
              ),
      );
      expect(page.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      expect(page.host.textContent).not.toContain('Organization deletion committed');
      expect(assign).not.toHaveBeenCalled();
      const previousCalls = page.calls.length;
      await flush(() => newRead.resolve(ready(second)));
      expect(page.calls).toHaveLength(previousCalls + 1);
      expect(page.calls.at(-1)!.body.operation).toEqual({ kind: 'delete', accountId: second });
    } finally {
      assign.mockRestore();
    }
  });

test('late initial reads and browser departure cannot restore private review; recovery pins the initiating human', async () => {
  const delayed = Promise.withResolvers<OrganizationDeletionRead>();
  const recovery = Promise.withResolvers<OrganizationDeletionRead>();
  let reads = 0;
  let replaced = false;
  const read: OrganizationDeletionReader = async ({ organizationId }) =>
    replaced
      ? ({ ...ready(second), humanAccountId: first } as OrganizationDeletionRead)
      : ++reads === 3
        ? recovery.promise
        : organizationId === first
          ? delayed.promise
          : ready(second);
  const page = await open(content(first, read), body);
  await page.render(content(second, read));
  await flush(() => delayed.resolve(ready(first)));
  expect(page.host.textContent).toContain(second);
  expect(page.host.textContent).not.toContain(first);
  await flush(leave);
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).not.toContain(second);
  await flush(() => button(page.host, 'Retry')!.click());
  await flush(leave);
  await flush(() => recovery.resolve(ready(second)));
  expect(page.host.querySelector('form')).toBeNull();
  replaced = true;
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).toContain('account, organization or request changed');
});

test('ordinary direct navigation authenticates without private facts, then renews explicit review with the same operation', async () => {
  const { readOrganizationDeleteStepUp, selectOrganizationDeleteStepUp } =
    await import('../src/organization-delete-step-up');
  const { operationKeyFor } = await import('../src/account-operations');
  const read: OrganizationDeletionReader = async () => ({
    kind: 'authentication-required',
    humanAccountId: human,
    action: 'authenticate',
  });
  const page = await open(content(first, read), body);
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.host.textContent).toContain('selected ID is unverified');
  expect(page.host.textContent).not.toContain('@first');
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await flush(() => button(page.host, 'Authenticate to review')!.click());
    expect(assign).toHaveBeenCalledTimes(1);
    const saved = readOrganizationDeleteStepUp();
    expect(saved).toMatchObject({
      kind: 'pending',
      value: {
        humanAccountId: human,
        organizationId: first,
        operationKey: operationKeyFor({ kind: 'delete', accountId: first }, human),
      },
    });
    expect(selectOrganizationDeleteStepUp(new URL(assign.mock.calls[0]![0], 'https://auth.test').search).kind).toBe(
      'organization-delete',
    );
    await page.render(content(first, async () => ready(first)));
    expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(page.calls).toHaveLength(0);
    await confirm(page.host, '@first');
    expect(page.calls[0]!.body.operationKey).toBe(saved.kind === 'pending' ? saved.value.operationKey : 'missing');
  } finally {
    assign.mockRestore();
  }
});

test('a replaced continuation during released review retires controls and preserves its replacement without sending', async () => {
  const { storeOrganizationDeleteStepUp, readOrganizationDeleteStepUp } =
    await import('../src/organization-delete-step-up');
  const delayed = Promise.withResolvers<OrganizationDeletionRead>();
  let reads = 0;
  const page = await open(
    content(first, async () => (++reads === 2 ? delayed.promise : ready(first))),
    body,
  );
  await confirm(page.host, '@first');
  const replacement = { humanAccountId: human, organizationId: second, operationKey: 'b'.repeat(32) };
  expect(storeOrganizationDeleteStepUp(replacement)).toBe(true);
  await flush(() => delayed.resolve(ready(first)));
  expect(page.calls).toHaveLength(0);
  expect(page.host.querySelector('form')).toBeNull();
  expect(readOrganizationDeleteStepUp()).toMatchObject({ kind: 'pending', value: replacement });
});

test('current native refusal has no authentication loop or destructive control', async () => {
  const page = await open(
    content(first, async () => ({ kind: 'denied' })),
    body,
  );
  expect(page.host.querySelector('form')).toBeNull();
  expect(button(page.host, 'Authenticate to review')).toBeUndefined();
  expect(page.host.textContent).toContain('cannot currently manage');
  expect(page.calls).toHaveLength(0);
});
