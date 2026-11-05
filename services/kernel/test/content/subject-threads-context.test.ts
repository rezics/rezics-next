import { expect, test } from 'bun:test';
import { prepareSubjectThreadContext } from '../../src/content/subject-threads-context.ts';
import { routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

test('native Subject lists preserve readable Realm identity and withhold changed required observations', async () => {
  const world = await createReactionRelayBase();
  try {
    const pool = world.system.database.pool;
    const deps = { pool, access: world.system.access, tokens: world.system.tokenKeys };
    const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 };
    const realmId = world.mainTarget.realmId;
    const path = `/v1/subjects/${world.conceptId}/threads?place=${realmId}&kind=discussion`;
    const listed = await world.call('GET', path);
    expect(listed.response.status, listed.text).toBe(200);
    expect(listed.value?.context).toMatchObject({
      subject: { id: world.conceptId, label: { language: 'en', value: expect.stringContaining('concept') } },
      place: { kind: 'realm', id: realmId, title: expect.stringContaining('public') },
      kind: 'discussion',
    });
    const selected = await prepareSubjectThreadContext(deps, world.conceptId, realmId, 'discussion', context);
    const current = await world.call('GET', `/v1/realms/${realmId}`);
    await world.command(
      'PATCH',
      `/v1/realms/${realmId}`,
      { title: 'Changed current place' },
      { headers: { 'if-match': JSON.stringify(current.value?.realm.headRevisionId) }, expectedStatus: 200 },
    );
    await expect(selected.finish()).rejects.toMatchObject({ code: 'dependency_unavailable' });
    const retry = await world.call('GET', path);
    expect(retry.response.status, retry.text).toBe(200);
    expect(retry.value?.context.place.title).toBe('Changed current place');

    const protectedTarget = await world.createRealmTarget('Protected selected place', 'protected');
    const protectedPath = path.replace(realmId, protectedTarget.realmId);
    const denied = await world.call('GET', protectedPath);
    expect(denied.response.status, denied.text).toBe(404);
    expect(denied.value).not.toHaveProperty('threads');
    const owner = await world.call('GET', protectedPath, { bearer: world.author.bearer });
    expect(owner.response.status, owner.text).toBe(200);
    expect(owner.value?.context.place).toMatchObject({ kind: 'realm', id: protectedTarget.realmId });

    const beforeHide = await prepareSubjectThreadContext(deps, world.conceptId, realmId, 'review', context);
    await pool.query(
      "UPDATE semantic.subject SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(world.conceptId), world.conceptId],
    );
    await expect(beforeHide.finish()).rejects.toMatchObject({ name: 'ContentNotFoundError' });
    const hidden = await world.call('GET', path);
    expect(hidden.response.status, hidden.text).toBe(404);
    expect(hidden.value).not.toHaveProperty('context');
  } finally {
    await world.system.close();
  }
});
