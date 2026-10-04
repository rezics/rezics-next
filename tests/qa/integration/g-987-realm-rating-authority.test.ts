import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { realmPermissions } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { ratingContextDigest } from '../../../services/main/src/modules/rating/context.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const short = (value: string) => value.slice(-36);
interface Context {
  context: string;
  contextRevision: string;
  policyRevision?: string;
}
interface Opinion {
  observation: string;
  observationRevision: string;
}
interface Page {
  items: { id: string; ratingCount: number }[];
  nextCursor: string | null;
}

test('G-987: public Realm roles configure 21 rating populations and preserve denied, stale, concurrent and recovery outcomes', async () => {
  const s = await startMediaStack('g-987');
  try {
    const owner = await s.member('owner'),
      manager = await s.member('manager'),
      outsider = await s.member('outsider');
    const members = [owner, manager, outsider];
    let verified = true;
    const app = createMainApp(s.fuseki, {
      environment: s.env,
      access: s.access,
      content: s.content,
      contentAuthoring: s.content,
      realmAdmin: new AccessRealmManagement(s.accessPool),
      agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      account: {
        verify: async (request, scopes) => {
          const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
          const person = members.find((member) => member.token === bearer);
          if (
            !person ||
            (request.headers.get('x-qa-no-configure') && scopes.includes('rating:configure'))
          ) {
            throw new AccountAssertionDenied('Bearer or OAuth scope is unavailable');
          }
          const principal = { ...person.principal, emailVerified: verified };
          return {
            ...principal,
            currentAssertion: async () => ({ ...principal, emailVerified: verified }),
          };
        },
      },
    });
    const call = (
      person: typeof owner,
      method: string,
      path: string,
      body?: object,
      key = randomUUID(),
      noConfigure = false,
    ) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            authorization: `Bearer ${person.token}`,
            'idempotency-key': key,
            ...(noConfigure ? { 'x-qa-no-configure': 'true' } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const json = async <T>(response: Response, status = 201): Promise<T> => {
      const body = await response.text();
      expect({ status: response.status, ...(response.status === status ? {} : { body }) }).toEqual({
        status,
      });
      return JSON.parse(body) as T;
    };
    const provision = async (person: typeof owner) =>
      (
        await json<{ agent: string }>(
          await call(person, 'POST', '/v1/agents', {
            profile: 'agent-provision-v1',
            kind: 'person',
            displayName: person.name,
          }),
        )
      ).agent;
    const ownerAgent = await provision(owner),
      managerAgent = await provision(manager),
      outsiderAgent = await provision(outsider);
    // G-983's setup identity is the configured platform administrator. Its
    // existing Space authority avoids the ordinary three-Space monthly quota;
    // rating configuration still requires public Realm owner enrollment.
    expect(
      (
        await new AccessPlatformAdministrators(s.accessPool).designateFirst(
          owner.principal.issuer,
          owner.principal.subject,
          () => {},
        )
      ).status,
    ).toBe('granted');
    const work = await json<{ work: string; mainVersion: string }>(
      await call(owner, 'POST', '/v1/works', {
        profile: 'metadata-only-v1',
        authoring: 'own-work',
        title: 'G-987 public rating target',
        language: 'en',
        actingSubject: ownerAgent,
      }),
    );
    const contribution = await json<{ contribution: string; draftRevision: string }>(
      await call(owner, 'POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: 'Public rating acceptance text.',
        actingSubject: ownerAgent,
      }),
    );
    const publication = await json<{ publicationDecision: string }>(
      await call(owner, 'POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: contribution.contribution,
        expectedDraftHead: contribution.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: ownerAgent,
      }),
    );
    await json(
      await call(owner, 'POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work,
        contribution: contribution.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer',
        actingSubject: ownerAgent,
      }),
    );

    const createRealm = async (name: string) => {
      const realm = (
        await json<{ realm: string }>(
          await call(owner, 'POST', '/v1/spaces', {
            profile: 'space-realm-v1',
            name,
            language: 'en',
            capabilities: ['realm'],
            actingSubject: ownerAgent,
          }),
        )
      ).realm;
      await json(
        await call(owner, 'POST', `/v1/realms/${short(realm)}/management`, {
          actingSubject: ownerAgent,
        }),
        200,
      );
      return realm;
    };
    const question = (realm: string, actingSubject = ownerAgent) => ({
      profile: 'realm-standing-rating-context-v1',
      realm,
      question: 'How much did you enjoy this Work?',
      actingSubject,
    });
    const observe = (
      context: string,
      actingSubject = ownerAgent,
      value: number | null = 8,
      expectedRevisionHead: string | null = null,
    ) => ({
      profile: 'realm-standing-rating-observation-v1',
      context,
      work: work.work,
      mainVersion: work.mainVersion,
      expectedRevisionHead,
      value,
      actingSubject,
    });
    const realm = await createRealm('G-987 first public Realm');
    expect(
      (await call(outsider, 'POST', '/v1/rating-contexts', question(realm, outsiderAgent))).status,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', '/v1/rating-contexts', question(realm), randomUUID(), true))
        .status,
    ).toBe(401);
    expect(
      (await call(owner, 'POST', '/v1/rating-contexts', question(realm, outsiderAgent))).status,
    ).toBe(403);
    expect(
      (
        await call(owner, 'POST', '/v1/global-rating-contexts', {
          profile: 'global-rating-standing-context-v1',
          question: 'Global quality',
          actingSubject: ownerAgent,
        })
      ).status,
    ).toBe(403);
    const contextKey = randomUUID();
    const context = await json<Context>(
      await call(owner, 'POST', '/v1/rating-contexts', question(realm), contextKey),
    );
    expect(
      await json(
        await call(owner, 'POST', '/v1/rating-contexts', question(realm), contextKey),
        200,
      ),
    ).toMatchObject({ ...context, replayed: true });
    expect(
      (
        await call(
          owner,
          'POST',
          '/v1/rating-contexts',
          { ...question(realm), question: 'Other question' },
          contextKey,
        )
      ).status,
    ).toBe(409);

    const opinionKey = randomUUID();
    verified = false;
    expect(
      (await call(owner, 'POST', '/v1/rating-observations', observe(context.context))).status,
    ).toBe(403);
    verified = true;
    const opinion = await json<Opinion>(
      await call(owner, 'POST', '/v1/rating-observations', observe(context.context), opinionKey),
    );
    expect(
      await json(
        await call(owner, 'POST', '/v1/rating-observations', observe(context.context), opinionKey),
        200,
      ),
    ).toMatchObject({ ...opinion, replayed: true });
    const race = await Promise.all(
      [6, 7].map((value) =>
        call(
          owner,
          'POST',
          '/v1/rating-observations',
          observe(context.context, ownerAgent, value, opinion.observationRevision),
        ),
      ),
    );
    expect(race.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = await json<Opinion>(race.find((response) => response.status === 201)!);
    const withdrawn = await json<Opinion>(
      await call(
        owner,
        'POST',
        '/v1/rating-observations',
        observe(context.context, ownerAgent, null, winner.observationRevision),
      ),
    );
    expect(
      await json(
        await call(owner, 'POST', '/v1/rating-aggregates', {
          profile: 'realm-standing-latest-mean-v1',
          context: context.context,
          work: work.work,
          mainVersion: work.mainVersion,
        }),
        200,
      ),
    ).toMatchObject({ count: 0, withdrawnCount: 1 });
    await json(
      await call(
        owner,
        'POST',
        '/v1/rating-observations',
        observe(context.context, ownerAgent, 8, withdrawn.observationRevision),
      ),
    );

    // Each population is stood up through the same public recipe as G-983:
    // create Space, enroll its owner, create Context, submit an observation.
    const realms = [realm];
    for (let index = 1; index < 21; index++) {
      const nextRealm = await createRealm(`G-987 population ${index}`);
      const next = await json<Context>(
        await call(owner, 'POST', '/v1/rating-contexts', question(nextRealm)),
      );
      await json(await call(owner, 'POST', '/v1/rating-observations', observe(next.context)));
      realms.push(nextRealm);
    }
    const populationPath = `/v1/rating-populations?target=${encodeURIComponent(work.work)}&limit=20`;
    const populations = (cursor?: string) =>
      app.handle(
        new Request(
          `http://main.local${populationPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
    const first = await json<Page>(await populations(), 200);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeString();
    const second = await json<Page>(await populations(first.nextCursor!), 200);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(realms),
    );
    expect([...first.items, ...second.items].every((item) => item.ratingCount === 1)).toBe(true);
    // A verified person can rate a public Realm's Main Version without being
    // its manager or acquiring a per-context observation grant.
    await json(
      await call(
        outsider,
        'POST',
        '/v1/rating-observations',
        observe(context.context, outsiderAgent),
      ),
    );

    // The ordinary role preview/change workflow can delegate configuration.
    const roleId = randomUUID();
    const changeRole = async (generation: string, change: object) => {
      const input = {
        actingSubject: ownerAgent,
        expectedGeneration: generation,
        reason: 'Delegate rating configuration',
        change,
      };
      const impact = await json<{ digest: string }>(
        await call(owner, 'POST', `/v1/realms/${short(realm)}/role-impact`, input),
        200,
      );
      return json<{ generation: string }>(
        await call(owner, 'POST', `/v1/realms/${short(realm)}/role-changes`, {
          ...input,
          impactDigest: impact.digest,
        }),
      );
    };
    const role = await changeRole('0', {
      kind: 'role',
      roleId,
      name: 'Rating manager',
      permissions: ['rating.configure'],
    });
    const assigned = await changeRole(role.generation, {
      kind: 'assignment',
      roleId,
      member: managerAgent,
      assigned: true,
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(
      (
        await call(owner, 'POST', `/v1/realms/${short(realm)}/role-impact`, {
          actingSubject: ownerAgent,
          expectedGeneration: '0',
          reason: 'Stale role edit',
          change: { kind: 'role', roleId, name: 'Rating manager', permissions: [] },
        })
      ).status,
    ).toBe(409);
    const experience = await json<Context>(
      await call(manager, 'POST', '/v1/rating-contexts', {
        ...question(realm, managerAgent),
        profile: 'realm-experience-rating-context-v1',
      }),
    );
    await json(
      await call(outsider, 'POST', '/v1/rating-observations', {
        ...observe(experience.context, outsiderAgent),
        profile: 'realm-experience-rating-observation-v1',
        occasion: randomUUID(),
      }),
    );
    const daily = await json<Context>(
      await call(manager, 'POST', '/v1/rating-contexts', {
        ...question(realm, managerAgent),
        profile: 'realm-daily-rating-context-v1',
        timeZone: 'UTC',
      }),
    );
    await json(
      await call(outsider, 'POST', '/v1/rating-observations', {
        ...observe(daily.context, outsiderAgent),
        profile: 'realm-daily-rating-observation-v1',
      }),
    );
    expect(
      (await call(manager, 'POST', '/v1/rating-contexts', question(realms[1]!, managerAgent)))
        .status,
    ).toBe(403);
    const policyPath = `/v1/rating-contexts/${short(experience.context)}/policy-revisions`;
    const policy = {
      profile: 'rating-aggregate-default-policy-v1',
      expectedPolicyHead: experience.policyRevision!,
      aggregationPolicy: 'mean-per-rater',
      actingSubject: managerAgent,
    };
    expect(
      (await call(outsider, 'POST', policyPath, { ...policy, actingSubject: outsiderAgent }))
        .status,
    ).toBe(403);
    const policyKey = randomUUID();
    const configured = await json<{ policyRevision: string }>(
      await call(manager, 'POST', policyPath, policy, policyKey),
    );
    expect(
      await json(await call(manager, 'POST', policyPath, policy, policyKey), 200),
    ).toMatchObject({ ...configured, replayed: true });
    expect((await call(manager, 'POST', policyPath, policy)).status).toBe(409);

    // A transport failure retains one admission; retry recovers its receipt.
    const command = s.fuseki.commandWithReceipt.bind(s.fuseki);
    const retryKey = randomUUID();
    s.fuseki.commandWithReceipt = async () => {
      throw new Error('Interrupted graph transport');
    };
    const interrupted = await call(
      manager,
      'POST',
      '/v1/rating-contexts',
      question(realm, managerAgent),
      retryKey,
    );
    expect(interrupted.status).toBe(202);
    s.fuseki.commandWithReceipt = command;
    await json(
      await call(manager, 'POST', '/v1/rating-contexts', question(realm, managerAgent), retryKey),
      200,
    );

    // Save an undispatched intent, revoke the bundle, and prove claim cannot
    // substitute owner authority or a new role grant for the selected proof.
    const pendingInput = { realm, question: 'Pending manager rating', actingSubject: managerAgent };
    const pending = await s.access.register({
      principal: { ...manager.principal, emailVerified: true },
      actingSubject: managerAgent,
      scope: `rating:context:${realm}`,
      action: 'rating.context.create',
      idempotencyKey: randomUUID(),
      requestDigest: ratingContextDigest(pendingInput),
    });
    await changeRole(assigned.generation, {
      kind: 'role',
      roleId,
      name: 'Rating manager',
      permissions: [],
    });
    await expect(s.access.claim(pending.id, pending.requestDigest)).rejects.toThrow(
      'Realm rating authority changed',
    );
    expect(
      (await call(manager, 'POST', '/v1/rating-contexts', question(realm, managerAgent))).status,
    ).toBe(403);
    expect(
      (
        await call(manager, 'POST', policyPath, {
          ...policy,
          expectedPolicyHead: configured.policyRevision,
        })
      ).status,
    ).toBe(403);
    expect(
      await json(await call(manager, 'POST', policyPath, policy, policyKey), 200),
    ).toMatchObject({ replayed: true });
    expect(
      (
        await s.accessPool.query(
          `SELECT count(*)::int AS n FROM access.permission_grant
      WHERE recipient_subject = $1 AND action IN ('rating.context.create','rating.observation.set','rating.context.policy.set')`,
          [ownerAgent],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await s.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(context.context)} a rv:RatingContext ; rv:realm ${iri(realm)} } }`)
      ).boolean,
    ).toBe(true);
  } finally {
    await s.stop();
  }
}, 180_000);

test('G-987: migration upgrades prior Realm owners, preserves every role permission and never resurrects revoked rating authority', async () => {
  // This fixture replays 1026, whose eight-permission vocabulary predates
  // independent question review. Later permissions belong to forward migrations.
  const migrationPermissions = realmPermissions.filter(
    (permission) => permission !== 'rating.question-presentation.review',
  );
  const s = await startMediaStack('g-987-upgrade');
  try {
    const owner = await s.member('prior-owner');
    await owner.grant('work:create:root', 'agent.control');
    await owner.grant('space:create:root', 'space.create');
    const realms: string[] = [];
    for (const name of ['Prior Realm owner', 'Revoked rating authority']) {
      const response = await owner.send('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name,
        capabilities: ['realm'],
        actingSubject: owner.actor,
      });
      expect(response.status).toBe(201);
      const { realm } = (await response.json()) as { realm: string };
      await new AccessRealmManagement(s.accessPool).initialize(
        owner.principal,
        realm,
        owner.actor,
        s.env,
      );
      realms.push(realm);
    }
    const client = await s.accessPool.connect();
    try {
      await client.query('BEGIN');
      // Reconstruct the pre-1026 owner state only inside this rolled-back
      // migration fixture. Public journey setup above never mutates authority.
      await client.query(
        `DELETE FROM access.permission_grant
        WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'rating.configure'`,
        [`governance:realm:${realms[0]}`, owner.actor],
      );
      await client.query(
        `UPDATE access.permission_grant SET active = false
        WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'rating.configure'`,
        [`governance:realm:${realms[1]}`, owner.actor],
      );
      await client.query('DROP TABLE access.realm_rating_admission');
      await client.query(
        readFileSync(
          new URL(
            '../../../services/main/migrations/access/1026_realm_rating_authority.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const grants = (
        await client.query<{ scope_id: string; active: boolean }>(
          `SELECT scope_id,active
        FROM access.permission_grant WHERE recipient_subject = $1 AND action = 'rating.configure'
          AND scope_id = ANY($2::text[]) ORDER BY scope_id`,
          [owner.actor, realms.map((realm) => `governance:realm:${realm}`)],
        )
      ).rows;
      expect(grants).toHaveLength(2);
      expect(
        grants.find((grant) => grant.scope_id === `governance:realm:${realms[0]}`)?.active,
      ).toBe(true);
      expect(
        grants.find((grant) => grant.scope_id === `governance:realm:${realms[1]}`)?.active,
      ).toBe(false);
      await client.query(
        `INSERT INTO access.realm_admin_role (realm,id,name,permissions)
        VALUES ($1,$2,'Every preserved permission',$3)`,
        [realms[0], randomUUID(), migrationPermissions],
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM access.realm_admin_role
        WHERE realm = $1 AND permissions @> $2::text[]`,
            [realms[0], migrationPermissions],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await s.stop();
  }
}, 60_000);
