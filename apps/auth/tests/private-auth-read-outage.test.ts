import { securityEnvelope, currentSecuritySession } from './security-page-fixture';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import * as fixture from './creation-page-fixture';
import { loadAccountSession } from '../src/account-operations';
import { loadManagementSession } from '../src/management-operations';
import { createConsentReview, readConsent, type ConsentReview } from '../src/consent';
import * as inventory from '../src/security-inventory';
import * as passkeyBrowser from '../src/passkeys';
import { SecurityPage } from '../src/routes/security';
import { m } from '../src/paraglide/messages.js';

fixture.creationFixture();
const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((
  callback: TimerHandler,
  delay?: number,
  ...args: unknown[]
) => originalTimeout(callback, delay === 5000 ? 5 : delay, ...args)) as typeof setTimeout);
const session = {
  account_id: 'current-human',
  client_id: 'login',
  scope: [],
  authn_epoch: 1,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
};
const consent = {
  client_id: 'selected-app',
  display_name: 'Reader',
  scopes: ['openid'],
  requested: [],
  granted: [],
  pending_reduction: false,
  acting_account: { account_id: 'account-1', email: null },
  decisions: { allow: true, decline: true, switch_account: true },
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => clock.mockRestore());
const readers = [
  ['account', loadAccountSession, 'failure', '/session'],
  ['management', loadManagementSession, 'unavailable', '/session'],
] as const;
for (const [name, read, kind, target] of readers) {
  for (const phase of ['headers', 'body'] as const)
    test(`${name} stalled ${phase} becomes unavailable, then a fresh read can recover`, async () => {
      const late = Promise.withResolvers<Response>();
      let signal: AbortSignal | undefined;
      globalThis.fetch = ((path, init) => {
        if (String(path) !== target) return Promise.resolve(Response.json(session));
        signal = init?.signal ?? undefined;
        return phase === 'headers' ? late.promise : Promise.resolve(new Response(new ReadableStream()));
      }) as typeof fetch;
      expect((await read()).kind).toBe(kind);
      expect(signal?.aborted).toBe(true);
      late.resolve(Response.json(session));
      globalThis.fetch = (async (path) =>
        Response.json(String(path) === '/sessions' ? { sessions: [] } : session)) as typeof fetch;
      expect((await read()).kind).toBe('ready');
    });
  test(`${name} preserves cancellation and real signed-out responses`, async () => {
    const controller = new AbortController();
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    const pending = read(controller.signal);
    await Promise.resolve();
    controller.abort();
    expect((await pending).kind).toBe(kind);
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    expect((await read()).kind).toBe('signed-out');
  });
}
for (const [status, phase] of [
  [200, 'headers'],
  [200, 'body'],
  [503, 'body'],
] as const)
  test(`consent stalled ${status} ${phase} unlocks explicit read retry; disposal hides late private data`, async () => {
    const states: ConsentReview[] = [];
    const review = createConsentReview(consent.client_id, '', (value) => states.push(value));
    globalThis.fetch = (() =>
      phase === 'headers'
        ? new Promise(() => {})
        : Promise.resolve(new Response(new ReadableStream(), { status }))) as typeof fetch;
    await review.load();
    expect(states.at(-1)?.state).toBe('failed');
    const late = Promise.withResolvers<Response>();
    const calls: string[] = [];
    globalThis.fetch = ((path, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      calls.push(String(path));
      return late.promise;
    }) as typeof fetch;
    const retry = review.load();
    await Promise.resolve();
    review.dispose();
    late.resolve(Response.json(consent));
    await retry;
    expect(states.at(-1)?.state).toBe('loading');
    expect(calls).toEqual(['/consent/selected-app']);
    globalThis.fetch = (async () => Response.json(consent)) as typeof fetch;
    expect((await readConsent(consent.client_id)).ok).toBe(true);
  });
test('failed passkeys keep sessions usable and offer a read-only reload of the current review', async () => {
  const supported = spyOn(passkeyBrowser, 'passkeysSupported').mockReturnValue(true);
  const page = securityEnvelope(session.account_id, [currentSecuritySession()], []);
  page.passkeys = { kind: 'unavailable' };
  const passkeys = spyOn(inventory, 'loadSecurityPage').mockResolvedValue({ kind: 'ready', page });
  try {
    const view = await fixture.open(
      createElement(SecurityPage, {
        initial: {
          kind: 'ready',
          accountId: session.account_id,
          page,
          sessions: page.sessions.kind === 'ready' ? page.sessions.rows : [],
          passkeys: { kind: 'failure', message: 'Unavailable' },
        },
        identitySource: async () => ({ kind: 'unavailable' }),
      }),
      session,
    );
    expect(view.host.querySelector('#security-sessions-heading')).not.toBeNull();
    globalThis.fetch = (async (path, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json(String(path) === '/sessions' ? { sessions: [] } : session);
    }) as typeof fetch;
    await fixture.flush(() => fixture.button(view.host, m.auth_inventory_reload())!.click());
    expect(passkeys).toHaveBeenCalledTimes(1);
    expect(view.calls).toHaveLength(0);
    expect(view.host.textContent).toContain(m.auth_security_passkeys_failed());
    expect(view.host.querySelector('#security-sessions-heading')).not.toBeNull();
  } finally {
    passkeys.mockRestore();
    supported.mockRestore();
  }
});
