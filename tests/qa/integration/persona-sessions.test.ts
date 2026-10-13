import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { personaNames, personaSessions, type PersonaSessions } from '../support/personas.ts';

let publicRealm: PersonaSessions;
let privateRealm: PersonaSessions;
beforeAll(async () => {
  publicRealm = await personaSessions('public');
  privateRealm = await personaSessions('private');
  console.log(
    `Persona setup: public ${publicRealm.elapsedSeconds.toFixed(2)}s, private ${privateRealm.elapsedSeconds.toFixed(2)}s`,
  );
}, 120_000);
afterAll(async () => {
  await publicRealm?.close();
});

for (const name of personaNames)
  test(`${name} reads public and private Realms through HTTP with their own relation`, async () => {
    for (const fixture of [publicRealm, privateRealm]) {
      const person = fixture[name];
      const account = await person.account('GET', '/api/auth/get-session');
      expect(account.status).toBe(200);
      const identity = (await account.json()) as { user?: { id: string } } | null;
      expect(identity?.user?.id ?? null).toBe(person.accountId);
      const actor = person.actingSubject
        ? `?actingSubject=${encodeURIComponent(person.actingSubject)}`
        : '';
      const response = await person.main('GET', `/v1/realms/${fixture.realm.slice(-36)}${actor}`);
      const body = (await response.json()) as { id?: string };
      // The moderator is a joined member with a role; the operator has no Realm relation.
      const allowed =
        fixture.visibility === 'public' || ['member', 'owner', 'moderator'].includes(name);
      expect({
        status: response.status,
        ...(response.status === (allowed ? 200 : 404) ? {} : { body }),
      }).toEqual({ status: allowed ? 200 : 404 });
      if (allowed) expect(body.id).toBe(fixture.realm);
      else expect(JSON.stringify(body)).not.toContain(fixture.realm);
    }
  });

test('sessions distinguish membership, moderation and platform authority', async () => {
  for (const fixture of [publicRealm, privateRealm]) {
    const moderator = fixture.moderator;
    const response = await moderator.main(
      'GET',
      `/v1/realms/${fixture.realm.slice(-36)}/moderation?actingSubject=${encodeURIComponent(moderator.actingSubject!)}`,
    );
    expect(response.status).toBe(200);
    for (const person of [fixture.member, moderator]) {
      const membership = await person.main(
        'GET',
        `/v1/me/memberships?actingSubject=${encodeURIComponent(person.actingSubject!)}`,
      );
      expect(membership.status).toBe(200);
      expect(
        ((await membership.json()) as { items: { realm: string }[] }).items.some(
          (item) => item.realm === fixture.realm,
        ),
      ).toBe(true);
    }
  }
  const platform = await privateRealm.operator.main('GET', '/v1/me/platform-access');
  expect(platform.status).toBe(200);
  expect(((await platform.json()) as { groups: string[] }).groups).toContain('platform-admin');
  const stranger = await privateRealm.stranger.main('GET', '/v1/me/platform-access');
  expect(stranger.status).toBe(200);
  expect(((await stranger.json()) as { groups: string[] }).groups).toEqual([]);
});

test('persona callers preserve an explicit idempotency key on every HTTP method', async () => {
  const fetchRequest = globalThis.fetch;
  const sent: (string | null)[] = [];
  const observe = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (new URL(String(input)).pathname === '/v1/me/platform-access')
      sent.push(new Headers(init?.headers).get('idempotency-key'));
    return fetchRequest(input, init);
  };
  const observer = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(observe, { preconnect: fetchRequest.preconnect }),
  );
  try {
    for (const method of ['GET', 'HEAD', 'POST'])
      await publicRealm.operator.main(method, '/v1/me/platform-access', undefined, 'caller-key');
    expect(sent).toEqual(['caller-key', 'caller-key', 'caller-key']);
  } finally {
    observer.mockRestore();
  }
});

test('closing the listeners allows another outcome fixture on the same integration stack', async () => {
  await publicRealm.close();
  const reopened = await personaSessions('public');
  try {
    const response = await reopened.visitor.main('GET', `/v1/realms/${reopened.realm.slice(-36)}`);
    expect(response.status).toBe(200);
    expect(reopened.operator.accountId).toBe(publicRealm.operator.accountId);
    expect(reopened.owner.accountId).not.toBe(publicRealm.owner.accountId);
  } finally {
    await reopened.close();
  }
});
