import { afterAll, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { creationFixture, open, flush, button } from './creation-page-fixture';
import { parseSecurityPage, type SecurityPageEnvelope } from '../src/security-inventory';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { emptyInventory } from '../src/stories/accounts-operations/story';
import { loadSecurity, type SecurityLoadResult } from '../src/security';
import * as inventory from '../src/security-inventory';
import { m } from '../src/paraglide/messages.js';
import { securityEnvelope } from './security-page-fixture';

creationFixture();
const old = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
afterAll(() => {
  if (old) Object.defineProperty(globalThis, 'PublicKeyCredential', old);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});
const envelope = () => structuredClone(initial.kind === 'ready' ? initial.page! : null!);
function ready(page: SecurityPageEnvelope): SecurityLoadResult {
  return {
    kind: 'ready',
    accountId: page.viewer.account_id,
    page,
    passwordLimits: null,
    sessions: page.sessions.kind === 'ready' ? page.sessions.rows : [],
    passkeys:
      page.passkeys.kind === 'ready'
        ? { kind: 'ready', passkeys: page.passkeys.rows }
        : { kind: 'failure', message: m.auth_security_passkeys_failed() },
  };
}
const props = { identitySource: async () => ({ kind: 'unavailable' as const }), inventorySource: emptyInventory };

test('the envelope rejects malformed or contradictory authority and strips undeclared metadata', () => {
  const page = envelope();
  expect(parseSecurityPage({ ...page, secret: 'hidden' })).toEqual(page);
  expect(parseSecurityPage({ ...page, sessions: { kind: 'ready', limit: 64, truncated: false, rows: [] } })).toBeNull();
  if (page.sessions.kind === 'ready') page.sessions.rows[0]!.current = false;
  expect(parseSecurityPage(page)).toBeNull();
});

test('unsupported WebAuthn retains saved passkeys and native removal, with partial failure and step-up advice visible', async () => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: undefined });
  const page = envelope();
  page.sessions = { kind: 'unavailable' };
  page.actions.register_passkey = 'step-up-required';
  page.actions.change_password = 'step-up-required';
  const view = await open(createElement(SecurityPage, { ...props, initial: ready(page) }), {});
  expect(view.host.textContent).toContain(m.auth_security_passkeys_browser_unavailable());
  expect(view.host.textContent).toContain(m.auth_security_step_up_advice());
  expect(button(view.host, m.auth_security_passkey_remove())?.disabled).toBe(false);
  expect(view.host.querySelector('#security-passkey-name')).toBeNull();
  expect(view.host.textContent).toContain(m.auth_security_sessions_failed());
  expect(view.host.textContent).not.toContain(m.auth_security_sessions_empty());
});

test('a selected session reconciles native advice and old targets retire on refresh, account replacement and sign-out', async () => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
  const page = envelope();
  if (page.sessions.kind !== 'ready') throw new Error('fixture');
  page.sessions.rows.push({
    ...page.sessions.rows[0]!,
    id: 'other',
    current: false,
    client_display_name: 'Reading companion on the laptop',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/144.0',
  });
  const next = structuredClone(page);
  if (next.sessions.kind === 'ready') next.sessions.rows = next.sessions.rows.filter((row) => row.id !== 'other');
  const actions: string[] = [];
  let loaded: SecurityLoadResult = ready(next);
  const source = {
    load: async () => loaded,
    act: async (target: { id: string }) => {
      actions.push(target.id);
      return { kind: 'accepted' as const };
    },
    read: async () => ({
      kind: 'ready' as const,
      page: next,
      sessions: next.sessions.kind === 'ready' ? next.sessions.rows : [],
      passkeys: null,
      presence: 'absent' as const,
    }),
  };
  const view = await open(createElement(SecurityPage, { ...props, initial: ready(page), securitySource: source }), {});
  const row = [...view.host.querySelectorAll('li')].find((row) =>
    row.textContent?.includes('Reading companion on the laptop'),
  )!;
  const oldButton = row.querySelector<HTMLButtonElement>('button')!;
  expect(oldButton.getAttribute('aria-label')).toBe(
    m.auth_security_sign_out_session({ device: m.auth_security_device({ browser: 'Firefox', system: 'Linux' }) }),
  );
  await flush(() => oldButton.click());
  expect(actions).toEqual([]);
  expect(view.host.querySelector('[role="dialog"]')?.textContent).toContain('Reading companion on the laptop');
  await flush(() => button(view.host, m.auth_security_confirm_session())!.click());
  expect(actions).toEqual(['other']);
  await flush(() => oldButton.click());
  expect(actions).toEqual(['other']);
  expect(view.host.textContent).toContain(m.auth_security_session_absent());
  expect(view.host.querySelector('[aria-labelledby="security-sessions-heading"]')!.querySelectorAll('li')).toHaveLength(
    1,
  );
  loaded = ready({ ...next, viewer: { ...next.viewer, account_id: 'replacement' } });
  await flush(() => button(view.host, m.auth_inventory_reload())!.click());
  await flush(() => oldButton.click());
  expect(actions).toEqual(['other']);
  loaded = { kind: 'signed-out' };
  await flush(() => button(view.host, m.auth_inventory_reload())!.click());
  expect(view.host.querySelector('form')).toBeNull();
  expect(view.host.textContent).toContain(m.auth_security_sign_in_required());
});

test('the loader uses one native security page and native password limits, and never invents an empty dependency', async () => {
  const page = envelope();
  const limits = { minLength: 10, maxLength: 96 };
  const read = spyOn(inventory, 'loadSecurityPage').mockResolvedValue({ kind: 'ready', page });
  const transport = spyOn(inventory, 'issuerSecurityJsonRequest').mockImplementation(async (path) => {
    expect(path).toBe('/registration-page');
    const body = { requirements: { password: limits } };
    return { response: Response.json(body), body };
  });
  try {
    expect(await loadSecurity(false)).toEqual({ ...ready(page), passwordLimits: limits });
    expect(await loadSecurity(true)).toEqual({ ...ready(page), passwordLimits: limits });
    expect(read).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    read.mockResolvedValue({ kind: 'unavailable' });
    expect((await loadSecurity(true)).kind).toBe('failure');
    read.mockResolvedValue({ kind: 'signed-out' });
    expect((await loadSecurity(false)).kind).toBe('signed-out');
  } finally {
    read.mockRestore();
    transport.mockRestore();
  }
});

test('session controls keep the selected native advice and do not dispatch an unavailable target', async () => {
  const base = envelope();
  if (base.sessions.kind !== 'ready') throw new Error('fixture');
  const page = securityEnvelope(
    base.viewer.account_id,
    [
      ...base.sessions.rows,
      {
        ...base.sessions.rows[0]!,
        id: 'unavailable-session',
        current: false,
        client_display_name: 'Unavailable laptop',
        revoke: 'unavailable',
      },
      {
        ...base.sessions.rows[0]!,
        id: 'step-up-session',
        current: false,
        client_display_name: 'Laptop requiring confirmation',
        revoke: 'step-up-required',
      },
    ],
    [],
  );
  expect(parseSecurityPage(page)).toEqual(page);
  const act = spyOn({ act: async () => ({ kind: 'accepted' as const }) }, 'act');
  const view = await open(
    createElement(SecurityPage, {
      ...props,
      initial: ready(page),
      securitySource: { act, read: async () => ({ kind: 'unavailable' }) },
    }),
    {},
  );
  for (const [name, advice, disabled] of [
    ['Unavailable laptop', m.auth_inventory_unavailable(), true],
    ['Laptop requiring confirmation', m.auth_security_step_up_advice(), false],
  ] as const) {
    const row = [...view.host.querySelectorAll('li')].find((row) => row.textContent?.includes(name))!;
    const control = row.querySelector<HTMLButtonElement>('button')!;
    expect(control.disabled).toBe(disabled);
    expect(document.getElementById(control.getAttribute('aria-describedby')!)?.textContent).toBe(advice);
    if (disabled) await flush(() => control.click());
  }
  expect(act).not.toHaveBeenCalled();
});
