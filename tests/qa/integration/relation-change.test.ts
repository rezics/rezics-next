import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

type Changed = { component: string; revision: string; receipt: string; replayed: boolean };
type Relation = { occurrence: string; revision: string; predecessor: string | null;
  definition: { revision: string; lifecycle: string; roles: { key: string }[] };
  participations: { participation: string; role: string; participant: { ref: string }; availability: string }[] };

test('MODEL05/MODEL06: repeated participants keep two identified occurrences and a retired definition keeps exact meaning', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `relation-${randomUUID()}`));
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const semantic = (state: object, expectedHead: string | null = null, target?: string) =>
      f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor,
        ...(target ? { target } : {}), expectedHead, state });
    const definition = await f.json<Changed>(await semantic({ component: 'definition', kind: 'relation',
      lifecycle: 'active', successor: null, roles: [
        { key: 'source', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
      ] }), 201);
    const actor = await f.json<Changed>(await semantic({ component: 'resource',
      types: ['https://schema.org/Person'], properties: [] }), 201);
    const target = await f.json<Changed>(await semantic({ component: 'resource',
      types: ['https://schema.org/Person'], properties: [] }), 201);
    await f.grant(`semantic:read:${actor.component}`, 'semantic.read');
    const targetReadGrant = await f.grant(`semantic:read:${target.component}`, 'semantic.read');
    await f.grant('relation:create:root', 'relation.change');

    const body = { profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null,
      definition: definition.revision, participations: [
        { role: 'source', participant: { kind: 'resource', ref: actor.component } },
        { role: 'target', participant: { kind: 'resource', ref: target.component } },
      ] };
    const write = (request: object, key = randomUUID()) => f.call('POST', '/v1/relations/changes', request, key);
    const oversized = await write({ ...body, participations: Array.from({ length: 65 }, () =>
      ({ role: 'source', participant: { kind: 'resource', ref: actor.component } })) });
    expect(oversized.status).toBeGreaterThanOrEqual(400);
    expect(oversized.status).toBeLessThan(500);
    const firstKey = randomUUID();
    const first = await f.json<{ occurrence: string; revision: string; receipt: string; replayed: boolean }>(
      await write(body, firstKey), 201);
    const relationEvent = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?kind WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?event a ?kind ; rv:receipt ${iri(first.receipt)} } }`);
    expect(relationEvent.results?.bindings.map(row => row.kind!.value))
      .toEqual(['https://rezics.com/vocab/RelationChangedEvent']);
    const replay = await f.json<typeof first>(await write(body, firstKey), 201);
    expect(replay).toMatchObject({ occurrence: first.occurrence, revision: first.revision,
      receipt: first.receipt, replayed: true });
    const second = await f.json<typeof first>(await write(body), 201);
    expect(second.occurrence).not.toBe(first.occurrence);
    expect(second.revision).not.toBe(first.revision);
    const path = (occurrence: string, revision?: string) =>
      `/v1/relations/${shortId(occurrence)}${revision ? `/revisions/${shortId(revision)}` : ''}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await f.call('GET', path(first.occurrence))).status).toBe(404);
    await f.grant(`semantic:read:${first.occurrence}`, 'semantic.read');
    await f.grant(`semantic:read:${second.occurrence}`, 'semantic.read');
    const readFirst = await f.json<Relation>(await f.call('GET', path(first.occurrence)), 200);
    const readSecond = await f.json<Relation>(await f.call('GET', path(second.occurrence)), 200);
    expect(readFirst.definition.revision).toBe(definition.revision);
    expect(readFirst.definition.roles.map(role => role.key)).toEqual(['source', 'target']);
    expect(readFirst.participations.map(item => item.participation)).not.toEqual(
      readSecond.participations.map(item => item.participation));
    const nativeRoles = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?part ?role ?participant WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?part a rv:RelationParticipation ; rv:occurrence ${iri(first.occurrence)} ;
        rv:role ?role ; rv:participant ?participant } }`);
    expect(nativeRoles.results?.bindings).toHaveLength(2);
    expect(nativeRoles.results?.bindings.map(row => row.part!.value).sort())
      .toEqual(readFirst.participations.map(item => item.participation).sort());
    expect(nativeRoles.results?.bindings.map(row => row.participant!.value).sort())
      .toEqual([actor.component, target.component].sort());
    expect(readFirst.participations.map(item => item.participant.ref).sort())
      .toEqual([actor.component, target.component].sort());
    expect(readFirst.participations.every(item => item.availability === 'available')).toBe(true);

    await f.grant(`semantic:edit:${definition.component}`, 'semantic.change');
    await f.grant(`semantic:read:${definition.component}`, 'semantic.read');
    const retired = await f.json<Changed>(await semantic({ component: 'definition', kind: 'relation',
      lifecycle: 'retired', successor: null, roles: [
        { key: 'source', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
      ] }, definition.revision, definition.component), 200);
    expect(retired.revision).not.toBe(definition.revision);
    expect((await f.json<Relation>(await f.call('GET', path(first.occurrence, first.revision)), 200))
      .definition).toMatchObject({ revision: definition.revision, lifecycle: 'active' });
    const refused = await write(body);
    expect(refused.status).toBe(422);
    expect((await refused.json() as { code: string }).code).toBe('retired_definition');
    expect((await f.json<Relation>(await f.call('GET', path(second.occurrence)), 200))
      .definition.revision).toBe(definition.revision);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [targetReadGrant]);
    const redacted = await f.json<Relation>(await f.call('GET', path(first.occurrence)), 200);
    expect(redacted.participations.find(item => item.role === 'target')).toMatchObject({
      availability: 'unavailable', participant: { kind: 'unavailable-reference' } });
    expect(JSON.stringify(redacted)).not.toContain(target.component);
  } finally { await f.close(); }
}, 180_000);
