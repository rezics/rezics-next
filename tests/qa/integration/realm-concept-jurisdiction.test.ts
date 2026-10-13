import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { personaSessions, type PersonaSession } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { realmConceptGrantProof, realmTransaction } from '../../../services/main/src/modules/access/realm-management-authority.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';

async function answer<T>(pending: Promise<Response>, status: number): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

test('Realm owner assigns, moves and revokes exact Concept moderator and operator jurisdiction over HTTP', async () => {
  const sessions = await personaSessions('public');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await grantPersonaFixtureAuthority(sessions.owner, [
      { scope: 'classification:define:global', action: 'classification.proposition.define' },
      { scope: 'context:create:root', action: 'context.create' },
    ]);
    type Vocabulary = { concept: string; scheme: string; schemeHead: string; definitionRevision: string };
    const vocabulary = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: `Placement jurisdiction ${randomUUID()}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: sessions.owner.actingSubject,
    }), 201);
    const child = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: { id: vocabulary.scheme, expectedHead: vocabulary.schemeHead },
      labels: [{ language: 'en', value: `Narrower placement jurisdiction ${randomUUID()}` }],
      alternativeLabels: [], broader: [vocabulary.concept], narrower: [], actingSubject: sessions.owner.actingSubject,
    }), 201);
    const mapped = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: { id: child.scheme, expectedHead: child.schemeHead },
      labels: [{ language: 'en', value: `Mapped placement jurisdiction ${randomUUID()}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: sessions.owner.actingSubject,
    }), 201);
    // A reviewed semantic mapping carries no placement grant and does not
    // turn distinct Concept identities into authority aliases.
    const relation = `${RV}classifiedAs`;
    const context = await answer<{ context: string; semanticRevision: string }>(sessions.owner.main('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [vocabulary, mapped].map(value => ({ target: value.concept, relation,
        state: 'defined', definition: value.definitionRevision, applicability: [] })),
      actingSubject: sessions.owner.actingSubject,
    }), 201);
    await grantPersonaFixtureAuthority(sessions.owner, [{ scope: `context:change:${context.context}`, action: 'context.equivalence.review' }]);
    const mapping = await answer<{ mapping: string }>(sessions.owner.main('POST', '/v1/context-definition-equivalences', {
      profile: 'context-definition-equivalence-v1', context: context.context, semanticRevision: context.semanticRevision,
      relation, left: { target: vocabulary.concept, definition: vocabulary.definitionRevision },
      right: { target: mapped.concept, definition: mapped.definitionRevision }, actingSubject: sessions.owner.actingSubject,
    }), 201);
    await answer(sessions.owner.main('GET', `/v1/context-definition-equivalences?${new URLSearchParams({ mapping: mapping.mapping })}`), 200);
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
    const change = async (value: object) => {
      const current = await answer<{ generation: string }>(sessions.owner.main('GET',
        `${root}/roles?${new URLSearchParams({ actingSubject: sessions.owner.actingSubject! })}`), 200);
      const request = { ...input, expectedGeneration: current.generation, change: value };
      const response = await sessions.owner.main('POST', `${root}/role-impact`, request);
      const previewBody = await response.json() as { digest: string };
      observations.push({ request: `POST ${root}/role-impact`, input: request, status: response.status, answer: previewBody });
      record();
      expect(response.status, JSON.stringify(observations.at(-1))).toBe(200);
      const commit = { ...request, impactDigest: previewBody.digest };
      const result = await sessions.owner.main('POST', `${root}/role-changes`, commit);
      const receipt = await result.json() as { impact: { affectedCount: number; changes: {
        member: string; jurisdictions: { targetScope: unknown; gained: string[]; lost: string[] }[] }[] } };
      observations.push({ request: `POST ${root}/role-changes`, input: commit, status: result.status, answer: receipt });
      record();
      expect(result.status, JSON.stringify(observations.at(-1))).toBe(201);
      return receipt;
    };
    const proof = async (person: PersonaSession, concept: string, action = 'publication.adopt', realm = sessions.realm) => {
      const principal = (await pool.query<{ issuer: string; subject: string }>(
        'SELECT account_issuer AS issuer,account_subject AS subject FROM access.principal WHERE account_subject=$1',
        [person.accountId])).rows[0]!;
      return realmTransaction(pool, realm, false, client => realmConceptGrantProof(client,
        principal, realm, person.actingSubject!, concept, action));
    };
    expect(await proof(sessions.moderator, vocabulary.concept)).toBeNull();
    expect(await proof(sessions.operator, vocabulary.concept)).toBeNull();
    const operatorResponse = await sessions.operator.main('POST', `${root}/role-impact`, {
      ...input, actingSubject: sessions.operator.actingSubject,
    });
    expect(operatorResponse.status, await operatorResponse.text()).toBe(403);
    for (const person of [sessions.moderator, sessions.operator]) {
      await change({ kind: 'assignment', roleId: input.change.roleId, member: person.actingSubject, assigned: true,
        validUntil: new Date(Date.now() + 3_600_000).toISOString(), targetScope: input.change.targetScope });
      expect(await proof(person, vocabulary.concept)).not.toBeNull();
      expect(await proof(person, child.concept)).toBeNull();
      expect(await proof(person, mapped.concept)).toBeNull();
      expect(await proof(person, vocabulary.concept, 'rating.configure')).toBeNull();
    }
    const roster = await answer<{ items: { member: string; roles: { id: string; targetScope: unknown }[] }[] }>(
      sessions.owner.main('GET', `${root}/members?${new URLSearchParams({ actingSubject: sessions.owner.actingSubject! })}`), 200);
    for (const person of [sessions.moderator, sessions.operator]) {
      expect(roster.items.find(item => item.member === person.actingSubject)?.roles)
        .toContainEqual(expect.objectContaining({ id: input.change.roleId, targetScope: input.change.targetScope }));
    }
    const moved = await change({ ...input.change, targetScope: { kind: 'concept', id: child.concept } });
    expect(moved.impact.affectedCount).toBe(2);
    for (const person of [sessions.moderator, sessions.operator]) {
      expect(moved.impact.changes.find(row => row.member === person.actingSubject)?.jurisdictions).toEqual([
        { targetScope: input.change.targetScope, gained: [], lost: ['publication.adopt'] },
        { targetScope: { kind: 'concept', id: child.concept }, gained: ['publication.adopt'], lost: [] },
      ]);
      expect(await proof(person, vocabulary.concept)).toBeNull();
      expect(await proof(person, child.concept)).not.toBeNull();
      await change({ kind: 'assignment', roleId: input.change.roleId, member: person.actingSubject, assigned: false,
        validUntil: new Date(Date.now() + 3_600_000).toISOString(), targetScope: { kind: 'concept', id: child.concept } });
      expect(await proof(person, child.concept)).toBeNull();
    }
  } finally { await pool.end(); await sessions.close(); }
}, 120_000);
