import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Account, Method } from '../../../../specs/community-driver.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { readSelectedQuestionDirectory } from '../../src/rating/question-directory.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
} from '../community/community-driver.ts';

function afterSecondPreparation(access: Access, action: string, work: () => Promise<void>): Access {
  const prepare = access.prepare;
  if (!prepare) throw new Error('The native Access fixture has no preparation hook');
  let matching = 0;
  return new Proxy(access, {
    get(target, property, receiver) {
      if (property === 'prepare')
        return async (...args: Parameters<NonNullable<Access['prepare']>>) => {
          const evidence = await prepare.apply(target, args);
          if (args[1] === action && ++matching === 2) await work();
          return evidence;
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('selected question pages requalify the caller and lifecycle after native source reads', async () => {
  const driver = await createCommunityDriver();
  try {
    const fixture = await driver.provision();
    const { system } = communityFixtureRuntime();
    const call = (method: Method, path: string, actor: Account | null, body?: unknown, key = randomUUID()) =>
      driver.request({ method, path, actor, body, key: JSON.stringify(key) });
    const json = async (response: Response, status = 200): Promise<any> => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    };
    const deadline = () => Date.now() + 30_000;
    const actor = (account: Account) =>
      system.access.authenticate(account.bearer, { pool: system.database.pool, deadline: deadline() });
    const page = (
      access: Access,
      caller: Actor,
      realmId?: string,
      after: string | null = null,
      generation?: string,
    ) =>
      readSelectedQuestionDirectory(
        { pool: system.database.pool, access },
        caller,
        { after, limit: 20, ...(realmId === undefined ? {} : { realmId }), ...(generation === undefined ? {} : { lifecycleGeneration: generation }) },
        deadline(),
      );

    const space = (await json(await call('POST', '/v1/spaces', fixture.owner, { title: 'Directory observations' }), 201))
      .space as { spaceId: string };
    const realm = (
      await json(
        await call('POST', '/v1/realms', fixture.owner, {
          spaceId: space.spaceId,
          title: 'Protected questions',
          visibility: 'protected',
          contextId: fixture.contextId,
        }),
        201,
      )
    ).realm as { realmId: string };
    const realmId = realm.realmId;
    const memberPath = `/v1/realms/${realmId}/members`;
    await json(await call('POST', memberPath, fixture.owner, { accountId: fixture.member.id }), 202);
    await driver.settle();
    const realmResource = { route: routeOf(realmId), id: realmId };
    await json(
      await call('POST', '/v1/grants', fixture.owner, {
        resource: realmResource,
        subject: { kind: 'account', id: fixture.member.id },
        actions: ['realm:manage'],
        valid: '(,)',
      }),
      201,
    );

    const definition = {
      meaning: 'Assess this work using its stated scale.',
      label: 'Canonical question wording',
      grain: 'work',
      scale: { min: 0, max: 10, displayStep: 1 },
    };
    const question = (await json(
      await call('POST', `/v1/realms/${realmId}/rating-questions`, fixture.member, definition),
      201,
    )) as { id: string };
    const member = await actor(fixture.member);
    const beforeLabel = await page(system.access, member, realmId);
    expect(beforeLabel.ratingQuestions[0]).toMatchObject({
      id: question.id,
      revision: 1,
      label: definition.label,
      canonicalLabel: definition.label,
      labelRevision: 1,
      grain: 'work',
      scale: definition.scale,
    });

    await json(
      await call('PUT', `/v1/rating-questions/${question.id}/label`, fixture.member, {
        expectedLabelRevision: 1,
        label: 'Corrected display caption',
      }),
    );
    const corrected = await page(system.access, member, realmId, undefined, beforeLabel.lifecycleGeneration);
    expect(corrected.lifecycleGeneration).toBe(beforeLabel.lifecycleGeneration);
    expect(corrected.ratingQuestions[0]).toMatchObject({
      revision: 1,
      label: 'Corrected display caption',
      canonicalLabel: definition.label,
      labelRevision: 2,
      grain: 'work',
      scale: definition.scale,
    });

    const readGrant = {
      resource: realmResource,
      subject: { kind: 'account', id: fixture.outsider.id },
      actions: ['realm:read'],
      valid: '(,)',
    };
    await json(await call('POST', '/v1/grants', fixture.owner, readGrant), 201);
    const outsider = await actor(fixture.outsider);
    expect((await page(system.access, outsider, realmId)).ratingQuestions[0]?.id).toBe(question.id);
    const revokedAccess = afterSecondPreparation(system.access, 'realm:read', async () => {
      await json(await call('POST', '/v1/grants:revoke', fixture.owner, readGrant));
    });
    await expect(page(revokedAccess, outsider, realmId)).rejects.toMatchObject({ code: 'not_found' });

    const retirementAccess = afterSecondPreparation(system.access, 'realm:read', async () => {
      await json(
        await call('POST', `/v1/rating-questions/${question.id}:retire`, fixture.member, { expectedRevision: 1 }),
      );
    });
    await expect(page(retirementAccess, member, realmId)).rejects.toMatchObject({ code: 'invalid_cursor' });
    const historical = await json(await call('GET', `/v1/rating-questions/${question.id}`, fixture.member));
    expect(historical).toMatchObject({
      revision: 1,
      label: 'Corrected display caption',
      canonicalLabel: definition.label,
      lifecycle: { state: 'retired', revision: 2 },
    });
    expect((await page(system.access, member, realmId)).ratingQuestions).toEqual([]);

    const globalCaller = await actor(fixture.member);
    const globalAccess = afterSecondPreparation(system.access, 'definitions:read', async () => {
      await system.database.pool.query(
        `UPDATE access.account SET state = 'suspended' WHERE account_id = $1`,
        [fixture.member.id],
      );
    });
    await expect(
      page(globalAccess, globalCaller, undefined, 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
    ).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 600_000);
