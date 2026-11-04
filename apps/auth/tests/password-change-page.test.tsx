import { expect, test } from 'bun:test';
import { creationFixture, flush, fill, button, leave, open } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { emptyInventory, storyAccount } from '../src/stories/accounts-operations/story';
import type { AccountIdentityResult, AccountIdentitySource } from '../src/account-identity';
import type { SecurityLoadResult } from '../src/security';
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

function source() {
  return {
    load: async () => ({ kind: 'failure' as const, message: 'Unavailable' }),
    read: async () => ({ kind: 'unavailable' as const }),
    act: async () => ({ kind: 'unknown' as const }),
  } satisfies SecuritySource;
}

async function mount(identitySource?: AccountIdentitySource) {
  const identity =
    identitySource ??
    (async (): Promise<AccountIdentityResult> => ({ kind: 'ready', accountId: storyAccount, email: 'old.person@example.test' }));
  return open(
    <SecurityPage
      initial={securityPage()}
      identitySource={identity}
      inventorySource={emptyInventory}
      securitySource={source()}
    />,
    { account_id: storyAccount },
  );
}

async function begin(host: HTMLElement) {
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'retired password secret');
    fill(host.querySelector('#security-confirm-password')!, 'retired password secret');
  });
  await flush(() => (host.querySelector('#security-new-password') as HTMLInputElement).form!.requestSubmit());
  await flush(() => button(host, m.auth_security_password_confirm())!.click());
}

function staged(calls: { body: any }[]) {
  return Response.json({
    effectRef: 'private-effect-ref',
    key: calls[0]!.body.key,
    subjectId: calls[0]!.body.subjectId,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  });
}

async function advanceTo(phase: 'stage' | 'approve' | 'apply', calls: { resolve: (response: Response) => void; body: any }[]) {
  if (phase === 'stage') return;
  await flush(() => calls[0]!.resolve(staged(calls)));
  if (phase === 'approve') return;
  await flush(() =>
    calls[1]!.resolve(
      Response.json({ reference: 'private-approval-ref', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
  );
}

function lateResponse(phase: 'stage' | 'approve' | 'apply', calls: { body: any }[]) {
  if (phase === 'stage') return staged(calls);
  if (phase === 'approve')
    return Response.json({ reference: 'private-approval-ref', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return Response.json({ receiptId: 'private-receipt', replayed: false });
}

const cases = [
  ['stage', () => m.auth_security_password_return_stage(), 1],
  ['approve', () => m.auth_security_password_return_approval(), 2],
  ['apply', () => m.auth_security_password_return_apply(), 3],
] as const;

test.each(cases)('pagehide retains generic %s history and ignores a released native callback', async (phase, message, count) => {
  const { host, calls } = await mount();
  await begin(host);
  await advanceTo(phase, calls);
  await flush(leave);

  const summary = host.querySelector('[data-password-return-status]');
  expect(summary?.textContent).toContain(message());
  expect(host.textContent).not.toContain('retired password secret');
  expect(host.textContent).not.toContain('old.person@example.test');
  expect(host.textContent).not.toContain(storyAccount);
  expect(host.querySelector('#security-new-password')).toBeNull();
  expect(button(host, m.auth_signup_retry_original())).toBeUndefined();
  const retiredValues = calls
    .slice(0, count)
    .flatMap(({ body }) => [body.key, body.subjectId, body.credential?.password, body.effectRef, body.digest, body.reference])
    .filter(Boolean);
  for (const value of retiredValues) expect(host.textContent).not.toContain(value);
  expect(document.activeElement).toBe(summary);

  await flush(() => calls[count - 1]!.resolve(lateResponse(phase, calls)));
  expect(calls).toHaveLength(count);
  expect(host.querySelector('[data-password-return-status]')?.textContent).toContain(message());
  expect(document.activeElement).toBe(summary);
});

test('signed-out identity retirement keeps only generic password phase history', async () => {
  const identity = Promise.withResolvers<AccountIdentityResult>();
  const identitySource: AccountIdentitySource = () => identity.promise;
  const { host, calls } = await mount(identitySource);
  await begin(host);
  await flush(() => identity.resolve({ kind: 'signed-out' }));
  expect(host.textContent).toContain(m.auth_security_password_return_stage());
  expect(host.textContent).not.toContain('retired password secret');
  expect(host.textContent).not.toContain(storyAccount);
  expect(host.querySelector('#security-new-password')).toBeNull();
  await flush(() => calls[0]!.resolve(staged(calls)));
  expect(calls).toHaveLength(1);
  expect(host.textContent).toContain(m.auth_security_password_return_stage());
});
