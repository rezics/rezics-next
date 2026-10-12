import { describe, expect, test, vi } from 'vitest';
import type { SiteResolution } from '../realm/read.ts';
import { targetKey } from '../address/path.ts';
import { resolveZoneManagementAddress, zoneManagementBinding, zoneManagementReturnAddress } from './management-address.ts';

const zoneId = '00000000-0000-4000-8000-000000000521';
const spaceId = '00000000-0000-4000-8000-000000000522';
const otherId = '00000000-0000-4000-8000-000000000523';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const row = {
  revision: iri(otherId), name: 'Harbor notes',
  configuration: { zone: iri(zoneId), space: iri(spaceId), state: 'active', advancedBase64: 'opaque' },
};
const site: Extract<SiteResolution, { kind: 'site' }> = {
  kind: 'site', zone: zoneId, realm: null,
  address: { profile: 'address-resolution-v1', status: 'resolved', scope: 'space', key: spaceId,
    state: 'current', holder: iri(spaceId), canonical: { prefix: '/z/', key: targetKey(spaceId), suffixSource: 'Harbor notes' },
    capabilities: { zone: iri(zoneId) } },
};

describe('Zone management identity admission', () => {
  test('a Zone UUID resolves its authorized Space binding before opening the full editor', async () => {
    const configuration = vi.fn(async () => ({ ok: true as const, data: row }));
    const resolve = vi.fn(async () => site);
    const answer = await resolveZoneManagementAddress(zoneId, 'en', { configuration, site: resolve });
    expect(configuration).toHaveBeenCalledWith(zoneId);
    expect(resolve).toHaveBeenCalledWith(spaceId, 'en');
    expect(answer).toEqual({ kind: 'site', site, binding: zoneManagementBinding(zoneId, row) });
    expect(resolve.mock.calls).toEqual([[spaceId, 'en']]);
  });

  test('a raw Space UUID remains a Space entry when it is not a Zone', async () => {
    const configuration = vi.fn(async () => ({ ok: false as const, failure: 'denied' as const }));
    const resolve = vi.fn(async () => site);
    expect(await resolveZoneManagementAddress(spaceId, 'en', { configuration, site: resolve }))
      .toEqual({ kind: 'site', site, binding: null });
    expect(configuration).toHaveBeenCalledWith(spaceId);
    expect(resolve).toHaveBeenCalledWith(spaceId, 'en');
  });

  test('retired UUID entries keep the authorized recovery binding without a public read', async () => {
    const retired = { ...row, configuration: { ...row.configuration, state: 'retired' } };
    const resolve = vi.fn(async () => site);
    expect(await resolveZoneManagementAddress(zoneId, 'en', {
      configuration: async () => ({ ok: true, data: retired }), site: resolve,
    })).toEqual({ kind: 'lifecycle', binding: zoneManagementBinding(zoneId, retired) });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('invalid bindings and mismatched Space or Zone admissions refuse the editor', async () => {
    for (const configuration of [
      { ...row, configuration: { ...row.configuration, zone: iri(otherId) } },
      { ...row, configuration: { ...row.configuration, space: 'unrelated' } },
    ]) {
      const resolve = vi.fn(async () => site);
      expect(await resolveZoneManagementAddress(zoneId, 'en', {
        configuration: async () => ({ ok: true, data: configuration }), site: resolve,
      })).toEqual({ kind: 'failure', failure: 'unavailable' });
      expect(resolve).not.toHaveBeenCalled();
    }
    for (const admission of [
      { ...site, zone: otherId },
      { ...site, address: { ...site.address, holder: iri(otherId) } },
    ]) expect(await resolveZoneManagementAddress(zoneId, 'en', {
      configuration: async () => ({ ok: true, data: row }), site: async () => admission,
    })).toEqual({ kind: 'failure', failure: 'unavailable' });
  });

  test('sign-in and unavailable configuration reads do not fall through to public lookup', async () => {
    for (const failure of ['sign-in', 'unavailable', 'moved'] as const) {
      const resolve = vi.fn(async () => site);
      expect(await resolveZoneManagementAddress(zoneId, 'en', {
        configuration: async () => ({ ok: false, failure }), site: resolve,
      })).toEqual({ kind: 'failure', failure });
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  test('readable Space addresses continue through their admission owner', async () => {
    const configuration = vi.fn(async () => ({ ok: true as const, data: row }));
    const resolve = vi.fn(async () => site);
    expect(await resolveZoneManagementAddress('harbor', 'en', { configuration, site: resolve }))
      .toEqual({ kind: 'site', site, binding: null });
    expect(configuration).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith('harbor', 'en');
  });
});

describe('verified recovery return addresses', () => {
  const binding = { zoneId, spaceId };
  test('Status navigation retains a verified Space address and UUID fallback', () => {
    const address = `${targetKey(spaceId)}-Harbor-notes`;
    for (const candidate of [address, spaceId, zoneId, targetKey(spaceId)]) {
      expect(zoneManagementReturnAddress(candidate, binding)).toBe(candidate);
    }
  });

  test('unrelated identities and malformed return addresses use the bound Space fallback', () => {
    for (const candidate of [otherId, targetKey(otherId), '//elsewhere.test', 'harbor/another', undefined]) {
      expect(zoneManagementReturnAddress(candidate, binding)).toBe(targetKey(spaceId));
    }
  });

  test('a readable alias is retained only with admission for the same Space', () => {
    expect(zoneManagementReturnAddress('harbor', binding)).toBe(targetKey(spaceId));
    expect(zoneManagementReturnAddress('harbor', binding, { address: 'harbor', space: iri(otherId) })).toBe(targetKey(spaceId));
    expect(zoneManagementReturnAddress('harbor', binding, { address: 'harbor', space: iri(spaceId) })).toBe('harbor');
  });
});
