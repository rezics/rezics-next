import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { closeRealm } from './outcomes/realm/closure-fixture.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions | undefined;
afterAll(async () => { await sessions?.close(); });

async function answer<T>(request: Promise<Response>, status: number): Promise<T> {
  const response = await request, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function read(person: PersonaSession, realm: string) {
  const response = await person.main('GET', `/v1/realms/${realm.slice(-36)}/classification-context`);
  return { status: response.status, body: await response.json() as unknown };
}

test('live Realm closure conceals its configured Context and scheme for all six personas', async () => {
  sessions = await personaSessions('public');
  const { owner, realm } = sessions;
  await grantPersonaFixtureAuthority(owner, [
    { scope: 'classification:define:global', action: 'classification.proposition.define' },
    { scope: `classification:context:${realm}`, action: 'classification.context.configure' },
  ]);
  const vocabulary = await answer<{ scheme: string; schemeHead: string }>(owner.main('POST',
    '/v1/classification-vocabulary', { profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: `Closure vocabulary ${randomUUID()}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: owner.actingSubject,
    }, randomUUID()), 201);
  const configured = await answer<{ context: string; contextRevision: string }>(owner.main('POST',
    '/v1/classification-contexts', { profile: 'classification-context-v2', realm,
      actingSubject: owner.actingSubject, expectedHead: null,
      scheme: { id: vocabulary.scheme, expectedHead: vocabulary.schemeHead },
    }, randomUUID()), 201);
  for (const name of personaNames) expect(await read(sessions[name], realm), name).toMatchObject({
    status: 200, body: { realm, context: configured.context,
      contextRevision: configured.contextRevision, scheme: vocabulary.scheme },
  });
  expect(await closeRealm(sessions)).toBeNull();
  const absent = `https://rezics.com/id/${randomUUID()}`;
  for (const name of personaNames) {
    const hidden = await read(sessions[name], realm);
    expect(hidden.status, name).toBe(404);
    expect(hidden, name).toEqual(await read(sessions[name], absent));
  }
});
