import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { personaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';

async function answer<T>(pending: Promise<Response>, status: number): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

test('Realm owner can preview and commit a Concept-scoped placement role over HTTP', async () => {
  const sessions = await personaSessions('public');
  try {
    await grantPersonaFixtureAuthority(sessions.owner, [
      { scope: 'classification:define:global', action: 'classification.proposition.define' },
    ]);
    const vocabulary = await answer<{ concept: string }>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: `Placement jurisdiction ${randomUUID()}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: sessions.owner.actingSubject,
    }), 201);
    const root = `/v1/realms/${sessions.realm.slice(-36)}`;
    const roles = await answer<{ generation: string }>(sessions.owner.main('GET',
      `${root}/roles?${new URLSearchParams({ actingSubject: sessions.owner.actingSubject! })}`), 200);
    const input = {
      actingSubject: sessions.owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Bound placement management to this exact Concept',
      change: { kind: 'role', roleId: randomUUID(), name: 'Concept placement managers',
        permissions: ['publication.adopt'], targetScope: { kind: 'concept', id: vocabulary.concept } },
    };
    const observations: { request: string; input: unknown; status: number; answer: unknown }[] = [];
    const preview = await sessions.owner.main('POST', `${root}/role-impact`, input);
    const impact = await preview.json() as { digest: string };
    observations.push({ request: `POST ${root}/role-impact`, input, status: preview.status, answer: impact });
    const directory = join('.temp', 'goal', 'realm-concept-jurisdiction', Bun.env.REZICS_QA_RUN_ID!);
    mkdirSync(directory, { recursive: true });
    const record = () => writeFileSync(join(directory, 'http.json'), JSON.stringify(observations, null, 2));
    record();
    expect(preview.status, JSON.stringify(observations, null, 2)).toBe(200);
    const changeInput = { ...input, impactDigest: impact.digest };
    const changed = await sessions.owner.main('POST', `${root}/role-changes`, changeInput);
    observations.push({ request: `POST ${root}/role-changes`, input: changeInput,
      status: changed.status, answer: await changed.json() });
    record();
    expect(observations.map(({ status }) => status), JSON.stringify(observations, null, 2)).toEqual([200, 201]);
    const readback = await answer<{ roles: { id: string; targetScope: unknown }[] }>(sessions.owner.main('GET',
      `${root}/roles?${new URLSearchParams({ actingSubject: sessions.owner.actingSubject! })}`), 200);
    expect(readback.roles.find(role => role.id === input.change.roleId)?.targetScope).toEqual(input.change.targetScope);
  } finally { await sessions.close(); }
}, 120_000);
