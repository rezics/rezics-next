import { expect, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/client';
import {
  bindZoneSession,
  nextKernelSession,
  zoneKernelHeaders,
  zoneMediaCredential,
  zoneSessionRevoked,
} from '../src/zones/session';
import { zoneCallbackIdentity, replaceZoneCallback } from '../src/zones/callback';

const visit = {
  locale: 'en',
  zoneId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e13',
  target: { kind: 'route' as const, route: '' },
};

test('Zone BFF session headers use the current personal credential and kernel token', () => {
  const headers = zoneKernelHeaders({ authorization: 'Bearer alice', kernelSession: 'start' }, 'next');
  expect(headers).toEqual({ authorization: 'Bearer alice', [SESSION_HEADER]: 'next' });
  expect(zoneKernelHeaders({})).toBeUndefined();
  const response = new Response(null, { headers: { [SESSION_HEADER]: 'refreshed' } });
  expect(nextKernelSession(response, 'start')).toBe('refreshed');
  expect(zoneSessionRevoked({}, 'session')).toBe(true);
  expect(zoneSessionRevoked({ authorization: 'Bearer alice' }, 'session')).toBe(false);
  expect(zoneSessionRevoked({}, 'anonymous')).toBe(false);
});

test('revocation and suspension take effect on the next BFF request', async () => {
  const request = new Request('https://site.test/en/zones/one');
  const anonymous = await bindZoneSession(request, {}, 'anonymous');
  expect(anonymous).toEqual({});
  expect(zoneMediaCredential(request)).toBeNull();
});

test('source replacement retires the previous Zone callback identity', () => {
  const current = zoneCallbackIdentity(visit, '4');
  expect(replaceZoneCallback(current, '4')).toEqual(current);
  expect(replaceZoneCallback(current, '5')?.revision).toBe('5');
  expect(replaceZoneCallback(current, '5')?.key).not.toBe(current.key);
});
