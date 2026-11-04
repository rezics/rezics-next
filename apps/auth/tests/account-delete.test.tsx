import type { AccountDeletionPage } from '../src/account-deletion-page';
import { expect, spyOn, test } from 'bun:test';
import * as fixture from './creation-page-fixture';
import { DeleteAccountContent } from '../src/routes/account.delete';
import {
  readPendingAccountOperationStepUp,
  storePendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
import { emptyInventory } from '../src/stories/accounts-operations/story';
const { approval, button, dom, fill, flush, leave, open, send } = fixture;
fixture.creationFixture();
const initial: Extract<AccountDeletionPage, { kind: 'review' }> = {
  kind: 'review',
  accountId: 'story-account',
  email: null,
  action: 'available',
  policy: 'personal-deletion',
};
const body = initial;
const props = {
  privacyContact: 'mailto:privacy@example.test',
  inventorySource: emptyInventory,
};
const confirm = (host: HTMLElement) => fill(host.querySelector('input')!, 'delete my account');
const submit = (host: HTMLElement) =>
  flush(() => {
    confirm(host);
    send(host);
  });
const restore = () =>
  window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event);
test('read recovery is single-flight, preserves the human and needs a new confirmation without deletion', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={{ kind: 'unavailable' }} />, body);
  const read = Promise.withResolvers<Response>();
  let reads = 0;
  globalThis.fetch = (() => {
    reads++;
    return read.promise;
  }) as typeof fetch;
  await flush(() => {
    button(page.host, 'Retry')!.click();
    button(page.host, 'Retry')?.click();
  });
  expect(reads).toBe(1);
  await flush(() => read.resolve(Response.json(body)));
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
  expect(page.calls).toHaveLength(0);
  await flush(() => confirm(page.host));
  await flush(leave);
  expect(page.host.querySelector('input')).toBeNull();
  globalThis.fetch = (async () => Response.json({ ...body, accountId: 'another-human' })) as typeof fetch;
  await flush(restore);
  expect(page.host.querySelector('input')).toBeNull();
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
  expect(page.calls).toHaveLength(0);
});
test('uncertain deletion survives cached return with its exact command; accepted cleanup stays pending', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={initial} />, body);
  await submit(page.host);
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  await flush(() => page.calls[2]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(page.calls[2]!.body).toEqual(page.calls[1]!.body);
  const saved = readPendingAccountOperationStepUp()!;
  expect(saved).not.toBeNull();
  await flush(leave);
  await flush(restore);
  expect(page.calls).toHaveLength(3);
  expect(page.host.querySelector<HTMLInputElement>('input')?.value, page.host.textContent ?? '').toBe('');
  await submit(page.host);
  expect(page.calls[3]!.body).toEqual({ operationKey: saved.operationKey, operation: saved.operation });
  await flush(() => page.calls[3]!.resolve(approval()));
  await flush(() => page.calls[4]!.resolve(Response.json({ accountId: initial.accountId })));
  expect(page.host.textContent).toContain('Cleanup of native, shared and external copies is still pending');
  expect(readPendingAccountOperationStepUp()).toBeNull();
  await flush(() => {
    leave();
    restore();
  });
  expect(page.host.querySelector('input')).toBeNull();
  expect(page.host.querySelector('a[href="/security"]')).not.toBeNull();
  expect(page.calls).toHaveLength(5);
});
for (const phase of ['read', 'approval', 'success', 'step-up'] as const)
  test(`departed ${phase} cannot affect a later review or launch reauthentication`, async () => {
    const page = await open(<DeleteAccountContent {...props} initial={initial} />, body);
    const read = Promise.withResolvers<Response>();
    if (phase === 'read') {
      await flush(leave);
      globalThis.fetch = (() => read.promise) as typeof fetch;
      await flush(restore);
    } else {
      await submit(page.host);
      if (phase !== 'approval') await flush(() => page.calls[0]!.resolve(approval()));
    }
    await flush(leave);
    const saved = {
      kind: 'delete' as const,
      accountId: 'replacement',
      operationKey: 'f'.repeat(32),
      operation: { kind: 'delete' as const, accountId: 'replacement' },
    };
    storePendingAccountOperationStepUp(saved);
    await page.render(
      <DeleteAccountContent key="later" {...props} initial={{ ...initial, accountId: 'replacement' }} />,
    );
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    try {
      await flush(() =>
        phase === 'read'
          ? read.resolve(Response.json(body))
          : (phase === 'approval' ? page.calls[0]! : page.calls[1]!).resolve(
              phase === 'approval'
                ? approval()
                : phase === 'success'
                  ? Response.json({ accountId: initial.accountId })
                  : Response.json({ error: 'step_up_required' }, { status: 401 }),
            ),
      );
      expect(readPendingAccountOperationStepUp()).toMatchObject(saved);
      expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
      expect(assign).not.toHaveBeenCalled();
      expect(page.calls).toHaveLength(phase === 'read' ? 0 : phase === 'approval' ? 1 : 2);
    } finally {
      assign.mockRestore();
    }
  });
