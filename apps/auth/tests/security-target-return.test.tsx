import { expect, test } from 'bun:test';
import { creationFixture, open, flush, button, leave, dom } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type { SecurityActionResult, SecurityReadback, SecuritySource } from '../src/security-reconciliation';
import type { SecurityLoadResult } from '../src/security';
import type { AccountIdentityResult } from '../src/account-identity';
import { retainSecurityTargetReturn } from '../src/security-target-return';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const ready = () => structuredClone(initial) as Extract<SecurityLoadResult, { kind: 'ready' }>;
const unavailableIdentity = async () => ({ kind: 'unavailable' as const });
const restore = () => window.dispatchEvent(new dom.Event('pageshow') as unknown as Event);

test('pagehide keeps generic uncertainty through sign-out and ignores the retired reply', async () => {
  const action = Promise.withResolvers<SecurityActionResult>();
  let loads = 0,
    reads = 0,
    writes = 0;
  const source: SecuritySource = {
    load: async () => {
      loads++;
      return { kind: 'signed-out' };
    },
    act: () => {
      writes++;
      return action.promise;
    },
    read: async () => {
      reads++;
      return { kind: 'unavailable' };
    },
  };
  const ui = await open(
    <SecurityPage initial={initial} identitySource={unavailableIdentity} inventorySource={populatedInventory} securitySource={source} />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(leave);
  expect(ui.host.textContent).not.toContain('Security key');
  await flush(restore);
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).not.toContain('Security key');
  expect(ui.host.querySelector('a[href="/login"]')).not.toBeNull();
  expect(button(ui.host, m.auth_security_check_current())).toBeUndefined();
  await flush(() => action.resolve({ kind: 'accepted' }));
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  await flush(() => button(ui.host, m.auth_security_target_return_dismiss())!.click());
  expect(ui.host.textContent).not.toContain(m.auth_security_target_return_unknown());
  expect({ loads, reads, writes }).toEqual({ loads: 1, reads: 0, writes: 1 });
});

test('a denied read retires target details but keeps its earlier unknown outcome', async () => {
  let writes = 0;
  const source: SecuritySource = {
    act: async () => {
      writes++;
      return { kind: 'unknown' };
    },
    read: async (): Promise<SecurityReadback> => ({ kind: 'denied' }),
  };
  const ui = await open(
    <SecurityPage initial={initial} identitySource={unavailableIdentity} inventorySource={populatedInventory} securitySource={source} />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(() => button(ui.host, m.auth_security_check_current())!.click());
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).not.toContain('Security key');
  expect(button(ui.host, m.auth_security_retry_action())).toBeUndefined();
  expect(writes).toBe(1);
});

test('identity retirement hides the selected passkey and keeps only generic history', async () => {
  const identity = Promise.withResolvers<AccountIdentityResult>();
  const action = Promise.withResolvers<SecurityActionResult>();
  const ui = await open(
    <SecurityPage
      initial={initial}
      identitySource={() => identity.promise}
      inventorySource={populatedInventory}
      securitySource={{ act: () => action.promise, read: async () => ({ kind: 'unavailable' }) }}
    />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(() => identity.resolve({ kind: 'denied' }));
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).not.toContain('Security key');
  await flush(() => action.resolve({ kind: 'accepted' }));
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
});

test('a replacement viewer receives generic history and only its own inventory', async () => {
  const other = ready();
  other.accountId = 'replacement-account';
  other.sessions = other.sessions.map((row) => ({ ...row, id: 'replacement-session' }));
  if (other.passkeys.kind === 'ready')
    other.passkeys.passkeys = other.passkeys.passkeys.map((row) => ({ ...row, id: 'replacement-passkey', name: 'New viewer key' }));
  if (other.page) {
    other.page.viewer.account_id = other.accountId;
    other.page.viewer.session_id = 'replacement-session';
    if (other.page.sessions.kind === 'ready')
      other.page.sessions.rows = other.sessions.map((row) => ({ ...row, revoke: 'allowed' }));
    if (other.page.passkeys.kind === 'ready')
      other.page.passkeys.rows =
        other.passkeys.kind === 'ready' ? other.passkeys.passkeys.map((row) => ({ ...row, remove: 'allowed' })) : [];
  }
  const action = Promise.withResolvers<SecurityActionResult>();
  const ui = await open(
    <SecurityPage
      initial={initial}
      identitySource={unavailableIdentity}
      inventorySource={populatedInventory}
      securitySource={{
        load: async () => other,
        act: () => action.promise,
        read: async () => ({ kind: 'unavailable' }),
      }}
    />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(leave);
  await flush(restore);
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).toContain('New viewer key');
  expect(ui.host.textContent).not.toContain('Security key');
  expect(button(ui.host, m.auth_security_check_current())).toBeUndefined();
  expect(button(ui.host, m.auth_security_retry_action())).toBeUndefined();
});

test('a current read remains separate from an acknowledged session command', async () => {
  const data = ready();
  const current = data.sessions[0]!;
  const remote = {
    ...current,
    id: 'remote-session',
    current: false,
    client_id: 'reader',
    client_display_name: 'Desk browser',
  };
  data.sessions.push(remote);
  data.page?.sessions.kind === 'ready' && data.page.sessions.rows.push({ ...remote, revoke: 'allowed' });
  const source: SecuritySource = {
    act: async () => ({ kind: 'accepted' }),
    read: async (): Promise<SecurityReadback> => ({
      kind: 'ready',
      presence: 'present',
      sessions: data.sessions,
      passkeys: data.passkeys.kind === 'ready' ? data.passkeys.passkeys : null,
    }),
  };
  const ui = await open(
    <SecurityPage initial={data} identitySource={unavailableIdentity} inventorySource={populatedInventory} securitySource={source} />,
    {},
  );
  const row = [...ui.host.querySelectorAll('li')].find((item) => item.textContent?.includes('Desk browser'))!;
  await flush(() => row.querySelector<HTMLButtonElement>('button')!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_session())!.click());
  expect(ui.host.textContent).toContain(m.auth_security_target_return_acknowledged());
  expect(ui.host.textContent).toContain(m.auth_security_session_present());
});

test('a first refusal is known, but a later refusal cannot settle an earlier unknown', () => {
  expect(retainSecurityTargetReturn(null, 'refused')).toBe('refused');
  expect(retainSecurityTargetReturn('unknown', 'refused')).toBe('unknown');
  expect(retainSecurityTargetReturn('unknown', 'acknowledged')).toBe('unknown');
});

test('a first refusal is shown without claiming an unknown result', async () => {
  const ui = await open(
    <SecurityPage
      initial={initial}
      identitySource={unavailableIdentity}
      inventorySource={populatedInventory}
      securitySource={{ act: async () => ({ kind: 'denied' }), read: async () => ({ kind: 'unavailable' }) }}
    />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  expect(ui.host.textContent).toContain(m.auth_security_target_return_refused());
  expect(ui.host.textContent).not.toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).not.toContain('Security key');
});

test('a later refused retry leaves the mounted route honest about the earlier unknown send', async () => {
  const data = ready();
  let writes = 0;
  const source: SecuritySource = {
    act: async () => (++writes === 1 ? { kind: 'unknown' } : { kind: 'denied' }),
    read: async (): Promise<SecurityReadback> => ({
      kind: 'ready',
      presence: 'present',
      sessions: data.sessions,
      passkeys: data.passkeys.kind === 'ready' ? data.passkeys.passkeys : null,
    }),
  };
  const ui = await open(
    <SecurityPage initial={data} identitySource={unavailableIdentity} inventorySource={populatedInventory} securitySource={source} />,
    {},
  );
  await flush(() => button(ui.host, m.auth_security_passkey_remove())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  await flush(() => button(ui.host, m.auth_security_check_current())!.click());
  await flush(() => button(ui.host, m.auth_security_retry_action())!.click());
  await flush(() => button(ui.host, m.auth_security_confirm_passkey())!.click());
  expect(ui.host.textContent).toContain(m.auth_security_target_return_unknown());
  expect(ui.host.textContent).not.toContain(m.auth_security_target_return_refused());
  expect(ui.host.textContent).not.toContain('Security key');
  expect(writes).toBe(2);
});
