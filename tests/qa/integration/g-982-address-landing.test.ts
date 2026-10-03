import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { ALIAS_COST } from '../../../services/main/src/modules/address/registry.ts';
import type { ResolvedAddress } from '../../../apps/web/features/address/client.ts';

test('G982: named request admission resolves through the public API and mounts the limited landing; invitation remains hidden', async () => {
  const s = await startMediaStack('g-982-address-landing');
  try {
    const owner = await s.member('owner'),
      outsider = await s.member('outsider');
    await owner.grant('space:create:root', 'space.create');
    const handle = `private-${randomUUID().slice(0, 8)}`;
    const created = await owner.send('POST', '/v1/spaces', {
      profile: 'space-realm-v2',
      handle,
      name: 'Private request community',
      language: 'en',
      capabilities: ['realm'],
      actingSubject: owner.actor,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { space, realm } = (await created.json()) as { space: string; realm: string };
    const admin = new AccessRealmManagement(s.accessPool);
    await admin.initialize(owner.principal, realm, owner.actor, s.env);
    await owner.grant(`governance:realm:${realm}`, 'realm.owner');
    const app = createMainApp(s.fuseki, {
      environment: s.env,
      access: s.access,
      realmAdmin: admin,
      account: {
        verify: async (request) =>
          request.headers.get('authorization') === `Bearer ${owner.token}`
            ? owner.principal
            : outsider.principal,
      },
    });
    const call = (path: string, subject?: typeof owner) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          headers: subject ? { authorization: `Bearer ${subject.token}` } : {},
        }),
      );
    const resolve = (key: string, subject?: typeof owner) =>
      call(
        `/v1/addresses/resolve?${new URLSearchParams({
          scope: 'space',
          key,
          ...(subject ? { actingSubject: subject.actor } : {}),
        })}`,
        subject,
      );
    // The BFF forwards its session bearer; authenticated reads also need the Agent.
    expect(
      (await call(`/v1/addresses/resolve?scope=space&key=${space.slice(-36)}`, outsider)).status,
    ).toBe(400);
    expect((await resolve(space.slice(-36), outsider)).status).toBe(200);
    const settings = `/v1/spaces/${space.slice(-36)}/settings`;
    const policy = async (admission: 'request' | 'invitation') => {
      const current = await admin.spaceSettings(owner.principal, space, owner.actor, s.env);
      const response = await app.handle(
        new Request(`http://main.local${settings}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${owner.token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            actingSubject: owner.actor,
            expectedGeneration: current.generation,
            reason: 'Exercise direct request admission addresses',
            settings: {
              visibility: 'private',
              listing: 'listed',
              history: 'from-admission',
              admission,
            },
          }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(201);
    };
    await policy('request');
    for (const key of [handle, space.slice(-36), uuidToSid(space.slice(-36)), realm.slice(-36)]) {
      const before = s.fuseki.queries;
      const response = await resolve(key);
      expect(response.status, await response.clone().text()).toBe(200);
      const address = (await response.json()) as ResolvedAddress;
      expect(address).toMatchObject({
        holder: space,
        canonical: { prefix: '/r/', key: handle, suffixSource: '' },
        capabilities: { realm },
      });
      expect(address.capabilities?.zone).toBeUndefined();
      expect(s.fuseki.queries - before).toBeLessThanOrEqual(ALIAS_COST.fusekiRequests.resolve);
      const landing = await call(`/v1/realms/${address.capabilities!.realm!.slice(-36)}/join-page`);
      expect(landing.status).toBe(200);
      expect(await landing.json()).toMatchObject({
        profile: 'realm-join-page-v1',
        id: realm,
        name: { value: 'Private request community' },
      });
      expect(landing.headers.get('x-robots-tag')).toBe('noindex');
    }
    expect((await resolve(handle, outsider)).status).toBe(200);
    for (const path of [`/v1/realms/${realm.slice(-36)}`, `/v1/realms/${realm.slice(-36)}/works`]) {
      expect((await call(path)).status).toBe(404);
      expect(
        (await call(`${path}?actingSubject=${encodeURIComponent(outsider.actor)}`, outsider))
          .status,
      ).toBe(404);
    }
    await policy('invitation');
    expect((await resolve(handle)).status).toBe(404);
    expect((await resolve(handle, outsider)).status).toBe(404);
    await policy('request');
    expect((await resolve(handle)).status).toBe(200);
  } finally {
    await s.stop();
  }
});
