import { expect, test } from 'bun:test';
import { creationFixture, dom, flush, fill, button, leave, open } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { emptyInventory, storyAccount } from '../src/stories/accounts-operations/story';
import type { AccountIdentitySource } from '../src/account-identity';
import type { SecurityLoadResult } from '../src/security';
import type { InventoryView } from '../src/security-inventory';
import type { InventorySource } from '../src/security-inventory-view';
import type { SecuritySource } from '../src/security-reconciliation';
import { m } from '../src/paraglide/messages.js';

creationFixture();

function securityPage(accountId = storyAccount): SecurityLoadResult {
  const value = structuredClone(initial);
  if (value.kind === 'ready') {
    value.accountId = accountId;
    if (value.page) value.page.viewer.account_id = accountId;
  }
  return value;
}

async function mount() {
  const reads: PromiseWithResolvers<SecurityLoadResult>[] = [];
  const readSignals: (AbortSignal | undefined)[] = [];
  const source = {
    load: (_withPasskeys: boolean, signal?: AbortSignal) => {
      readSignals.push(signal);
      const read = Promise.withResolvers<SecurityLoadResult>();
      reads.push(read);
      return read.promise;
    },
    read: async () => ({ kind: 'unavailable' }),
    act: async () => ({ kind: 'unknown' }),
  } satisfies SecuritySource;
  let identityReads = 0;
  const identitySource: AccountIdentitySource = async () => {
    identityReads++;
    return {
      kind: 'ready',
      accountId: identityReads === 1 ? storyAccount : 'replacement-account',
      email: identityReads === 1 ? 'former.person@example.test' : 'replacement.person@example.test',
    };
  };
  const inventoryReads: InventoryView[] = [];
  async function countedInventory<V extends InventoryView>(view: V) {
    inventoryReads.push(view);
    return emptyInventory(view);
  }
  const inventorySource = countedInventory as InventorySource;
  const ui = await open(
    <SecurityPage
      initial={securityPage()}
      identitySource={identitySource}
      inventorySource={inventorySource}
      securitySource={source}
    />,
    { account_id: storyAccount },
  );
  return {
    ...ui,
    reads,
    readSignals,
    get identityReads() {
      return identityReads;
    },
    inventoryReads,
  };
}

async function begin(host: HTMLElement) {
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'former password secret');
    fill(host.querySelector('#security-confirm-password')!, 'former password secret');
  });
  await flush(() => (host.querySelector('#security-new-password') as HTMLInputElement).form!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
}

function stageResponse(body: Record<string, string>) {
  return Response.json({
    effectRef: 'retired-effect-ref',
    key: body.key,
    subjectId: body.subjectId,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  });
}

test('cached return reads current advice once, keeps generic history, and requires an acknowledged fresh attempt', async () => {
  const ui = await mount();
  await begin(ui.host);
  expect(ui.calls).toHaveLength(1);
  const oldKey = ui.calls[0]!.body.key;

  await flush(leave);
  const show = new dom.Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(show, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(show));
  expect(ui.reads).toHaveLength(1);
  expect(ui.readSignals[0]?.aborted).toBe(false);
  expect(ui.host.textContent).toContain(m.auth_security_password_return_stage());

  await flush(leave);
  expect(ui.readSignals[0]?.aborted).toBe(true);
  await flush(() => ui.reads[0]!.resolve({ kind: 'failure', message: 'Late Security read' }));
  const restored = new dom.Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(restored, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(restored));
  expect(ui.reads).toHaveLength(2);
  await flush(() => ui.reads[1]!.resolve({ kind: 'failure', message: 'Current Security unavailable' }));
  expect(ui.host.textContent).toContain(m.auth_security_password_return_stage());
  expect(ui.host.querySelector('#security-new-password')).toBeNull();
  expect(ui.host.textContent).not.toContain('former.person@example.test');
  expect(ui.host.textContent).not.toContain('former password secret');
  expect(ui.host.textContent).not.toContain(storyAccount);

  const firstRead = ui.host.querySelector<HTMLButtonElement>('[data-password-return-review]')!;
  await flush(() => {
    firstRead.click();
    firstRead.click();
  });
  expect(ui.reads).toHaveLength(3);
  expect(ui.calls).toHaveLength(1);
  await flush(() => ui.reads[2]!.resolve({ kind: 'failure', message: 'Malformed current Security page' }));
  expect(ui.host.textContent).toContain(m.auth_security_password_return_stage());
  expect(ui.host.querySelector('#security-new-password')).toBeNull();
  expect(ui.host.querySelector('[data-password-return-status]')).toBe(document.activeElement);

  const retry = ui.host.querySelector<HTMLButtonElement>('[data-password-return-review]')!;
  await flush(() => {
    retry.click();
    retry.click();
  });
  expect(ui.reads).toHaveLength(4);
  expect(ui.calls).toHaveLength(1);
  await flush(() => ui.reads[3]!.resolve(securityPage('replacement-account')));
  expect(ui.host.textContent).toContain(m.auth_security_password_return_stage());
  expect(ui.host.textContent).toContain('replacement.person@example.test');
  expect(ui.host.textContent).not.toContain('former.person@example.test');
  const history = ui.host.querySelector('[aria-labelledby="security-password-return-heading"]');
  expect(history?.textContent).not.toContain('replacement-account');
  expect(history?.textContent).not.toContain('replacement.person@example.test');
  expect(ui.host.querySelector('#security-new-password')).toBeNull();
  expect(ui.host.querySelector('[data-password-return-status]')).toBe(document.activeElement);
  expect(ui.identityReads).toBe(2);
  expect(ui.inventoryReads).toHaveLength(4);

  await flush(() => ui.calls[0]!.resolve(stageResponse(ui.calls[0]!.body)));
  expect(ui.calls).toHaveLength(1);
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-password-return-acknowledge]')!.click());
  expect(ui.host.querySelector('#security-new-password')).not.toBeNull();
  expect(document.activeElement).toBe(ui.host.querySelector('#security-new-password'));
  expect(ui.calls).toHaveLength(1);

  await flush(() => {
    fill(ui.host.querySelector('#security-new-password')!, 'fresh password secret');
    fill(ui.host.querySelector('#security-confirm-password')!, 'fresh password secret');
  });
  await flush(() => (ui.host.querySelector('#security-new-password') as HTMLInputElement).form!.requestSubmit());
  const confirm = button(ui.host, m.auth_security_password_confirm())!;
  await flush(() => {
    confirm.click();
    confirm.click();
  });
  expect(ui.calls).toHaveLength(2);
  expect(ui.calls[1]!.body.key).not.toBe(oldKey);
  expect(ui.calls[1]!.body.credential.password).toBe('fresh password secret');
});
