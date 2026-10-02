import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { automaticFollow } from '../../../services/main/src/modules/follows/store.ts';
import { controlTransaction } from '../../../services/main/src/modules/access/topology-control.ts';
import {
  configureLibraryFollows,
  projectLibraryFollow,
  recoverLibraryFollows,
} from '../../../services/main/src/modules/library/follows.ts';
import {
  relationshipEligible,
  relationshipRecipients,
} from '../../../services/main/src/modules/follows/recipients.ts';
import { WatchStore } from '../../../services/main/src/modules/notification/watch.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import {
  configureFollowGraph,
  recoverSpaceFollows,
} from '../../../services/main/src/modules/follows/recovery.ts';
import {
  resourceNotification,
  resourceNotificationSubjectReader,
} from '../../../services/main/src/modules/notification-producers/resources.ts';
import { joinedSpaces } from '../../../services/main/src/modules/follows/memberships.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { notificationRecipientAllowed } from '../../../services/main/src/modules/notification/recipient-policy.ts';
import {
  createRealmSpace,
  spaceCreationDigest,
} from '../../../services/main/src/modules/space/create.ts';

interface Entry {
  id: string;
  kind: string;
  revision: string;
  available: boolean;
  level: string;
  source: string;
  pinPosition: number | null;
  name: { value: string };
}
interface Page {
  items: Entry[];
  nextCursor: string | null;
  complete: boolean;
}
interface Receipt {
  target: string;
  kind: string;
  following: boolean;
  revision: string;
  level: string;
  source: string;
  pinPosition: number | null;
  replayed: boolean;
}

test('G-938 follows traverse twenty-item pages, atomic management preserves sources, and delivery rechecks levels', async () => {
  const home = await startHomeStack('g-938-relationships');
  try {
    const { stack, call, json } = home;
    const author = await home.provision('Relationship author', home.author.token);
    const reader = await home.provision('Relationship reader', home.reader.token);
    const principal = { ...home.reader.principal, emailVerified: true };
    const works = [];
    for (let n = 0; n < 22; n++)
      works.push(await stack.publicWork(author, ['en'], `Relationship Work ${n}`));
    const follow = (
      target: string,
      following: boolean,
      expectedRevision: string | null,
      key = randomUUID(),
      extra = {},
    ) =>
      call(
        'POST',
        '/v1/follows',
        {
          profile: 'follow-command-v1',
          target,
          actingSubject: reader,
          following,
          expectedRevision,
          ...extra,
        },
        home.reader.token,
        key,
      );
    const list = (extra = '') =>
      call(
        'GET',
        `/v1/me/follows?actingSubject=${encodeURIComponent(reader)}${extra}`,
        undefined,
        home.reader.token,
      );
    for (const chunk of [works.slice(0, 20), works.slice(20)])
      await json(
        await call(
          'POST',
          '/v1/me/follows/batch',
          {
            profile: 'follow-batch-v1',
            actingSubject: reader,
            targets: chunk.map((work) => ({ target: work.work })),
          },
          home.reader.token,
        ),
      );
    const first = await json<Page>(await list('&order=pinned'));
    expect(first.items).toHaveLength(20);
    expect(first.complete).toBe(false);
    const recent = await json<Page>(await list('&order=recent&limit=1'));
    await stack.publicWork(author,['en'],'Feed activity between follow pages');
    await home.project();
    const resumed = await json<Page>(await list(`&order=recent&limit=1&cursor=${encodeURIComponent(recent.nextCursor!)}`));
    expect(resumed.items).toHaveLength(1);
    const second = await json<Page>(
      await list(`&order=pinned&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );
    expect(second.items).toHaveLength(2);
    expect(second.complete).toBe(true);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(22);
    expect(first.items.every((item) => item.level === 'all' && item.source === 'explicit')).toBe(
      true,
    );
    const one = first.items[0]!,
      two = first.items[1]!;
    // One stale member rejects every mutation in a batch.
    const failed = await call(
      'POST',
      '/v1/me/follows/batch',
      {
        profile: 'follow-batch-v1',
        actingSubject: reader,
        targets: [
          { target: one.id, level: 'off', expectedRevision: one.revision },
          { target: two.id, following: false, expectedRevision: randomUUID() },
        ],
      },
      home.reader.token,
    );
    expect(failed.status).toBe(409);
    expect((await home.deps.follows.state(one.id, { principal, agent: reader })).level).toBe('all');
    const key = randomUUID();
    const changed = await json<{ items: Array<Receipt>; replayed: boolean }>(
      await call(
        'POST',
        '/v1/me/follows/batch',
        {
          profile: 'follow-batch-v1',
          actingSubject: reader,
          targets: [
            { target: one.id, level: 'off', pinPosition: 0, expectedRevision: one.revision },
          ],
        },
        home.reader.token,
        key,
      ),
    );
    expect(changed.items[0]).toMatchObject({ level: 'off', source: 'explicit', pinPosition: 0 });
    expect(
      (
        await call(
          'GET',
          `/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&order=pinned&cursor=${encodeURIComponent(first.nextCursor!)}`,
          undefined,
          home.reader.token,
        )
      ).status,
    ).toBe(409);
    expect((await json<Page>(await list('&order=pinned'))).items[0]?.id).toBe(one.id);
    expect(
      (await json(
        await call(
          'POST',
          '/v1/me/follows/batch',
          {
            profile: 'follow-batch-v1',
            actingSubject: reader,
            targets: [
              { target: one.id, level: 'off', pinPosition: 0, expectedRevision: one.revision },
            ],
          },
          home.reader.token,
          key,
        ),
      )) as { replayed: boolean },
    ).toMatchObject({ replayed: true });
    const search = await json<Page>(await list('&q=Relationship%20Work%201&order=pinned'));
    expect(search.items).toHaveLength(11);
    expect(search.complete).toBe(true);
    expect((await json<Page>(await list('&q=Relationship%20Work%2021&limit=1'))).items).toHaveLength(1);
    expect(search.items.every((item) => item.name.value.includes('Relationship Work 1'))).toBe(
      true,
    );
    expect(
      await relationshipEligible(stack.accessPool, home.reader.principalId, {
        targets: [one.id],
        highlights: true,
      }),
    ).toBe(false);
    expect(
      await relationshipEligible(stack.accessPool, home.reader.principalId, {
        targets: [two.id],
        highlights: false,
      }),
    ).toBe(true);
    await stack.accessPool.query(
      `INSERT INTO access.person_preferences(agent_id,content_languages,version) VALUES($1,ARRAY['ja'],1)
      ON CONFLICT(agent_id) DO UPDATE SET content_languages=EXCLUDED.content_languages,version=access.person_preferences.version+1`,
      [reader],
    );
    expect(
      await relationshipEligible(stack.accessPool, home.reader.principalId, {
        targets: [two.id],
        highlights: false,
        languages: ['en'],
      }),
    ).toBe(false);
    expect(
      await relationshipEligible(stack.accessPool, home.reader.principalId, {
        targets: [two.id],
        highlights: false,
        languages: ['ja-JP'],
      }),
    ).toBe(true);
    await stack.accessPool.query(
      'UPDATE access.person_preferences SET content_languages=ARRAY[]::text[],version=version+1 WHERE agent_id=$1',
      [reader],
    );
    const watch = new WatchStore(stack.accessPool);
    const watched = await watch.set(
      principal,
      {
        target: one.id,
        kind: 'thread',
        level: 'all',
        actingSubject: reader,
        expectedRevision: null,
      },
      randomUUID(),
      async () => {},
    );
    expect(
      await relationshipEligible(stack.accessPool, home.reader.principalId, {
        targets: [one.id],
        highlights: false,
        watches: [one.id],
      }),
    ).toBe(true);
    await watch.set(
      principal,
      {
        target: one.id,
        kind: 'thread',
        level: 'ignore',
        actingSubject: reader,
        expectedRevision: watched.revision,
      },
      randomUUID(),
      async () => {},
    );
    expect(
      await relationshipRecipients(stack.accessPool, {
        targets: [one.id],
        highlights: true,
        watches: [one.id],
      }),
    ).toEqual([]);
    expect(
      await relationshipRecipients(stack.accessPool, {
        targets: [one.id],
        highlights: true,
        watches: [one.id],
        direct: [home.reader.principalId],
      }),
    ).toEqual([home.reader.principalId]);
    expect(await relationshipRecipients(stack.accessPool,{ targets: [],highlights: true,
      watches: [one.id],relationships: [home.reader.principalId] })).toEqual([]);
    expect(await resourceNotification(stack.accessPool,stack.fuseki,{ id: randomUUID(),
      type: 'com.rezics.work.created.v1',data: { receipt: { work: works[0]!.work } } })).toBeNull();
    const authorFollow = await json<Receipt>(await follow(author, true, null));
    const news = await resourceNotification(stack.accessPool, stack.fuseki, {
      id: randomUUID(),
      type: 'com.rezics.work.created.v1',
      data: { receipt: { work: works[0]!.work } },
    });
    expect(news?.recipients).toContain(home.reader.principalId);
    const newsReader = resourceNotificationSubjectReader(stack.accessPool, stack.env);
    expect(
      await newsReader.resolve({
        principalId: home.reader.principalId,
        owner: 'graph',
        ref: works[0]!.work,
        revision: null,
        disclosureBasis: 'relationship-resource-v1',
        topic: 'new-work',
      }),
    ).toMatchObject({ status: 'available' });
    await stack.accessPool.query(
      'INSERT INTO access.person_block(principal_id,target_agent) VALUES($1,$2)',
      [home.reader.principalId, author],
    );
    expect(
      await notificationRecipientAllowed(stack.accessPool, home.reader.principalId, author),
    ).toBe(false);
    expect(
      await newsReader.resolve({
        principalId: home.reader.principalId,
        owner: 'graph',
        ref: works[0]!.work,
        revision: null,
        disclosureBasis: 'relationship-resource-v1',
        topic: 'new-work',
      }),
    ).toMatchObject({ status: 'undisclosed' });
    await stack.accessPool.query(
      'DELETE FROM access.person_block WHERE principal_id=$1 AND target_agent=$2',
      [home.reader.principalId, author],
    );
    await json(await follow(author, false, authorFollow.revision));
    // Library writes and recovery use durable Content versions. Explicit follows survive removal.
    configureLibraryFollows(stack.contentPool, stack.accessPool);
    const automatic = await stack.publicWork(author, ['en'], 'Automatic library follow');
    const write = (status: 'reading' | 'want-to-read' | null, expectedVersion: number) =>
      home.deps.libraryStatus.write({
        agent: reader,
        work: automatic.work,
        status,
        expectedVersion,
        idempotencyKey: randomUUID(),
      });
    await write('reading', 0);
    const automaticState = await home.deps.follows.state(automatic.work, {
      principal,
      agent: reader,
    });
    expect(automaticState).toMatchObject({ following: true, source: 'library', level: 'all' });
    await write(null, 1);
    expect(
      await home.deps.follows.state(automatic.work, { principal, agent: reader }),
    ).toMatchObject({ following: false, source: 'library' });
    await write('want-to-read', 2);
    const readded = await home.deps.follows.state(automatic.work, { principal, agent: reader });
    await json(await follow(automatic.work, true, readded.revision));
    await write(null, 3);
    expect(
      await home.deps.follows.state(automatic.work, { principal, agent: reader }),
    ).toMatchObject({ following: true, source: 'explicit' });
    await projectLibraryFollow(stack.contentPool, stack.accessPool, reader, automatic.work);
    await recoverLibraryFollows(stack.contentPool, stack.accessPool);
    // Automatic Join/Leave use the same transaction primitive and preserve explicit intent.
    await controlTransaction(stack.accessPool, async (client) =>
      automaticFollow(client, home.reader.principalId, reader, two.id, 'work', 'join', false),
    );
    expect((await home.deps.follows.state(two.id, { principal, agent: reader })).following).toBe(
      true,
    );
    const concurrency = await Promise.all([
      follow(two.id, false, two.revision),
      follow(two.id, false, two.revision),
    ]);
    expect(concurrency.map((response) => response.status).sort()).toEqual([200, 409]);
    const inventory = (
      await stack.accessPool.query<{ count: number; actual: number }>(
        `SELECT i.active_count AS count,
      (SELECT count(*)::integer FROM access.follow f WHERE f.principal_id=i.principal_id AND f.following) AS actual
      FROM access.follow_inventory i WHERE i.principal_id=$1`,
        [home.reader.principalId],
      )
    ).rows[0]!;
    expect(inventory.count).toBe(inventory.actual);
    expect(inventory.count).toBe(22);
    const savedView = await home.deps.savedFilters.create(
      principal,
      {
        profile: 'saved-filter-create-v1',
        actingSubject: reader,
        context: 'global',
        name: 'English works',
        filter: { all: [{ facet: 'language', any: ['en'] }] },
        pinned: false,
      },
      randomUUID(),
    );
    const savedTarget = `urn:rezics:saved-view:${savedView.id}`;
    const savedFollow = await json<Receipt>(await follow(savedTarget, true, null));
    expect(savedFollow).toMatchObject({ kind: 'saved-view', level: 'off' });
    expect((await json<Page>(await list('&kind=saved-view'))).items).toMatchObject([
      { id: savedTarget, name: { value: 'English works' } },
    ]);
    const collection = `https://rezics.com/id/${randomUUID()}`;
    await json(
      await call(
        'POST',
        '/v1/collections',
        { collection, name: 'Followed Collection', disclosure: 'public', actingSubject: author },
        home.author.token,
      ),
      201,
    );
    const collectionFollow = await json<Receipt>(await follow(collection, true, null));
    expect(collectionFollow.kind).toBe('collection');
    expect((await json<Page>(await list('&kind=collection'))).items).toMatchObject([
      { id: collection, available: true },
    ]);
    // Fan-out larger than one intake page persists its ACK and resumes at the
    // next principal, rather than dropping recipients or restarting forever.
    const audience = Array.from({ length: 260 }, () => randomUUID());
    await stack.accessPool.query(
      `INSERT INTO access.principal(id,account_issuer,account_subject)
      SELECT id,'g-938-fanout',id::text FROM unnest($1::uuid[]) id`,
      [audience],
    );
    await stack.accessPool.query(
      `INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level)
      SELECT id,$2,'work',$3,true,gen_random_uuid(),'all' FROM unnest($1::uuid[]) id`,
      [audience, automatic.work, reader],
    );
    const notifications = new NotificationStore(stack.accessPool);
    const event = {
      sourceOwner: 'graph' as const,
      sourceEvent: randomUUID(),
      purpose: 'subscription' as const,
      topic: 'new-work',
      subject: { owner: 'graph' as const, ref: automatic.work, revision: null },
      disclosureBasis: 'relationship-resource-v1',
      recipients: [audience[0]!],
      relationshipPlan: { targets: [automatic.work], highlights: true },
    };
    const firstIntake = await notifications.enqueue(event);
    expect(firstIntake).toHaveLength(256);
    expect(firstIntake.complete).toBe(false);
    const recoveredIntake = await new NotificationStore(stack.accessPool).enqueue(event);
    expect(recoveredIntake.complete).toBe(true);
    expect(recoveredIntake).toHaveLength(5); // the native reader also follows it
    expect(new Set([...firstIntake, ...recoveredIntake].map((item) => item.principalId)).size).toBe(
      261,
    );
    expect(await notifications.enqueue(event)).toEqual([]);
  } finally {
    await home.stop();
  }
}, 300_000);

test('G-938 server Join and Leave commit membership and the sourced Space follow together', async () => {
  const home = await startHomeStack('g-938-join');
  try {
    const { stack, call, json } = home;
    const owner = await home.provision('Space owner', home.author.token);
    const reader = await home.provision('Joining reader', home.reader.token);
    const ownerPrincipal = { ...home.author.principal, emailVerified: true };
    const principal = { ...home.reader.principal, emailVerified: true };
    const space = await json<{ realm: string; space: string }>(
      await call(
        'POST',
        '/v1/spaces',
        {
          profile: 'space-realm-v1',
          name: 'Joined Space',
          capabilities: ['realm'],
          actingSubject: owner,
        },
        home.author.token,
      ),
      201,
    );
    const admin = new AccessRealmManagement(stack.accessPool),
      joining = new AccessRealmJoining(stack.accessPool, stack.env);
    configureFollowGraph(stack.accessPool, stack.fuseki);
    await admin.initialize(ownerPrincipal, space.realm, owner, stack.env);
    const current = await admin.settings(ownerPrincipal, space.realm, owner, stack.env);
    await admin.changeSettings(
      ownerPrincipal,
      space.realm,
      {
        actingSubject: owner,
        expectedGeneration: current.generation,
        expectedRulesRevision: current.ruleBasis.revision,
        reason: 'Open community membership',
        settings: { ...current.settings, selfJoin: true },
      },
      randomUUID(),
      stack.env,
    );
    Object.assign(home.deps, { realmJoining: joining });
    const policy = await joining.policyFor(principal, space.realm, reader);
    const command = {
      actingSubject: reader,
      expectedMembershipGeneration: policy.membershipGeneration,
      expectedPolicyRevision: policy.policyRevision,
      termsRevision: policy.termsRevision,
      listed: false,
    };
    const joinPath = `/v1/realms/${space.realm.slice(-36)}/join`,
      key = randomUUID();
    const joined = await json<{ membershipGeneration: string; replayed: boolean }>(
      await call('POST', joinPath, command, home.reader.token, key),
    );
    expect(await home.deps.follows.state(space.space, { principal, agent: reader })).toMatchObject({
      following: true,
      source: 'join',
      level: 'highlights',
    });
    expect(await json(await call('POST', joinPath, command, home.reader.token, key))).toMatchObject(
      { ...joined, replayed: true },
    );
    expect((await call('POST', joinPath, command, home.reader.token)).status).toBe(409);
    expect(
      (await joinedSpaces(stack.accessPool, principal, reader, null, 'pinned', 20)).rows,
    ).toHaveLength(1);
    const memberships = await json<{
      items: Array<{ realm: string; space: string; following: boolean; source: string }>;
      complete: boolean;
    }>(
      await call(
        'GET',
        `/v1/me/memberships?actingSubject=${encodeURIComponent(reader)}&q=Joined&order=pinned`,
        undefined,
        home.reader.token,
      ),
    );
    expect(memberships).toMatchObject({
      items: [{ realm: space.realm, space: space.space, following: true, source: 'join' }],
      complete: true,
    });
    const leave = async (generation: string) => {
      const current = await admin.settings(ownerPrincipal,space.realm,owner,stack.env);
      return admin.changeMember(ownerPrincipal,space.realm,{ actingSubject: owner,member: reader,
        action: 'remove',expectedGeneration: current.generation,expectedMembershipGeneration: generation,
        reason: 'Member left',consent: null,durationSeconds: null },randomUUID());
    };
    await leave(joined.membershipGeneration);
    expect(await home.deps.follows.state(space.space, { principal, agent: reader })).toMatchObject({
      following: false,
      source: 'join',
    });
    const policyAgain = await joining.policyFor(principal, space.realm, reader);
    const second = await json<{ membershipGeneration: string }>(
      await call(
        'POST',
        joinPath,
        { ...command, expectedMembershipGeneration: policyAgain.membershipGeneration },
        home.reader.token,
      ),
    );
    const state = await home.deps.follows.state(space.space, { principal, agent: reader });
    await json(
      await call(
        'POST',
        '/v1/follows',
        {
          profile: 'follow-command-v1',
          target: space.space,
          following: true,
          expectedRevision: state.revision,
          actingSubject: reader,
        },
        home.reader.token,
      ),
    );
    const explicit = await home.deps.follows.state(space.space,{ principal,agent: reader });
    await json(await call('POST','/v1/follows',{ profile: 'follow-command-v1',target: space.space,
      following: true,expectedRevision: explicit.revision,actingSubject: reader,level: 'all' },home.reader.token));
    await leave(second.membershipGeneration);
    expect(await home.deps.follows.state(space.space, { principal, agent: reader })).toMatchObject({
      following: true,
      source: 'explicit',
      level: 'all',
    });
    expect(
      (
        await json<{ items: unknown[] }>(
          await call(
            'GET',
            `/v1/me/memberships?actingSubject=${encodeURIComponent(reader)}`,
            undefined,
            home.reader.token,
          ),
        )
      ).items,
    ).toEqual([]);
    await stack.accessPool.query(
      `INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision)
      VALUES($1,$2,'realm',$3,true,gen_random_uuid())`,
      [home.reader.principalId, space.realm, reader],
    );
    await recoverSpaceFollows(stack.accessPool, stack.fuseki);
    // A prior fixture may leave the cycling cursor past this principal.
    await recoverSpaceFollows(stack.accessPool, stack.fuseki);
    expect(
      (
        await stack.accessPool.query(
          'SELECT 1 FROM access.follow WHERE principal_id=$1 AND target=$2',
          [home.reader.principalId, space.realm],
        )
      ).rowCount,
    ).toBe(0);
    expect(await home.deps.follows.state(space.space, { principal, agent: reader })).toMatchObject({
      following: true,
      source: 'explicit',
    });
    // The shared fixture admission builds valid targets, as publicWork above
    // does. The claimed Follow API still performs every real authority check.
    const spaces = [space];
    for (let n = 1; n < 20; n++) {
      const input = {
        name: `Paged Space ${n}`,
        capabilities: ['realm'] as ['realm'],
        actingSubject: owner,
      };
      const created = await createRealmSpace(
        stack.env,
        stack.admission(owner, 'space:create:root', 'space.create', spaceCreationDigest(input)),
        input,
      );
      expect(created.outcome).toBe('succeeded');
      spaces.push({ realm: created.realm!, space: created.space! });
    }
    await json(
      await call(
        'POST',
        '/v1/me/follows/batch',
        {
          profile: 'follow-batch-v1',
          actingSubject: reader,
          targets: spaces.map((item) => ({ target: item.space })),
        },
        home.reader.token,
      ),
    );
    const spacePage = await json<Page>(
      await call(
        'GET',
        `/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=space&include=newSince`,
        undefined,
        home.reader.token,
      ),
    );
    expect(spacePage.items).toHaveLength(20);
    expect(spacePage.complete).toBe(true);
    expect(spacePage.items.every((item) => item.available && item.kind === 'space')).toBe(true);
    const people = [];
    for (let n = 0; n < 20; n++)
      people.push(
        (
          await json<{ agent: string }>(
            await call(
              'POST',
              '/v1/agents',
              {
                profile: 'agent-provision-v1',
                kind: 'organization',
                displayName: `Paged organization ${n}`,
              },
              home.author.token,
            ),
            201,
          )
        ).agent,
      );
    await json(
      await call(
        'POST',
        '/v1/me/follows/batch',
        {
          profile: 'follow-batch-v1',
          actingSubject: reader,
          targets: people.map((target) => ({ target })),
        },
        home.reader.token,
      ),
    );
    const peoplePage = await json<Page>(
      await call(
        'GET',
        `/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=agent`,
        undefined,
        home.reader.token,
      ),
    );
    expect(peoplePage.items).toHaveLength(20);
    expect(peoplePage.complete).toBe(true);
  } finally {
    await home.stop();
  }
}, 180_000);
