import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { startHomeStack } from './feed-read-support.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { configureFollowGraph, recoverSpaceFollows } from '../../../services/main/src/modules/follows/recovery.ts';
import { followSpace, registerFollowSpace } from '../../../services/main/src/modules/follows/targets.ts';
import { publicTargetRead } from '../../../services/main/src/modules/target/resolve.ts';
import { relationshipEligible, relationshipRecipients } from '../../../services/main/src/modules/follows/recipients.ts';
import { recoverLibraryFollows, configureLibraryFollows } from '../../../services/main/src/modules/library/follows.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { WatchStore } from '../../../services/main/src/modules/notification/watch.ts';
import { RealmJoinRequests } from '../../../services/main/src/modules/realm-admin/join-requests.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

type Page = { items: Array<{ id: string; available: boolean; name: { value: string } | null; source: string }>;
  nextCursor: string | null; complete: boolean };
test('G-938 Join races an explicit follow, private members keep notifications, and legacy collisions preserve Space settings', async () => {
  const home = await startHomeStack('g-938-review-races', { projectionStart: 'current' });
  try {
    const { stack,call,json } = home;
    const owner = await home.provision('Review Space owner',home.author.token);
    const reader = await home.provision('Review joining reader',home.reader.token);
    const principal = { ...home.reader.principal,emailVerified: true };
    const ownerPrincipal = { ...home.author.principal,emailVerified: true };
    configureFollowGraph(stack.accessPool,stack.fuseki);
    const space = await json<{ space: string; realm: string }>(await call('POST','/v1/spaces',{
      profile: 'space-realm-v1',name: 'Private review Space',capabilities: ['realm'],actingSubject: owner },home.author.token),201);
    const admin = new AccessRealmManagement(stack.accessPool);
    const joining = new AccessRealmJoining(stack.accessPool,stack.env);
    await admin.initialize(ownerPrincipal,space.realm,owner,stack.env);
    const settings = await admin.settings(ownerPrincipal,space.realm,owner,stack.env);
    await admin.changeSettings(ownerPrincipal,space.realm,{ actingSubject: owner,expectedGeneration: settings.generation,
      expectedRulesRevision: settings.ruleBasis.revision,reason: 'Allow joining',settings: { ...settings.settings,selfJoin: true } },randomUUID(),stack.env);
    const policy = await joining.policyFor(principal,space.realm,reader);
    const input = { actingSubject: reader,expectedMembershipGeneration: policy.membershipGeneration,
      expectedPolicyRevision: policy.policyRevision,termsRevision: policy.termsRevision,listed: false };
    const follow = (target: string, revision: string | null, extra = {}) => call('POST','/v1/follows',{
      profile: 'follow-command-v1',target,following: true,expectedRevision: revision,actingSubject: reader,...extra },home.reader.token);
    const [joined,explicit] = await Promise.all([
      joining.selfJoin(principal,space.realm,input,randomUUID()),follow(space.space,null),
    ]);
    expect(joined.membershipGeneration).toBe('1');
    expect([200,409]).toContain(explicit.status);
    let state = await home.deps.follows.state(space.space,{ principal,agent: reader });
    expect(state.following).toBe(true);
    if (state.source!=='explicit') await json(await follow(space.space,state.revision));
    state = await home.deps.follows.state(space.space,{ principal,agent: reader });
    expect(state).toMatchObject({ following: true,source: 'explicit' });
    // Source is intent: a level-only single command does not turn Join into explicit.
    await stack.accessPool.query("UPDATE access.follow SET source='join' WHERE principal_id=$1 AND target=$2",[home.reader.principalId,space.space]);
    const changed = await json<{ revision: string; source: string }>(await follow(space.space,state.revision,{ level: 'all',pinPosition: 2 }));
    expect(changed.source).toBe('join');
    const identity = await publicTargetRead(stack.fuseki,session => followSpace(session,space.realm));
    await stack.accessPool.query(`INSERT INTO access.follow_space_alias(alias,space,realm) VALUES($1,$2,$3)`,
      [`https://rezics.com/id/${randomUUID()}`,space.space,space.realm]);
    const zone = `https://rezics.com/id/${randomUUID()}`;
    const scope = `zone:edit:${zone}`;
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES($1)',[scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES($1,$2,$3,'zone.edit',now()+interval '1 hour')`,[randomUUID(),home.author.principalId,owner]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES($1,$2,$2,$3,'zone.edit',now()+interval '1 hour')`,[randomUUID(),owner,scope]);
    // Alias recovery needs an admitted Zone with its type, owner link and
    // reciprocal capability, not just a dangling Space-to-Zone edge.
    await json(await call('POST','/v1/zones',{
      zone,space: space.space,disclosure: 'public',actingSubject: owner },home.author.token),201);
    await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level)
      VALUES($1,$2,'realm',$4,true,gen_random_uuid(),'off'),($1,$3,'zone',$4,false,gen_random_uuid(),'highlights')`,
      [home.reader.principalId,space.realm,zone,reader]);
    const client = await stack.accessPool.connect();
    try { await registerFollowSpace(client,{ ...identity!,aliases: [...identity!.aliases,zone] }); } finally { client.release(); }
    expect(await home.deps.follows.state(space.realm,{ principal,agent: reader })).toMatchObject({ following: true,level: 'all' });
    expect(await relationshipRecipients(stack.accessPool,{ targets: [space.space],highlights: true })).toContain(home.reader.principalId);
    const bad = `https://rezics.com/id/${randomUUID()}`;
    await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision)
      VALUES($1,$2,'realm',$3,true,gen_random_uuid())`,[home.reader.principalId,bad,reader]);
    let deferred = 0;
    const graph = { query: (sql: string, bound?: number) => {
      if (sql.includes(bad)) { deferred++; throw new Error('one unavailable Space row'); }
      return stack.fuseki.query(sql,bound);
    } } as Pick<FusekiClient,'query'>;
    const priorCursor = (await stack.accessPool.query<{ space_after_principal: string | null; space_after_target: string }>(
      'SELECT space_after_principal,space_after_target FROM access.relationship_recovery_cursor WHERE id')).rows[0]!;
    try {
      // Recovery is paged; the fault row must belong to this tick's page.
      await stack.accessPool.query("UPDATE access.relationship_recovery_cursor SET space_after_principal=$1,space_after_target='' WHERE id",
        [home.reader.principalId]);
      await recoverSpaceFollows(stack.accessPool,graph);
      expect(deferred).toBe(1);
    } finally {
      await stack.accessPool.query('UPDATE access.relationship_recovery_cursor SET space_after_principal=$1,space_after_target=$2 WHERE id',
        [priorCursor.space_after_principal,priorCursor.space_after_target]);
    }
    configureFollowGraph(stack.accessPool,stack.fuseki);
    expect(await home.deps.follows.state(space.space,{ principal,agent: reader })).toMatchObject({ following: true,level: 'all',source: 'join',pinPosition: 2 });
    expect((await stack.accessPool.query("SELECT target FROM access.follow WHERE principal_id=$1 AND kind IN ('realm','zone')",[home.reader.principalId])).rows).toEqual([{ target: bad }]);
    // Private membership follows must not reveal the recipient through public counts.
    const consent = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.private_membership_consent(id,principal_id,principal_epoch,kind,owner_subject,
      policy_revision,terms_revision,next_generation,expires_at) SELECT $1,$2,0,'realm',$3,revision,terms_revision,1,now()+interval '5 minutes'
      FROM access.membership_policy WHERE kind='realm' AND owner_subject=$3`,[consent,home.reader.principalId,space.realm]);
    await stack.accessPool.query(`INSERT INTO access.private_membership(id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
      SELECT $1,'realm',$2,$3,'joined',1,revision,terms_revision,$4 FROM access.membership_policy WHERE kind='realm' AND owner_subject=$2`,
      [randomUUID(),space.realm,home.reader.principalId,consent]);
    expect((await home.deps.follows.state(space.space)).followers).toEqual({ value: 0,kind: 'exact' });
    // A non-member follow pauses; a current member's Join follow stays eligible.
    await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level)
      VALUES($1,$2,'space',$3,true,gen_random_uuid(),'all')`,[home.author.principalId,space.space,owner]);
    const beforePrivate = await admin.settings(ownerPrincipal,space.realm,owner,stack.env);
    await admin.changeSettings(ownerPrincipal,space.realm,{ actingSubject: owner,expectedGeneration: beforePrivate.generation,
      expectedRulesRevision: beforePrivate.ruleBasis.revision,reason: 'Make private',
      settings: { ...beforePrivate.settings,visibility: 'private' } },randomUUID(),stack.env);
    expect(await relationshipRecipients(stack.accessPool,{ targets: [space.realm],highlights: true })).toEqual([home.reader.principalId]);
    expect(await relationshipEligible(stack.accessPool,home.reader.principalId,{ targets: [space.space],highlights: true })).toBe(true);
    const page = await json<Page>(await call('GET',`/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=space&q=Private`,undefined,home.reader.token));
    expect(page.items).toMatchObject([{ id: space.space,available: true,name: { value: 'Private review Space' } }]);
    const memberships = await json<{ items: Array<{ realm: string; available: boolean; name: { value: string } }> }>(
      await call('GET',`/v1/me/memberships?actingSubject=${encodeURIComponent(reader)}&q=Private`,undefined,home.reader.token));
    expect(memberships.items).toMatchObject([{ realm: space.realm,available: true,name: { value: 'Private review Space' } }]);
    const sidebar = await json<Page>(await call('GET',`/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=realm`,undefined,home.reader.token));
    expect(sidebar.items.map(item => item.id)).not.toContain(space.realm);
    const zones = await json<Page>(await call('GET',`/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=zone`,undefined,home.reader.token));
    expect(zones.items).toContainEqual(expect.objectContaining({ id: zone,kind: 'zone',available: true }));
    const budgetSpace = await json<{ space: string; realm: string }>(await call('POST','/v1/spaces',{
      profile: 'space-realm-v1',name: 'Budget Space',capabilities: ['realm'],actingSubject: owner },home.author.token),201);
    await admin.initialize(ownerPrincipal,budgetSpace.realm,owner,stack.env);
    const budgetSettings = await admin.settings(ownerPrincipal,budgetSpace.realm,owner,stack.env);
    await admin.changeSettings(ownerPrincipal,budgetSpace.realm,{ actingSubject: owner,expectedGeneration: budgetSettings.generation,
      expectedRulesRevision: budgetSettings.ruleBasis.revision,reason: 'Allow budget Join',
      settings: { ...budgetSettings.settings,selfJoin: true } },randomUUID(),stack.env);
    await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision)
      SELECT $1,'https://rezics.com/id/'||gen_random_uuid()::text,'work',$2,true,gen_random_uuid()
        FROM generate_series(1,10000-(SELECT active_count FROM access.follow_inventory WHERE principal_id=$1))`,[home.reader.principalId,reader]);
    const budgetPolicy = await joining.policyFor(principal,budgetSpace.realm,reader);
    expect(await joining.selfJoin(principal,budgetSpace.realm,{ ...input,expectedMembershipGeneration: '0',
      expectedPolicyRevision: budgetPolicy.policyRevision,termsRevision: budgetPolicy.termsRevision },randomUUID())).toMatchObject({ membershipGeneration: '1' });
    expect(await home.deps.follows.state(budgetSpace.space,{ principal,agent: reader })).toMatchObject({ following: false });
    // Membership cursors also survive unrelated graph/feed progress.
    const membershipUrl = `/v1/me/memberships?actingSubject=${encodeURIComponent(reader)}&order=pinned&limit=1`;
    const first = await json<{ items: unknown[]; nextCursor: string }>(await call('GET',membershipUrl,undefined,home.reader.token));
    expect(first.items).toHaveLength(1);
    const activity = await stack.publicWork(owner,['en'],'Feed activity between membership pages');
    await home.project();
    const selection = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?selection WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(activity.mainVersion)} rv:selectionHead ?selection } }`)).results!.bindings[0]!.selection!.value;
    expect((await stack.accessPool.query('SELECT id FROM access.feed_item WHERE data_epoch=$1 AND id=$2',
      [stack.env.lineage.dataEpoch,selection])).rows).toEqual([{ id: selection }]);
    expect((await json<{ items: unknown[] }>(await call('GET',`${membershipUrl}&cursor=${encodeURIComponent(first.nextCursor)}`,undefined,home.reader.token))).items).toHaveLength(1);
  } finally { await home.stop(); }
},180_000);

test('G-938 join-request approval maps the Space before atomically creating the Join follow', async () => {
  const home = await startHomeStack('g-938-request-follow');
  try {
    const owner = await home.provision('Request Space owner',home.author.token);
    const reader = await home.provision('Request Space reader',home.reader.token);
    const ownerPrincipal = { ...home.author.principal,emailVerified: true };
    const principal = { ...home.reader.principal,emailVerified: true };
    const space = await home.json<{ space: string; realm: string }>(await home.call('POST','/v1/spaces',{
      profile: 'space-realm-v1',name: 'Request follow Space',capabilities: ['realm'],actingSubject: owner },home.author.token),201);
    const admin = new AccessRealmManagement(home.stack.accessPool);
    await admin.initialize(ownerPrincipal,space.realm,owner,home.stack.env);
    const settings = await admin.spaceSettings(ownerPrincipal,space.space,owner,home.stack.env);
    await admin.changeSpaceSettings(ownerPrincipal,space.space,{ actingSubject: owner,expectedGeneration: settings.generation,
      reason: 'Require requests',settings: { ...settings.settings,admission: 'request' } },randomUUID(),home.stack.env);
    const requests = new RealmJoinRequests(home.stack.accessPool,home.stack.env);
    const basis = await requests.basis(principal,space.realm,reader);
    const requested = await requests.request(principal,space.realm,{ actingSubject: reader,
      expectedMembershipGeneration: basis.membershipGeneration,expectedPolicyRevision: basis.policyRevision,
      termsRevision: basis.termsRevision,reason: 'Join the discussion' },randomUUID());
    expect((await home.stack.accessPool.query('SELECT 1 FROM access.follow_space_alias WHERE alias=$1',[space.realm])).rowCount).toBe(0);
    const current = await admin.spaceSettings(ownerPrincipal,space.space,owner,home.stack.env);
    const decision = { actingSubject: owner,expectedGeneration: current.generation,
      expectedRequestGeneration: requested.requestGeneration,decision: 'accepted' as const,reason: 'Welcome' };
    const key = randomUUID();
    await requests.decide(ownerPrincipal,space.realm,requested.requestId,decision,key);
    expect(await home.deps.follows.state(space.space,{ principal,agent: reader })).toMatchObject({ following: true,source: 'join' });
    expect(await requests.decide(ownerPrincipal,space.realm,requested.requestId,decision,key)).toMatchObject({ state: 'accepted',replayed: true });
  } finally { await home.stop(); }
},180_000);

test('G-938 recovery expires automatic thread Watches and retains manual choices', async () => {
  const home = await startHomeStack('g-938-watch-retention');
  try {
    const actor = await home.provision('Watch retention reader',home.reader.token);
    const targets = Array.from({ length: 4 },() => `https://rezics.com/id/${randomUUID()}`);
    await home.stack.accessPool.query(`INSERT INTO access.watch(principal_id,target,kind,reason,level,manual_choice,changed_at)
      VALUES($1,$2,'thread','reviewer','participating',false,now()-interval '91 days'),
      ($1,$3,'thread','manual','all',false,now()-interval '91 days'),
      ($1,$4,'thread','reviewer','ignore',true,now()-interval '91 days'),
      ($1,$5,'thread','reviewer','participating',false,now())`,[home.reader.principalId,...targets]);
    await home.stack.accessPool.query('INSERT INTO access.watch_participation(principal_id,target) VALUES($1,$2)',
      [home.reader.principalId,targets[0]]);
    await new WatchStore(home.stack.accessPool).set({ ...home.reader.principal,emailVerified: true },
      { actingSubject: actor,target: targets[3]!,kind: 'thread',level: 'all',expectedRevision: '1' },randomUUID(),async () => {});
    expect((await home.stack.accessPool.query('SELECT manual_choice FROM access.watch WHERE principal_id=$1 AND target=$2',
      [home.reader.principalId,targets[3]])).rows[0]).toEqual({ manual_choice: true });
    const producer = new NotificationProducer(home.stack.accessPool,null,home.stack.contentPool,home.stack.fuseki,
      new NotificationStore(home.stack.accessPool),null);
    await producer.runRelationshipRecoveryOnce();
    const retained = (await home.stack.accessPool.query<{ target: string }>(
      'SELECT target FROM access.watch WHERE principal_id=$1 ORDER BY target',[home.reader.principalId])).rows.map(row => row.target);
    expect(retained.sort()).toEqual(targets.slice(1).sort());
    expect((await home.stack.accessPool.query('SELECT 1 FROM access.watch_participation WHERE principal_id=$1 AND target=$2',
      [home.reader.principalId,targets[0]])).rowCount).toBe(0);
    await expect(home.stack.accessPool.query('DELETE FROM access.watch WHERE principal_id=$1 AND target=$2',
      [home.reader.principalId,targets[1]])).rejects.toThrow('manual watches are retained');
  } finally { await home.stop(); }
},180_000);

test('G-938 row failures do not stall library recovery and committed library writes survive projection failure', async () => {
  const home = await startHomeStack('g-938-review-library');
  const priorCursor = (await home.stack.accessPool.query<{ library_agent: string; library_work: string }>(
    'SELECT library_agent,library_work FROM access.relationship_recovery_cursor WHERE id')).rows[0]!;
  try {
    const { stack } = home;
    const actor = await home.provision('Recovery reader',home.reader.token);
    const author = await home.provision('Recovery author',home.author.token);
    const works = await Promise.all([stack.publicWork(author,['en'],'Bad recovery row'),stack.publicWork(author,['en'],'Good recovery row')]);
    await stack.contentPool.query(`INSERT INTO reader.library_status(agent,work,status,version) VALUES($1,$2,'reading',1),($1,$3,'reading',1)`,[actor,works[0]!.work,works[1]!.work]);
    let deferred = 0;
    const faulty = { query: async (sql: string,params: unknown[]) => {
      if (sql.startsWith('SELECT version::text') && params[1]===works[0]!.work) { deferred++; throw new Error('one unavailable row'); }
      return stack.contentPool.query(sql,params);
    } } as unknown as Pool;
    const recoverOwnRows = async (content: Pool) => {
      // A tick reads 32 rows, so give this fixture's rows a known starting cut.
      await stack.accessPool.query("UPDATE access.relationship_recovery_cursor SET library_agent=$1,library_work='' WHERE id",[actor]);
      return recoverLibraryFollows(content,stack.accessPool);
    };
    await recoverOwnRows(faulty);
    expect(deferred).toBe(1);
    expect(await home.deps.follows.state(works[1]!.work,{ principal: { ...home.reader.principal,emailVerified: true },agent: actor }))
      .toMatchObject({ following: true,source: 'library' });
    const cursor = (await stack.accessPool.query<{ library_work: string }>('SELECT library_work FROM access.relationship_recovery_cursor WHERE id')).rows[0]!;
    expect(cursor.library_work).not.toBe('');
    await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision)
      SELECT $1,'https://rezics.com/id/'||gen_random_uuid()::text,'work',$2,true,gen_random_uuid()
        FROM generate_series(1,10000-(SELECT active_count FROM access.follow_inventory WHERE principal_id=$1))`,[home.reader.principalId,actor]);
    configureLibraryFollows(stack.contentPool,stack.accessPool);
    expect(await home.deps.libraryStatus.write({ agent: actor,work: works[0]!.work,status: 'want-to-read',expectedVersion: 1,idempotencyKey: randomUUID() }))
      .toMatchObject({ status: 'want-to-read',version: 2 });
    expect(await home.deps.follows.state(works[0]!.work,{ principal: { ...home.reader.principal,emailVerified: true },agent: actor }))
      .toMatchObject({ following: false });
    await stack.accessPool.query(`DELETE FROM access.follow WHERE (principal_id,target) IN
      (SELECT principal_id,target FROM access.follow WHERE principal_id=$1 AND target<>ALL($2::text[]) LIMIT 1)`,
      [home.reader.principalId,works.map(work => work.work)]);
    await recoverOwnRows(stack.contentPool);
    expect(await home.deps.follows.state(works[0]!.work,{ principal: { ...home.reader.principal,emailVerified: true },agent: actor }))
      .toMatchObject({ following: true,source: 'library' });
    configureLibraryFollows(stack.contentPool,{ connect: async () => { throw new Error('Access temporarily unavailable'); } } as unknown as Pool);
    expect(await home.deps.libraryStatus.write({ agent: actor,work: works[0]!.work,status: 'reading',expectedVersion: 2,idempotencyKey: randomUUID() }))
      .toMatchObject({ status: 'reading',version: 3 });
  } finally {
    await home.stack.accessPool.query('UPDATE access.relationship_recovery_cursor SET library_agent=$1,library_work=$2 WHERE id',
      [priorCursor.library_agent,priorCursor.library_work]);
    await home.stop();
  }
},180_000);
