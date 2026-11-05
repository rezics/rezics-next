import { afterAll, expect, test } from 'bun:test';
import type { Account, Method, Realm, Space, Subject } from '../../../../specs/community-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { closeCommunityDrivers, createCommunityDriver } from './community-driver.ts';

afterAll(closeCommunityDrivers);

test('a deleted Realm Context never falls back to Global and restoration retains its local decision', async () => {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  async function call(method: Method, path: string, actor: Account | null, body?: unknown) {
    return driver.request({
      method,
      path,
      actor,
      ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
      ...(body === undefined ? {} : { body }),
    });
  }
  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status).toBe(status);
    return response.json() as Promise<T>;
  }
  for (const visibility of ['public', 'protected'] as const) {
    const { space } = await json<{ space: Space }>(
      await call('POST', '/v1/spaces', fixture.owner, { title: 'Context lifecycle host' }),
      201,
    );
    const { realm } = await json<{ realm: Realm }>(
      await call('POST', '/v1/realms', fixture.owner, {
        spaceId: space.spaceId,
        title: 'Context lifecycle Realm',
        visibility,
        contextId: fixture.contextId,
      }),
      201,
    );
    await json(await driver.grantModerator(realm.realmId, fixture.moderator), 201);
    for (const actor of [fixture.member, fixture.moderator])
      await json(
        await call('POST', `/v1/realms/${realm.realmId}/members`, fixture.owner, { accountId: actor.id }),
        202,
      );
  }
  await driver.settle();
  const { id, candidateId, property } = fixture.subject;
  const subjectPath = (context: string) => `/v1/subjects/${id}?context=${context}`;
  const candidatePath = (context: string) => `/v1/subjects/${id}/candidates?property=${property}&context=${context}`;
  const { subject: global } = await json<{ subject: Subject }>(
    await call('GET', subjectPath(GLOBAL_CONTEXT), fixture.owner),
  );
  expect(global.statements[property]!.map(({ id }) => id)).toContain(candidateId);
  await json(
    await call('POST', `/v1/subjects/${id}/candidates/${candidateId}:reject`, fixture.owner, {
      context: fixture.contextId,
      expected_head: null,
    }),
  );
  const readers = [null, fixture.owner, fixture.member, fixture.moderator, fixture.outsider];
  async function local() {
    for (const actor of readers) {
      const { subject } = await json<{ subject: Subject }>(await call('GET', subjectPath(fixture.contextId), actor));
      expect(subject.context).toBe(fixture.contextId);
      expect(subject.statements[property] ?? []).toEqual([]);
    }
  }
  await local();
  await json(await call('DELETE', `/v1/contexts/${fixture.contextId}`, fixture.owner));
  const unknown = newId(routeOf(fixture.contextId)!);
  for (const actor of readers) {
    for (const path of [subjectPath, candidatePath]) {
      const problem = await json<Record<string, unknown>>(await call('GET', path(fixture.contextId), actor), 404);
      const missing = await json<Record<string, unknown>>(await call('GET', path(unknown), actor), 404);
      const { request_id: requestId, ...stable } = problem;
      const { request_id: missingId, ...stableMissing } = missing;
      expect(requestId).toEqual(expect.any(String));
      expect(missingId).toEqual(expect.any(String));
      expect(stable).toEqual(stableMissing);
      expect(stable.code).toBe('not_found');
    }
    const { subject } = await json<{ subject: Subject }>(await call('GET', subjectPath(GLOBAL_CONTEXT), actor));
    expect(subject.statements).toEqual(global.statements);
  }
  await json(await call('POST', `/v1/contexts/${fixture.contextId}:restore`, fixture.owner, {}));
  await local();
}, 180_000);
