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
import {
  receiveZoneDownloadRequest,
  receiveZoneMediaCompletion,
  receiveZoneMediaIntent,
  zoneDownloadAuthorization,
  zoneRequestTransport,
  zoneTransportHeaders,
  zoneUploadCompletion,
  zoneUploadIntent,
} from '../src/zones/transport';

const visit = {
  locale: 'en',
  zoneId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e13',
  target: { kind: 'route' as const, route: '' },
};

const intent = { purpose: 'post-image' as const, mediaType: 'image/png' as const, byteCount: 12 };

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
  const unsigned = await zoneRequestTransport(request, {}, 'session');
  expect(unsigned.revoked).toBe(true);
  expect(zoneTransportHeaders(unsigned)).toBeUndefined();
  expect(await zoneDownloadAuthorization(unsigned, async () => ({ allowed: true }))).toEqual({ allowed: false });
  expect(
    await zoneUploadIntent(unsigned, intent, async () => {
      throw new Error('revoked session must not reserve');
    }),
  ).toEqual({ kind: 'unsigned' });
  expect(
    await zoneUploadCompletion(unsigned, { sha256: 'a'.repeat(64) }, async () => {
      throw new Error('revoked session must not complete');
    }),
  ).toEqual({ kind: 'unsigned' });
});

test('a live Zone session carries the current credential into the existing media driver', async () => {
  const live = { authorization: 'Bearer alice', stale: false, revoked: false };
  expect(
    await zoneDownloadAuthorization(live, async (credential) => {
      expect(credential).toBe('Bearer alice');
      return { allowed: true };
    }),
  ).toEqual({ allowed: true });
  expect(
    await zoneUploadIntent(live, intent, async (credential, body) => {
      expect(credential).toBe('Bearer alice');
      expect(body).toEqual(intent);
      return { id: 'media-1' };
    }),
  ).toEqual({ kind: 'media', media: { id: 'media-1' } });
  expect(
    await zoneUploadCompletion(live, { sha256: 'b'.repeat(64) }, async (credential, body) => {
      expect(credential).toBe('Bearer alice');
      expect(body.sha256).toHaveLength(64);
      return { id: 'media-1', state: 'uploaded' };
    }),
  ).toEqual({ kind: 'media', media: { id: 'media-1', state: 'uploaded' } });
});

test('Zone media intent, completion and download locators reject untrusted input', () => {
  expect(receiveZoneMediaIntent(intent)).toEqual(intent);
  expect(receiveZoneMediaIntent({ ...intent, purpose: 'avatar' })).toBeUndefined();
  expect(receiveZoneMediaIntent({ ...intent, byteCount: 0 })).toBeUndefined();
  expect(receiveZoneMediaCompletion({ sha256: 'c'.repeat(64) })).toEqual({ sha256: 'c'.repeat(64) });
  expect(receiveZoneMediaCompletion({ sha256: 'nope' })).toBeUndefined();
  expect(receiveZoneDownloadRequest({ id: 'cover_1', variant: 'cover' })).toEqual({
    id: 'cover_1',
    variant: 'cover',
  });
  expect(receiveZoneDownloadRequest({ id: '../secret', variant: 'cover' })).toBeUndefined();
});

test('source replacement retires the previous Zone callback identity', () => {
  const current = zoneCallbackIdentity(visit, '4');
  expect(replaceZoneCallback(current, '4')).toEqual(current);
  expect(replaceZoneCallback(current, '5')?.revision).toBe('5');
  expect(replaceZoneCallback(current, '5')?.key).not.toBe(current.key);
});
