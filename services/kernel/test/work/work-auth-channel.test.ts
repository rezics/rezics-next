import { expect, test } from 'bun:test';
import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { isWorkAuthMessage, WORK_AUTH_CHANNEL } from '../../src/composition/work-auth-host.ts';

const channel = WORK_AUTH_CHANNEL;

test('Realm consent IPC admits only the exact account and client lookup', () => {
  const request = {
    channel,
    type: 'realm-consent',
    id: 1,
    actorAccountId: 'account-id',
    clientId: 'rezics-website',
  };
  expect(isWorkAuthMessage(request)).toBe(true);
  expect(isWorkAuthMessage({ ...request, bearer: 'unexpected' })).toBe(false);
  expect(isWorkAuthMessage({ ...request, clientId: '' })).toBe(false);
  expect(isWorkAuthMessage({ ...request, clientId: 'line\nbreak' })).toBe(false);
});

test('Realm consent IPC distinguishes absent consent, failed lookup and a bounded scope result', () => {
  const reply = { channel, type: 'realm-consent-result', id: 1 };
  expect(isWorkAuthMessage({ ...reply, ok: true, scopes: ['realm:manage'] })).toBe(true);
  expect(isWorkAuthMessage({ ...reply, ok: true, scopes: null })).toBe(true);
  expect(isWorkAuthMessage({ ...reply, ok: false })).toBe(true);
  expect(isWorkAuthMessage({ ...reply, ok: false, scopes: [] })).toBe(false);
  expect(isWorkAuthMessage({ ...reply, ok: true })).toBe(false);
  expect(isWorkAuthMessage({ ...reply, ok: true, scopes: ['not a scope'] })).toBe(false);
  expect(isWorkAuthMessage({ ...reply, ok: true, scopes: Array(MAX_CONSENTED_SCOPES + 1).fill('realm:manage') })).toBe(
    false,
  );
  expect(isWorkAuthMessage({ channel, type: 'result', id: 1, ok: true })).toBe(true);
});
