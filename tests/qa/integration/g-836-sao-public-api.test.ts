import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { POLICY_VERSIONS } from '../../../services/account/src/policy-versions.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { discoverEditorialAdapters } from '../../../services/main/src/modules/editorial-review/adapters.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { discoverMergeHandlers, assertMergeCoverage } from '../../../services/main/src/modules/identity-merge/handlers.ts';
import { discoverOwnerIdentityReferences } from '../../../services/main/src/modules/identity-merge/reference-discovery.ts';
import { PERSON_STATE_MERGE_EXCLUSIONS } from '../../../services/main/src/modules/identity-merge/person-state-coverage.ts';
import { itemCommandKey } from '../../../services/main/src/modules/identity-merge/contract.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { readNextMainOutboxBatch, readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

const scopes = 'openid work:create work:edit work:read work:correct work:review work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read address:claim agent:create space:create rating:configure rating:submit follow:write follow:read';
interface Command { proposal: string; revision: number; outcome: string; receipt?: OwnerReceipt }

test('G836: public SAO merge and unmerge require independent humans, survive lost acknowledgement, resolve old addresses and reconcile person state', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp',`g-836-sao-${randomUUID()}`), started = Date.now();
  const f = await authorCreditFixture(Bun.env as Record<string,string>,directory,scopes);
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  let loseLibraryAcknowledgement = false, libraryCommits = 0;
  const interleavedEdits = new Map<string,() => Promise<void>>();
  const interleavedPool = (pool: Pool) => new Proxy(pool,{ get(target,property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client,{ get(native,key) {
        if (key === 'query') return async (query: string,parameters?: unknown[]) => {
          const commandKey = parameters?.[0],edit = typeof commandKey === 'string' && query.includes('_merge_receipt')
            ? interleavedEdits.get(commandKey) : undefined;
          if (edit) {
            interleavedEdits.delete(commandKey as string);
            // The interleaved HTTP request has its own graph budget, as it
            // would when another reader edits while merge delivery is paused.
            await fusekiReadBudget.exit(edit);
          }
          return native.query(query,parameters);
        };
        const value: unknown = Reflect.get(native,key,native);
        return typeof value === 'function' ? value.bind(native) : value;
      } });
    };
    const value: unknown = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  const mergeAccessPool = interleavedPool(f.accessPool);
  // Lose acknowledgement after the native effect/receipt COMMIT, before the
  // Access item journal can record it. Restart must find the native receipt.
  const faultPool = new Proxy(interleavedPool(f.pool),{ get(target,property) {
    if (property === 'connect') return async () => {
      const client = await target.connect(); let effect = false;
      return new Proxy(client,{ get(native,key) {
        if (key === 'query') return async (query: string,parameters?: unknown[]) => {
          if (query.includes('INSERT INTO reader.library_status_merge_receipt')) effect = true;
          const result = await native.query(query,parameters);
          if (query === 'COMMIT' && effect) {
            libraryCommits++; effect = false;
            if (loseLibraryAcknowledgement) { loseLibraryAcknowledgement = false; throw new Error('lost committed library acknowledgement'); }
          }
          return result;
        };
        const value: unknown = Reflect.get(native,key,native);
        return typeof value === 'function' ? value.bind(native) : value;
      } });
    };
    const value: unknown = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  const diagnostics: string[] = [], modules = discoverEditorialAdapters().then(installed => {
    const native = installed.get('merge')!;
    installed.set('merge',{ ...native,create(runtime) {
      const adapter = native.create(runtime);
      return { ...adapter,commands: async input => (await adapter.commands!(input)).map(command => ({ ...command,
        execute: async (...args) => { try { return await command.execute(...args); }
          catch (error) { diagnostics.push(`${command.key}: ${error instanceof Error ? error.message : String(error)}`); throw error; } },
      })) };
    } }); return installed;
  });
  f.access.configureBaseline(f.env.fuseki);
  const deps = { environment: f.env,access: f.access,account: f.account.verifier,
    identityMerge: { accessPool: mergeAccessPool,contentPool: faultPool },
    agentProvisioning: new AgentProvisioning(f.accessPool,f.env),
    editorialReview: new EditorialReviewStore(mergeAccessPool,modules),libraryStatus: new ReaderLibraryStatusStore(f.pool),
    follows: new FollowsStore(f.accessPool),reviews: new ReaderReviews(f.accessPool),progress: new StructureProgressStore(f.pool) };
  let app = createMainApp(f.env.fuseki,deps);
  const call = (method: string,path: string,body?: object,token: string | null = f.account.tokenA,key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`,{ method,headers: { 'idempotency-key': key,
      ...(token ? { authorization: `Bearer ${token}` } : {}),...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  async function json<T>(response: Response,status = 200): Promise<T> {
    const body: unknown = await response.json();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}; native delivery: ${diagnostics.join('; ')}`);
    return body as T;
  }
  const grant = async (principal: string,agent: string,scope: string,action: string) => {
    await f.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',[scope]);
    await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'infinity')`,[randomUUID(),principal,agent,action]);
    await f.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,'infinity')`,[randomUUID(),agent,scope,action]);
  };
  const path = (id: string,suffix = '') => `/v1/editorial/proposals/${id}${suffix}`;
  try {
    await accountPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=ANY($1::text[])',[[f.account.a.id,f.account.b.id]]);
    const tokenB = await f.account.tokenFor(f.account.b,scopes);
    const email = `g836-${randomUUID()}@example.test`, password = randomBytes(24).toString('base64url');
    const third = await json<{ user: { id: string } }>(await fetch(`${f.account.issuer}/sign-up/email`,{ method: 'POST',
      headers: { 'content-type': 'application/json',origin: f.account.issuer.replace('/api/auth','') },
      body: JSON.stringify({ name: 'Independent reviewer',email,password,minimumAgeConfirmed: true,
        acceptedPolicies: POLICY_VERSIONS.map(({ policyId,versionDigest }) => ({ policyId,versionDigest })) }) }));
    await accountPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1',[third.user.id]);
    const tokenC = await f.account.tokenFor({ email,password },scopes);
    const agent = async (name: string,token: string) => (await json<{ agent: string }>(await call('POST','/v1/agents',
      { profile: 'agent-provision-v1',kind: 'person',displayName: name },token),201)).agent;
    const actorA = await agent('SAO reader',f.account.tokenA), actorB = await agent('SAO reader and reviewer',tokenB),actorC = await agent('Second human reviewer',tokenC);
    const principalC = (await f.accessPool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',[f.account.issuer,third.user.id])).rows[0]!.id;
    for (const [principal,actor] of [[f.principalId,actorA],[f.otherPrincipal,actorB],[principalC,actorC]])
      await grant(principal!,actor!,'editorial:review:urn:rezics:context:global','work.review');
    const source = await f.adoptWork(await f.propose('OL836101W',[],'Sword Art Online 1 — Aincrad'));
    const survivor = await f.adoptWork(await f.propose('OL836102W',[],'ソードアート・オンライン 1 アインクラッド'));
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(source.work)} rv:catalogueVisible true . ${iri(survivor.work)} rv:catalogueVisible true } }`);
    // Reviewed merge admission probes ordinary edit authority for both owners.
    // Catalogue review eligibility alone cannot supply those owner permits.
    const editPair = async (principal: string,actor: string) => {
      for (const work of [source.work,survivor.work]) await grant(principal,actor,`work:edit:${work}`,'work.edit');
    };
    for (const [principal,actor] of [[f.principalId,actorA],[f.otherPrincipal,actorB],[principalC,actorC]]) await editPair(principal!,actor!);
    for (const work of [source.work,survivor.work]) await f.grant(`work:read:${work}`,'work.read');
    await f.grant(`address:claim:${source.work}`,'address.claim');
    const slug = `sao-836-${randomUUID().slice(0,8)}`;
    const address = await f.json<{ revision: string }>(await f.call('POST','/v1/addresses/claims',
      { profile: 'name-write-v1',scope: 'work',holder: source.work,operation: 'claim',name: slug,expectedRevision: null,actingSubject: f.actor }),201);
    const oldAddress = `/v1/addresses/revisions/${address.revision}?scope=work&key=${slug}`;
    const addressBefore = await json<Record<string,unknown>>(await call('GET',oldAddress,undefined,null));
    const status = (work: string,actor: string,value: string,token: string,expectedVersion = 0) => call('PUT',`/v1/works/${shortId(work)}/reader-status`,
      { actingSubject: actor,status: value,expectedVersion },token).then(r => json<{ version: number }>(r));
    await status(source.work,actorA,'read',f.account.tokenA); await status(survivor.work,actorA,'want-to-read',f.account.tokenA);
    await status(source.work,actorB,'read',tokenB);
    const follow = (work: string,actor: string,following: boolean,token: string,expectedRevision: string | null = null) => call('POST','/v1/follows',
      { profile: 'follow-command-v1',target: work,kind: 'work',actingSubject: actor,following,expectedRevision },token).then(r => json<{ revision: string }>(r));
    await follow(source.work,actorA,true,f.account.tokenA);
    // An explicit survivor opt-out retains a real follow's revision; removing
    // a nonexistent follow is rejected by the current management API.
    const survivorFollow = await follow(survivor.work,actorA,true,f.account.tokenA);
    await follow(survivor.work,actorA,false,f.account.tokenA,survivorFollow.revision);
    await follow(source.work,actorB,true,tokenB);
    await grant(f.principalId,actorA,GLOBAL_CONTEXT_SCOPE,'rating.context.create');
    const context = (await json<{ context: string }>(await call('POST','/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1',question: 'How good was SAO volume 1?',actingSubject: actorA }),201)).context;
    for (const [principal,actor] of [[f.principalId,actorA],[f.otherPrincipal,actorB]]) await grant(principal!,actor!,`rating:observe:${context}`,'rating.observation.set');
    const rate = (work: typeof source,actor: string,value: number,token: string) => call('POST','/v1/global-rating-observations',
      { profile: 'global-rating-standing-observation-v1',context,work: work.work,mainVersion: work.mainVersion,
        expectedRevisionHead: null,value,actingSubject: actor },token).then(r => json(r,201));
    await rate(source,actorA,2,f.account.tokenA); await rate(survivor,actorA,4,f.account.tokenA); await rate(source,actorB,5,tokenB);
    const aggregate = (work: typeof source) => call('POST','/v1/global-rating-aggregates',
      { profile: 'global-rating-standing-latest-mean-v1',context,work: work.work,mainVersion: work.mainVersion },null)
      .then(r => json<{ count: number; mean: number }>(r));
    expect(await aggregate(survivor)).toMatchObject({ count: 1,mean: 4 });
    // Two occasions are independent exact observations, never a duplicate
    // standing vote. They must neither block the merge nor be coalesced.
    await grant(f.principalId,actorA,'space:create:root','space.create');
    const realm = (await json<{ realm: string }>(await call('POST','/v1/spaces',
      { profile: 'space-realm-v1',name: 'SAO readers',capabilities: ['realm'],actingSubject: actorA }),201)).realm;
    await grant(f.principalId,actorA,`rating:context:${realm}`,'rating.context.create');
    const realmContext = (await json<{ context: string }>(await call('POST','/v1/rating-contexts',
      { profile: 'realm-standing-rating-context-v1',realm,question: 'SAO standing quality',actingSubject: actorA }),201)).context;
    for (const [principal,actor] of [[f.principalId,actorA],[f.otherPrincipal,actorB]]) await grant(principal!,actor!,`rating:observe:${realmContext}`,'rating.observation.set');
    for (const [work,actor,value,token] of [[source,actorA,2,f.account.tokenA],[survivor,actorA,4,f.account.tokenA],[source,actorB,5,tokenB]] as const)
      await json(await call('POST','/v1/rating-observations',{ profile: 'realm-standing-rating-observation-v1',context: realmContext,
        work: work.work,mainVersion: work.mainVersion,expectedRevisionHead: null,value,actingSubject: actor },token),201);
    const realmAggregate = (work: typeof source) => call('POST','/v1/rating-aggregates',
      { profile: 'realm-standing-latest-mean-v1',context: realmContext,work: work.work,mainVersion: work.mainVersion },null)
      .then(r => json<{ count: number; mean: number }>(r));
    expect(await realmAggregate(survivor)).toMatchObject({ count: 1,mean: 4 });
    const experience = (await json<{ context: string }>(await call('POST','/v1/rating-contexts',
      { profile: 'realm-experience-rating-context-v1',realm,question: 'How was this reading?',actingSubject: actorA }),201)).context;
    await grant(f.principalId,actorA,`rating:observe:${experience}`,'rating.observation.set');
    for (const value of [3,5]) await json(await call('POST','/v1/rating-observations',
      { profile: 'realm-experience-rating-observation-v1',context: experience,work: source.work,mainVersion: source.mainVersion,
        occasion: randomUUID(),expectedRevisionHead: null,value,actingSubject: actorA }),201);
    const exactRatings = () => f.accessPool.query('SELECT to_jsonb(h) AS row FROM access.rating_aggregate_head h WHERE context=$1 ORDER BY slot',[experience]);
    const exactRatingsBefore = (await exactRatings()).rows; expect(exactRatingsBefore).toHaveLength(2);
    const reviewBody = (work: string,actor: string,text: string,expectedRevision: string | null = null) =>
      ({ profile: 'reader-review-command-v1',context,target: work,actingSubject: actor,text,language: 'en',spoiler: false,expectedRevision });
    const reviewA = await json<{ review: string }>(await call('POST','/v1/reviews',reviewBody(source.work,actorA,'Original source review')),201);
    const reviewSurvivor = await json<{ review: string; revision: string }>(await call('POST','/v1/reviews',reviewBody(survivor.work,actorA,'Survivor review')),201);
    const reviewB = await json<{ review: string }>(await call('POST','/v1/reviews',reviewBody(source.work,actorB,'Source-only reader review'),tokenB),201);
    // Exact historical reading progress is deliberately not coalesced into a
    // Work slot. Native owner fixture setup creates one independent occurrence.
    const structure = nativeId(),occurrence = nativeId();
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(structure)} a rv:Structure ; rv:structureOf ${iri(source.mainVersion)} ; rv:structureProfile rv:BookComposition } }`);
    await deps.progress.write({ principal: { issuer: f.account.issuer,subject: f.account.a.id,emailVerified: true },structure,occurrence,
      completed: false,position: 'page:12',expectedVersion: 0,idempotencyKey: randomUUID() });
    const progressBefore = (await f.pool.query('SELECT to_jsonb(p) AS row FROM structure.progress p WHERE structure=$1',[structure])).rows;
    const originalHeads = [{ component: source.work,head: source.workRevision },{ component: survivor.work,head: survivor.workRevision }];
    const evidence = [{ resource: source.work,revision: source.workRevision,locator: 'SAO-volume-1/cover-and-title' }];
    const target = { resource: source.work,revision: source.workRevision,context: 'urn:rezics:context:global' };
    const candidate = { operation: 'merge',source: { resource: source.work,revision: source.workRevision },
      survivor: { resource: survivor.work,revision: survivor.workRevision },evidence };
    const propose = (plan: object,baseHeads = originalHeads) => call('POST','/v1/editorial/proposals',{
      profile: 'editorial-proposal-create-v1',kind: 'merge',target,candidate: plan,baseHeads,evidence,actingSubject: actorA }).then(r => json<Command>(r,201));
    const handlers = await discoverMergeHandlers({ accessPool: f.accessPool,contentPool: f.pool,graph: f.env.fuseki });
    const references = (await Promise.all([discoverOwnerIdentityReferences(f.accessPool),discoverOwnerIdentityReferences(f.pool)])).flat();
    assertMergeCoverage(references,handlers,PERSON_STATE_MERGE_EXCLUSIONS);
    const invalid = (plan: object,baseHeads = originalHeads) => call('POST','/v1/editorial/proposals',{ profile: 'editorial-proposal-create-v1',kind: 'merge',target,candidate: plan,baseHeads,evidence,actingSubject: actorA });
    expect((await invalid({ ...candidate,survivor: candidate.source })).status).toBe(400);
    expect((await invalid({ ...candidate,operation: 'split' })).status).toBe(400);
    const stale = { ...candidate,source: { ...candidate.source,revision: nativeId() } };
    await json(await invalid(stale,[{ component: source.work,head: stale.source.revision },originalHeads[1]!]),409);
    const proposed = await propose(candidate);
    // The library delivery cursor pins a native Content slot version. Watch
    // targets and participation pin exact proposals, not standing Work slots.
    // Discovery must classify these new columns without moving their evidence.
    await f.accessPool.query('INSERT INTO access.library_follow_position(agent,work,version) VALUES ($1,$2,1)',[actorA,source.work]);
    await expect(f.accessPool.query(`INSERT INTO access.watch(principal_id,target,kind,reason,level,revision)
      VALUES ($1,$2,'work','manual','all',1)`,[f.principalId,source.work])).rejects.toMatchObject({ code: '23514' });
    const retainedReferences = async () => Promise.all([
      f.accessPool.query('SELECT to_jsonb(p) AS row FROM access.library_follow_position p WHERE agent=$1 AND work=$2',[actorA,source.work]),
      f.accessPool.query('SELECT to_jsonb(w) AS row FROM access.watch w WHERE target=$1 ORDER BY principal_id',[`urn:rezics:proposal:${proposed.proposal}`]),
      f.accessPool.query('SELECT to_jsonb(p) AS row FROM access.watch_participation p WHERE target=$1 ORDER BY principal_id',[`urn:rezics:proposal:${proposed.proposal}`]),
    ]).then(results => results.map(result => result.rows));
    const retainedBefore = await retainedReferences();
    for (const rows of retainedBefore) expect(rows.length).toBeGreaterThan(0);
    const preview = await json<{ revision: { before: { owners: Array<{ owner: string; count: number }> } } }>(await call('GET',path(proposed.proposal),undefined,null));
    expect(Object.fromEntries(preview.revision.before.owners.map(owner => [owner.owner,owner.count])))
      .toMatchObject({ library: 2,follows: 2,rating: 5,review: 2 });
    expect(preview.revision.before.owners.some(owner => owner.owner === 'progress')).toBe(false);
    const approve = (id: string,actor: string,token: string) => call('POST',path(id,'/reviews'),
      { profile: 'editorial-proposal-review-v1',revision: 1,outcome: 'approve',message: 'Checked volume and language evidence',actingSubject: actor },token);
    const decide = (id: string,actor: string,token: string,approveNow = false,key = randomUUID()) => call('POST',path(id,'/decisions'),
      { profile: 'editorial-proposal-decide-v1',revision: 1,outcome: 'applied',approve: approveNow,message: 'Apply reviewed correction',actingSubject: actor },token,key);
    const finish = async (id: string,key = randomUUID()) => {
      for (let attempt=0;attempt<16;attempt++) {
        const response = await decide(id,actorC,tokenC,true,key);
        if (response.status === 200) return json<Command>(response);
        await json<Command>(response,202);
      }
      throw new Error('Bounded native stages did not finish');
    };
    await json(await approve(proposed.proposal,actorB,tokenB));
    expect((await json<{ blocker: { code: string } }>(await decide(proposed.proposal,actorB,tokenB),409)).blocker.code).toBe('required_approvals');
    const bot = (await json<{ agent: string }>(await call('POST','/v1/agents',{ profile: 'agent-provision-v1',kind: 'service',displayName: 'Reviewer bot' },tokenB),201)).agent;
    await grant(f.otherPrincipal,bot,'editorial:review:urn:rezics:context:global','work.review');
    await editPair(f.otherPrincipal,bot);
    expect((await approve(proposed.proposal,bot,tokenB)).status).toBe(403);
    const dependent = await agent('Same operator second Agent',tokenB);
    await grant(f.otherPrincipal,dependent,'editorial:review:urn:rezics:context:global','work.review');
    await editPair(f.otherPrincipal,dependent);
    await json(await approve(proposed.proposal,dependent,tokenB));
    expect((await json<{ blocker: { code: string } }>(await decide(proposed.proposal,dependent,tokenB),409)).blocker.code).toBe('required_approvals');
    loseLibraryAcknowledgement = true;
    const applyKey = randomUUID();
    await json(await decide(proposed.proposal,actorC,tokenC,true,applyKey),202);
    if (libraryCommits !== 1) throw new Error(`Expected interrupted library effect; native delivery: ${diagnostics.join('; ')}`);
    // The Work redirect has already committed, before the interrupted library
    // stage. Receipt-only GET must leave native delivery untouched.
    const oldId = `/v1/resources/${shortId(source.work)}`;
    expect(await json(await call('GET',oldId,undefined,null))).toMatchObject({ status: 'merged',resolution: { survivor: survivor.work } });
    await json(await call('GET',path(proposed.proposal),undefined,null)); expect(libraryCommits).toBe(1);
    app = createMainApp(f.env.fuseki,{ ...deps,editorialReview: new EditorialReviewStore(mergeAccessPool,modules) });
    const merged = await finish(proposed.proposal,applyKey);
    expect(merged.outcome).toBe('applied'); expect(merged.receipt?.commands).toHaveLength(5);
    for (const [index,rows] of (await retainedReferences()).entries()) expect(rows).toEqual(expect.arrayContaining(retainedBefore[index]!));
    const identityEvent = async (command: Command,operation: string) => {
      const rows = (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?epoch ?sequence WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:mergeTask ${lit(command.receipt!.operationKey)} ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
      } LIMIT 2`)).results!.bindings;
      expect(rows).toHaveLength(1);
      const batch = await readNextMainOutboxBatch(f.env.fuseki,rows[0]!.epoch!.value,(BigInt(rows[0]!.sequence!.value)-1n).toString());
      expect(batch?.eventIds).toHaveLength(1);
      expect(await readMainOutboxEnvelope(f.env.fuseki,batch!,batch!.eventIds[0]!)).toMatchObject({
        type: 'com.rezics.work.identity-changed.v1',data: { receipt: { work: source.work,survivor: survivor.work,operation,
          systemProof: { kind: 'reviewed-identity-merge',task: command.receipt!.operationKey } } } });
    };
    await identityEvent(merged,'merge');
    expect(libraryCommits).toBe(2);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM reader.library_status_merge_receipt WHERE task_key=$1',[merged.receipt!.operationKey])).rows[0].n).toBe(2);
    expect(await json(await call('GET',`/v1/addresses/resolve?scope=work&key=${slug}`,undefined,null))).toMatchObject({ state: 'current',holder: source.work,resolution: { survivor: survivor.work } });
    expect(await json(await call('GET',oldAddress,undefined,null))).toMatchObject({ ...addressBefore,resolution: { survivor: survivor.work } });
    expect(await json(await call('GET',`/v1/revisions/${shortId(source.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`))).toMatchObject({ resolution: { survivor: survivor.work } });
    const state = () => f.pool.query<{ agent: string; work: string; status: string | null }>('SELECT agent,work,status FROM reader.library_status WHERE agent=ANY($1::text[]) AND work=ANY($2::text[]) ORDER BY agent,work',[[actorA,actorB],[source.work,survivor.work]]);
    expect((await state()).rows).toEqual(expect.arrayContaining([
      { agent: actorA,work: source.work,status: null },{ agent: actorA,work: survivor.work,status: 'want-to-read' },
      { agent: actorB,work: source.work,status: null },{ agent: actorB,work: survivor.work,status: 'read' }]));
    expect(await aggregate(survivor)).toMatchObject({ count: 2,mean: 4.5 });
    expect(await realmAggregate(survivor)).toMatchObject({ count: 2,mean: 4.5 });
    expect((await exactRatings()).rows).toEqual(exactRatingsBefore);
    const followState = await json<{ followers: { value: number }; following: boolean }>(await call('GET',`/v1/follows/${shortId(source.work)}?kind=work&actingSubject=${encodeURIComponent(actorB)}`,undefined,tokenB));
    expect(followState).toMatchObject({ followers: { value: 1 },following: true });
    // Source version 2 is current on its tombstone, but the survivor slot is
    // version 1. An old-ID write must compare against the resolved survivor.
    expect((await call('PUT',`/v1/works/${shortId(source.work)}/reader-status`,{ actingSubject: actorA,status: 'read',expectedVersion: 2 })).status).toBe(409);
    const reviews = () => f.accessPool.query<{ id: string; work: string; deleted: boolean; body: string }>('SELECT id,work,deleted,body FROM access.reader_review WHERE id=ANY($1::uuid[]) ORDER BY id',[[shortId(reviewA.review),shortId(reviewSurvivor.review),shortId(reviewB.review)]]);
    expect((await reviews()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shortId(reviewA.review),work: source.work,deleted: true }),
      expect.objectContaining({ id: shortId(reviewB.review),work: survivor.work,deleted: false })]));
    const page = await json<{ mergedFacts: { origins: Array<{ resource: string; work: { id: string } }> } }>(await call('GET',`/v1/resources/${shortId(survivor.work)}/page`,undefined,null));
    expect(page.mergedFacts.origins).toEqual(expect.arrayContaining([expect.objectContaining({ resource: source.work,work: expect.objectContaining({ id: source.work }) })]));
    expect((await f.pool.query('SELECT to_jsonb(p) AS row FROM structure.progress p WHERE structure=$1',[structure])).rows).toEqual(progressBefore);
    await json(await call('POST','/v1/reviews',reviewBody(survivor.work,actorA,'Later survivor edit',reviewSurvivor.revision)));
    const reverse = await json<Command>(await call('POST',path(proposed.proposal,'/reversal'),
      { profile: 'editorial-proposal-revert-v1',evidence,actingSubject: actorA }),201);
    await json(await approve(reverse.proposal,actorB,tokenB));
    const unmerged = await finish(reverse.proposal);
    expect(unmerged.outcome).toBe('applied');
    for (const [index,rows] of (await retainedReferences()).entries()) expect(rows).toEqual(expect.arrayContaining(retainedBefore[index]!));
    await identityEvent(unmerged,'unmerge');
    expect(unmerged.receipt?.owner).toMatchObject({ outcomes: { ambiguous: 1 } });
    expect(await json(await call('GET',oldId,undefined,null))).toMatchObject({ status: 'available' });
    expect(await json(await call('GET',oldAddress,undefined,null))).toEqual(addressBefore);
    expect(await aggregate(source)).toMatchObject({ count: 2,mean: 3.5 }); expect(await aggregate(survivor)).toMatchObject({ count: 1,mean: 4 });
    expect(await realmAggregate(source)).toMatchObject({ count: 2,mean: 3.5 }); expect(await realmAggregate(survivor)).toMatchObject({ count: 1,mean: 4 });
    expect((await exactRatings()).rows).toEqual(exactRatingsBefore);
    expect((await f.accessPool.query('SELECT target,following FROM access.follow WHERE principal_id=$1 AND target=ANY($2::text[]) ORDER BY target',[f.otherPrincipal,[source.work,survivor.work]])).rows).toEqual(expect.arrayContaining([{ target: source.work,following: true },{ target: survivor.work,following: false }]));
    expect((await state()).rows).toEqual(expect.arrayContaining([
      { agent: actorA,work: source.work,status: 'read' },{ agent: actorA,work: survivor.work,status: 'want-to-read' },
      { agent: actorB,work: source.work,status: 'read' },{ agent: actorB,work: survivor.work,status: null }]));
    expect((await reviews()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shortId(reviewB.review),work: source.work,deleted: false }),
      expect.objectContaining({ id: shortId(reviewSurvivor.review),body: 'Later survivor edit' })]));
    expect((await f.pool.query('SELECT to_jsonb(p) AS row FROM structure.progress p WHERE structure=$1',[structure])).rows).toEqual(progressBefore);
    // Save another merge's owner pages, then perform ordinary public edits
    // before each corresponding native effect reads its current person slots.
    // Both a changed existing survivor and a newly populated survivor win.
    const raced = await propose(candidate), taskKey = `editorial:${raced.proposal}:1`, changedOwners: string[] = [];
    const afterCapture = (owner: string,item: string,edit: () => Promise<void>) => interleavedEdits.set(itemCommandKey(taskKey,owner,item),async () => {
      expect((await f.accessPool.query('SELECT 1 FROM access.identity_merge_item WHERE task_key=$1 AND owner=$2 AND item_key=$3',
        [taskKey,owner,item])).rows).toHaveLength(1);
      await edit(); changedOwners.push(owner);
    });
    const libraryVersion = (await f.pool.query<{ version: string }>('SELECT version::text FROM reader.library_status WHERE agent=$1 AND work=$2',[actorA,survivor.work])).rows[0]!.version;
    afterCapture('library',actorA,async () => { await status(survivor.work,actorA,'reading',f.account.tokenA,Number(libraryVersion)); });
    const followRevision = (await f.accessPool.query<{ revision: string }>('SELECT revision::text FROM access.follow WHERE principal_id=$1 AND target=$2',[f.principalId,survivor.work])).rows[0]!.revision;
    afterCapture('follows',f.principalId,async () => { await follow(survivor.work,actorA,true,f.account.tokenA,followRevision); });
    const ratingRevision = (await f.accessPool.query<{ revision: string }>('SELECT revision FROM access.rating_aggregate_head WHERE context=$1 AND work=$2 AND principal_id=$3',
      [context,survivor.work,f.principalId])).rows[0]!.revision;
    afterCapture('rating',`${f.principalId}|${context}`,async () => {
      await json(await call('POST','/v1/global-rating-observations',{ profile: 'global-rating-standing-observation-v1',context,
        work: survivor.work,mainVersion: survivor.mainVersion,expectedRevisionHead: ratingRevision,value: 3,actingSubject: actorA }),201);
    });
    afterCapture('review',shortId(reviewB.review),async () => {
      await rate(survivor,actorB,5,tokenB);
      await json(await call('POST','/v1/reviews',reviewBody(survivor.work,actorB,'Interleaved survivor review'),tokenB),201);
    });
    await json(await approve(raced.proposal,actorB,tokenB));
    const reconciled = await finish(raced.proposal);
    expect(reconciled.outcome).toBe('applied'); expect(interleavedEdits.size).toBe(0);
    expect(changedOwners.sort()).toEqual(['follows','library','rating','review']);
    const retained = (await f.accessPool.query<{ owner: string; item_key: string }>(`SELECT owner,item_key FROM access.identity_merge_item_outcome
      WHERE task_key=$1 AND outcome='retained'`,[taskKey])).rows;
    expect(retained).toEqual(expect.arrayContaining([
      { owner: 'library',item_key: actorA },{ owner: 'follows',item_key: f.principalId },
      { owner: 'rating',item_key: `${f.principalId}|${context}` },{ owner: 'review',item_key: shortId(reviewB.review) }]));
    expect((await state()).rows).toEqual(expect.arrayContaining([
      { agent: actorA,work: source.work,status: 'read' },{ agent: actorA,work: survivor.work,status: 'reading' }]));
    expect((await f.accessPool.query('SELECT target,following FROM access.follow WHERE principal_id=$1 AND target=ANY($2::text[])',
      [f.principalId,[source.work,survivor.work]])).rows).toEqual(expect.arrayContaining([
      { target: source.work,following: true },{ target: survivor.work,following: true }]));
    expect(await aggregate(survivor)).toMatchObject({ count: 2,mean: 4 });
    expect((await reviews()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shortId(reviewB.review),work: source.work,body: 'Source-only reader review',deleted: false })]));
    expect((await f.accessPool.query('SELECT body FROM access.reader_review WHERE principal_id=$1 AND work=$2',[f.otherPrincipal,survivor.work])).rows)
      .toEqual([{ body: 'Interleaved survivor review' }]);
    expect((await f.pool.query('SELECT to_jsonb(p) AS row FROM structure.progress p WHERE structure=$1',[structure])).rows).toEqual(progressBefore);
    expect(Date.now()-started).toBeLessThan(600_000);
  } finally { await accountPool.end(); await f.close(); rmSync(directory,{ recursive: true,force: true }); }
},120_000);
