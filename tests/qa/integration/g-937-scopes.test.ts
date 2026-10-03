import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { addressFixture } from './g-937-support.ts';

test('G937: Agent and Space scopes share controller-safe names and enforce cooldown and canonical policy', async () => {
  const f = await addressFixture('scopes');
  const handle = `moon_${randomUUID().slice(0, 8)}`;
  const head = `https://rezics.com/id/${randomUUID()}`;
  try {
    await f.nativeFuseki
      .update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(f.actor)} a rv:Agent ; rv:head ${iri(head)} ;
        rv:agentKind rv:PersonAgent ; rdfs:label "A public writer"@en ; rv:profileDisclosure rv:Public }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:RevisionAnchor ; rv:component ${iri(f.actor)} ;
          rv:modelRevision <https://rezics.com/definition/agent-provision-v1> } }`);
    expect((await f.nameWrite('agent', f.actor, 'claim', handle, null)).status).toBe(403);
    await f.accessPool.query(
      `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`,
      [randomUUID(), f.principalId, f.actor],
    );
    expect((await f.nameWrite('agent', f.actor, 'claim', 'admin', null)).status).toBe(400);
    const agent = await f.receipt(await f.nameWrite('agent', f.actor, 'claim', handle, null));
    expect(await f.json(await f.lookup('agent', uuidToSid(f.actor.slice(-36))), 200)).toMatchObject(
      {
        holder: f.actor,
        canonical: { prefix: '/@', key: handle, slugSource: 'A public writer' },
      },
    );
    expect(
      (await f.nameWrite('agent', f.actor, 'rename', `${handle}_new`, agent.revision)).status,
    ).toBe(409);
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(
      await f.call('POST', '/v1/spaces', {
        profile: 'space-realm-v2',
        name: 'A community',
        language: 'en',
        capabilities: ['realm'],
        handle,
        actingSubject: f.actor,
      }),
      201,
    );
    for (const identity of [space.space, space.realm])
      expect(
        await f.json(await f.lookup('space', uuidToSid(identity.slice(-36))), 200),
      ).toMatchObject({ holder: space.space, canonical: { prefix: '/r/', key: handle } });
    const foreign = `https://rezics.com/id/${randomUUID()}`,
      foreignSpace = `https://rezics.com/id/${randomUUID()}`,
      foreignRealm = `https://rezics.com/id/${randomUUID()}`;
    await f.nativeFuseki
      .update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(foreignSpace)} a rv:Space ; rv:owner ${iri(foreign)} ; rv:disclosure rv:Public ;
          rv:realmCapability ${iri(foreignRealm)} ; rdfs:label "Other community"@en .
        ${iri(foreignRealm)} a rv:Realm ; rv:space ${iri(foreignSpace)} ; rv:realmState rv:Active . } }`);
    await f.grant(`governance:realm:${foreignRealm}`, 'realm.owner');
    expect(
      (await f.nameWrite('space', foreignSpace, 'claim', handle.replace('moon', 'rn00n'), null))
        .status,
    ).toBe(409);
    expect((await f.nameWrite('space', foreignSpace, 'claim', handle, null)).status).toBe(409);
    await f.accessPool.query(
      "UPDATE access.name_registry SET changed_at = clock_timestamp() - interval '31 days' WHERE scope = 'agent' AND holder = $1",
      [f.actor],
    );
    const renamed = await f.receipt(
      await f.nameWrite('agent', f.actor, 'rename', `${handle}_new`, agent.revision),
    );
    expect(await f.json(await f.lookup('agent', handle), 200)).toMatchObject({
      state: 'redirect',
      canonical: { key: renamed.key },
    });
    const batch = await f.json<{ summaries: unknown[] }>(
      await f.publicCall('/v1/resources/summaries', {
        profile: 'resource-summary-batch-v1',
        resources: [f.actor, space.space, space.realm, f.actor],
      }),
      200,
    );
    expect(batch.summaries[0]).toMatchObject({ address: { prefix: '/@', key: renamed.key } });
    expect(batch.summaries[1]).toMatchObject({ address: { prefix: '/r/', key: handle } });
    expect(batch.summaries[2]).toMatchObject({ address: { prefix: '/r/', key: handle } });
    expect(batch.summaries[3]).toEqual(batch.summaries[0]);
    expect(
      (
        await f.accessPool.query(
          "SELECT scope,key,holder,state FROM access.name_registry WHERE scope = 'agent' AND key = $1",
          [renamed.key],
        )
      ).rows[0],
    ).toEqual({ scope: 'agent', key: renamed.key, holder: f.actor, state: 'current' });
    // The Agent handle bridge was removed by migration 1024. Permanent
    // ownership is guarded by the canonical registry, including for SQL writers.
    await expect(
      f.accessPool.query("UPDATE access.name_registry SET holder = $2 WHERE scope = 'agent' AND key = $1", [
        renamed.key, foreign,
      ]),
    ).rejects.toThrow('Name ownership is permanent');
    await expect(
      f.accessPool.query("DELETE FROM access.name_registry WHERE scope = 'agent' AND key = $1", [renamed.key]),
    ).rejects.toThrow('Name ownership is permanent');
    await expect(
      f.accessPool.query('DELETE FROM access.name_history WHERE revision = $1', [renamed.revision]),
    ).rejects.toThrow('Name history is immutable');
    await f.nativeFuseki
      .update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(f.actor)} rv:profileDisclosure rv:Public } };
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(f.actor)} rv:profileDisclosure rv:Private } }`);
    for (const key of [renamed.key, uuidToSid(f.actor.slice(-36)), f.actor.slice(-36)])
      expect((await f.lookup('agent', key)).status).toBe(404);
    const currentPath = `/v1/addresses/current?${new URLSearchParams({ scope:'agent',holder:f.actor,actingSubject:f.actor })}`;
    expect((await f.publicCall(currentPath)).status).toBe(401);
    expect(await f.json(await f.call('GET',currentPath),200)).toMatchObject({ holder:f.actor,key:renamed.key,revision:renamed.revision });
  } finally {
    await f.close();
  }
}, 30_000);
