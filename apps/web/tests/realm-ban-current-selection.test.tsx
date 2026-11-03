import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { admitRealmBanCurrent, unavailableRealmBanCurrent } from '../src/community/realm-ban-current';
import { RealmBanCurrentObservationView } from '../src/community/realm-ban-current-control';
import { m } from '../src/paraglide/messages.js';

const input = Object.freeze({ realmId: 'realm', accountId: 'account', cursor: 'opaque-frontier' });
const ban = { accountId: input.accountId, actor: null, at: '2026-11-02T14:05:00Z', reason: 'Actual reason\nFull text' };

test('exact observations bind the Realm, selected account and unchanged frontier; failures never establish absence', async () => {
  for (const other of [
    { ...input, realmId: 'replacement' },
    { ...input, accountId: 'replacement' },
    { ...input, cursor: 'replacement' },
    { realmId: input.realmId, accountId: input.accountId },
  ]) {
    expect(admitRealmBanCurrent(input, { state: 'absent', input: other })).toEqual({ state: 'unavailable' });
    expect(admitRealmBanCurrent(input, { state: 'current', input: other, ban })).toEqual({ state: 'unavailable' });
  }
  expect(admitRealmBanCurrent(input, { state: 'current', input, ban: { ...ban, accountId: 'other' } })).toEqual({
    state: 'unavailable',
  });
  for (const state of ['forbidden', 'unavailable', 'signed-out', 'closed'] as const)
    expect(admitRealmBanCurrent(input, { state })).toEqual({ state });
  expect(await unavailableRealmBanCurrent(input)).toEqual({ state: 'unavailable' });
  const current = admitRealmBanCurrent(input, { state: 'current', input, ban });
  expect(current.state).toBe('current');
  if (current.state !== 'current') throw new Error('Expected current episode');
  ban.reason = 'Later replacement';
  expect(current.ban.reason).toBe('Actual reason\nFull text');
  expect(Object.isFrozen(current.ban)).toBe(true);
  expect(Object.isFrozen(current.input)).toBe(true);
  const replacement = admitRealmBanCurrent(input, {
    state: 'current',
    input,
    ban: { ...ban, at: '2026-11-03T10:00:00Z' },
  });
  expect(replacement).not.toEqual(current);
  expect(current.input.cursor).toBe('opaque-frontier');
});

test('selected current facts and operational absence do not claim a definitive command or removal completion', () => {
  const observation = { state: 'current' as const, input, ban: { ...ban, reason: 'Displayed reason' } };
  const html = renderToStaticMarkup(createElement(RealmBanCurrentObservationView, { observation }));
  expect(html).toContain('Displayed reason');
  expect(html).toContain('2026-11-02 14:05:00 UTC');
  expect(html).toContain(m.realm_bans_moderator_erased());
  expect(html).toContain(m.realm_bans_help());
  expect(html).not.toContain('realm-ban-outcome');
  const absent = admitRealmBanCurrent(input, { state: 'absent', input });
  if (absent.state !== 'absent') throw new Error('Expected admitted absence');
  const absence = renderToStaticMarkup(createElement(RealmBanCurrentObservationView, { observation: absent }));
  expect(absence).toContain(m.realm_bans_inspect_absent());
  expect(absence).not.toContain('Displayed reason');
  expect(absence).not.toContain(m.realm_bans_lifted());
});
