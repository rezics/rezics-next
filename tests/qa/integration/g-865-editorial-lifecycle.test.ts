import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { independenceKey } from '../../../services/main/src/modules/editorial-review/authority.ts';
import { AdmissionConflict } from '../../../services/main/src/modules/access/admission.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { metadataComponent, checkedMetadataState } from '../../../services/main/src/modules/work/metadata-schema.ts';
import type { BaseHead, OwnerReceipt, TerminalDecision } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { replacementController } from './g-523-controller-fixture.ts';

interface Work { work: string; mainVersion: string; workRevision: string }
interface Command { proposal: string; revision: number; outcome: string; replayed: boolean; receipt?: OwnerReceipt }
interface Read { proposal: { proposer: string; latestRevision: number; decision: TerminalDecision | null; reverts: string | null };
  revision: { candidate: unknown; candidateDigest: string; baseHeads: BaseHead[]; evidence: unknown[] };
  state: string; approvalIds: string[]; staleApprovalIds: string[]; blockers: Array<{ code: string }>;
  allowedActions: string[]; timeline: Array<{ sequence: string; kind: string; actor: string }>; nextCursor: string | null }

test('G-865: durable API lifecycle binds current independent review to header and semantic owner receipts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const preparation = Date.now(), directory = resolve('.temp',`g-865-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string,string>,directory,
    'openid work:create work:edit work:read work:correct work:review');
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  let hideReceipts = false, loseOwnerResponse = false, headerWrites = 0, semanticWrites = 0;
  let ownerBarrier: { entered: () => void; released: Promise<void> } | undefined;
  const graph = new Proxy(f.env.fuseki,{ get(target,property) {
    if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
      const header = envelope.update.includes('WorkMetadataChangedEvent');
      const semantic = envelope.update.includes('SemanticChangedEvent');
      if (header) headerWrites++;
      if (semantic) semanticWrites++;
      if (header && ownerBarrier) {
        const barrier = ownerBarrier; ownerBarrier = undefined;
        barrier.entered(); await barrier.released;
      }
      const result = await target.commandWithReceipt(envelope);
      if (header && loseOwnerResponse) {
        loseOwnerResponse = false; hideReceipts = true; throw new Error('lost committed owner response');
      }
      return result;
    };
    if (property === 'query') return (...args: Parameters<typeof target.query>) => {
      if (hideReceipts && args[0].includes('SELECT ?outcome ?digest ?authority ?scope ?epoch')) {
        throw new Error('owner receipt temporarily unreachable');
      }
      return target.query(...args);
    };
    const value: unknown = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const deps: MainWorkDependencies = { environment: { ...f.env,fuseki: graph },access: f.access,
    account: f.account.verifier,editorialReview: new EditorialReviewStore(f.accessPool) };
  f.access.configureBaseline(graph);
  let app = createMainApp(graph,deps);
  const request = (method: string,path: string,body?: object,token: string | null = f.account.tokenA,key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`,{ method,headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },...(body ? { body: JSON.stringify(body) } : {}) }));
  async function json<T>(response: Response,status = 200): Promise<T> {
    const body: unknown = await response.json();
    expect({ status: response.status,...(response.status !== status ? { body } : {}) }).toEqual({ status });
    return body as T;
  }
  const withoutWaitingForDelivery = <T>(read: Promise<T>) => Promise.race([read,Bun.sleep(2000).then(() => {
    throw new Error('A read waited for the exclusive proposal delivery lock');
  })]);
  const path = (id: string,suffix = '') => `/v1/editorial/proposals/${id}${suffix}`;
  const get = (id: string,token: string | null = null,agent?: string,query = '') => request('GET',path(id)
    + (agent || query ? `?${agent ? `actingSubject=${encodeURIComponent(agent)}&` : ''}${query}` : ''),undefined,token).then(r => json<Read>(r));
  const actorB = nativeId(), actorC = nativeId(), otherActorA = nativeId();
  const tokenB = await f.account.tokenFor(f.account.b,'openid work:read work:correct work:review');
  try {
    // A third Account supplies an independently controlled second reviewer.
    const email = `g865-${randomUUID()}@example.test`, password = randomBytes(24).toString('base64url');
    const signup = await fetch(`${f.account.issuer}/sign-up/email`,{ method: 'POST',
      headers: { 'content-type': 'application/json',origin: f.account.issuer.replace('/api/auth','') },
      body: JSON.stringify({ ...signupPolicyFixture, name: 'Second reviewer',email,password }) });
    const third = await json<{ user: { id: string } }>(signup);
    await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1',[third.user.id]);
    const tokenC = await f.account.tokenFor({ email,password },'openid work:read work:correct work:review');
    const principalC = randomUUID();
    await f.accessPool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)`,
      [principalC,f.account.issuer,third.user.id]);
    for (const [agent,principal] of [[f.actor,f.principalId],[otherActorA,f.principalId],[actorB,f.otherPrincipal],[actorC,principalC]]) {
      await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent') ON CONFLICT DO NOTHING",[agent]);
      await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`,[randomUUID(),principal,agent]);
    }
    const roleFamily = randomUUID();
    const bootstrap = await f.accessPool.connect();
    try {
      await bootstrap.query('BEGIN');
      await bootstrap.query(`INSERT INTO access.role_family (id,owner_subject,scope_id,head_revision)
        VALUES ($1,$2,'work:create:root',1)`,[roleFamily,f.actor]);
      // Migration 878 keeps all prior permissions while admitting appointed reviewers.
      await bootstrap.query(`INSERT INTO access.role_revision (family_id,revision,permissions)
        VALUES ($1,1,ARRAY['work.create','work.edit','work.review'])`,[roleFamily]);
      await bootstrap.query('COMMIT');
    } catch (error) { await bootstrap.query('ROLLBACK'); throw error; } finally { bootstrap.release(); }
    const bind = async (agent: string) => {
      const id = randomUUID();
      await f.accessPool.query(`INSERT INTO access.role_binding (id,family_id,role_revision,issuer_subject,recipient_subject,valid_until,assigned_by_principal)
        VALUES ($1,$2,1,$3,$4,'infinity',$5)`,[id,roleFamily,f.actor,agent,f.principalId]); return id;
    };
    const bindingB = await bind(actorB), bindingC = await bind(actorC); await bind(otherActorA);
    // Bootstrap the controlled author's native Agent before using the current
    // own-work creation API. Both Works remain private until publication.
    await createAgentGraph(f.env,{ id: randomUUID(),agent: f.actor,kind: 'person',displayName: 'Editorial author',digest: hash(f.actor) });
    const work = await json<Work>(await request('POST','/v1/works',{ profile: 'metadata-only-v1',authoring: 'own-work',title: 'Initial Work',language: 'en',
      semanticTypes: ['https://schema.org/Book'],actingSubject: f.actor }),201);
    await f.grant(`work:read:${work.work}`,'work.read');
    await f.grant(`semantic:read:${work.work}`,'semantic.read');
    // Bootstrap fixture Agents have no personal-Agent baseline; give only the
    // disclosure capability the semantic owner checks for referenced targets.
    for (const [agent,principal] of [[actorB,f.otherPrincipal],[actorC,principalC]]) {
      await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'work.read','infinity')`,[randomUUID(),principal,agent]);
      await f.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'work.read','infinity')`,[randomUUID(),f.actor,agent,`work:read:${work.work}`]);
    }
    await f.grant(`contribution:create:${work.work}`,'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await request('POST','/v1/contributions',{
      profile: 'text-contribution-v1',work: work.work,language: 'en',body: 'Public catalogue fixture.',actingSubject: f.actor }),201);
    await f.grant(`contribution:publish:${draft.contribution}`,'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`,'contribution.read');
    const publication = await json<{ publicationDecision: string }>(await request('POST','/v1/contribution-publications',{
      profile: 'text-publication-v1',contribution: draft.contribution,expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,rightsBasis: 'original-contribution',disclosure: 'public',actingSubject: f.actor }),201);
    await f.grant(`publication:select:${work.mainVersion}`,'publication.select');
    await json(await request('POST','/v1/publication-selections',{ profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default',id: work.mainVersion },work: work.work,contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,expectedSelectionHead: null,selectionBasis: 'main-maintainer',actingSubject: f.actor }),201);
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const target = { resource: work.work,revision: work.workRevision,context: 'urn:rezics:context:global' };
    const headerState = (description: string) => checkedMetadataState({ kind: 'header',originalTitle: { value: 'Reviewed Work',language: 'en' },
      localized: [{ language: 'en',title: null,description,mainVersionLabel: null }] });
    const component = metadataComponent(work.work,checkedMetadataState(headerState('First synopsis')));
    const base = [{ component,head: null }];
    const evidence = [{ resource: work.work,revision: work.workRevision,locator: 'synopsis/source' }];
    const propose = (candidate: unknown,baseHeads: BaseHead[],key = randomUUID()) => request('POST','/v1/editorial/proposals',{
      profile: 'editorial-proposal-create-v1',kind: 'component-correction',target,candidate,baseHeads,evidence,actingSubject: f.actor },f.account.tokenA,key)
      .then(r => json<Command>(r,201));
    const review = (id: string,revision: number,outcome: string,agent = actorB,token = tokenB,message = 'Review rationale') =>
      request('POST',path(id,'/reviews'),{ profile: 'editorial-proposal-review-v1',revision,outcome,message,actingSubject: agent },token);
    const decide = (id: string,revision: number,approve = true,key = randomUUID(),agent = actorB,token = tokenB,outcome = 'applied') =>
      request('POST',path(id,'/decisions'),{ profile: 'editorial-proposal-decide-v1',revision,outcome,approve,message: 'Checked evidence',actingSubject: agent },token,key);
    const revise = (id: string,revision: number,candidate: unknown,baseHeads: BaseHead[]) => request('POST',path(id,'/revisions'),{
      profile: 'editorial-proposal-revise-v1',revision,candidate,baseHeads,evidence,actingSubject: f.actor });
    // A Work-specific read grant is disclosure, not an editorial edit permit.
    // Neither an appointed global role nor a global-context review grant may
    // change a private Work unless that reviewer also holds its edit authority.
    const privateWork = await json<Work>(await request('POST','/v1/works',{ profile: 'metadata-only-v1',
      authoring: 'own-work',title: 'Private Work',language: 'en',semanticTypes: ['https://schema.org/Book'],actingSubject: f.actor }),201);
    await f.grant(`work:read:${privateWork.work}`,'work.read');
    for (const agent of [actorB,actorC]) await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$3,$4,'work.read','infinity')`,
    [randomUUID(),f.actor,agent,`work:read:${privateWork.work}`]);
    await f.accessPool.query('UPDATE access.role_binding SET active = false WHERE id = $1',[bindingC]);
    const contextScope = 'editorial:review:urn:rezics:context:global', contextGrant = randomUUID();
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',[contextScope]);
    await f.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'work.review','infinity')`,[contextGrant,f.actor,actorC,contextScope]);
    const privateComponent = metadataComponent(privateWork.work,checkedMetadataState(headerState('Private synopsis')));
    const privateCandidate = { command: 'work-metadata',state: headerState('Private synopsis') };
    const privateProposal = await json<Command>(await request('POST','/v1/editorial/proposals',{
      profile: 'editorial-proposal-create-v1',kind: 'component-correction',
      target: { resource: privateWork.work,revision: privateWork.workRevision,context: target.context },
      candidate: privateCandidate,baseHeads: [{ component: privateComponent,head: null }],evidence: [],actingSubject: f.actor }),201);
    await json(await request('GET',path(privateProposal.proposal),undefined,null),404);
    for (const [agent,token] of [[actorB,tokenB],[actorC,tokenC]]) {
      const visible = await get(privateProposal.proposal,token,agent);
      expect(visible.revision.candidate).toEqual(privateCandidate);
      expect(visible.allowedActions).toEqual([]);
      expect(visible.blockers.map(b => b.code)).toContain('review_authority_required');
      expect((await json<{ blocker: { code: string } }>(await review(privateProposal.proposal,1,'approve',agent,token),403))
        .blocker.code).toBe('review_authority_required');
      expect((await json<{ blocker: { code: string } }>(await decide(privateProposal.proposal,1,true,randomUUID(),agent,token),403))
        .blocker.code).toBe('review_authority_required');
    }
    expect(headerWrites).toBe(0);
    const privateEditScope = `work:edit:${privateWork.work}`;
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',[privateEditScope]);
    const privateEdits = [randomUUID(),randomUUID()];
    for (const [index,agent] of [actorB,actorC].entries()) await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$3,$4,'work.edit','infinity')`,
    [privateEdits[index],f.actor,agent,privateEditScope]);
    await json(await review(privateProposal.proposal,1,'approve',actorC,tokenC));
    await json(await review(privateProposal.proposal,1,'approve'));
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',[privateEdits[0]]);
    // The latest ineligible approval must not hide an older eligible one from
    // the bounded approval query. Revocation changes both counts and actions.
    const privateRead = await get(privateProposal.proposal,tokenB,actorB);
    expect(privateRead.approvalIds).toHaveLength(1); expect(privateRead.allowedActions).toEqual([]);
    const privateApplied = await json<Command>(await decide(privateProposal.proposal,1,false,randomUUID(),actorC,tokenC));
    expect(privateApplied.receipt?.candidate).toEqual(privateCandidate); expect(headerWrites).toBe(1);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',[contextGrant]);
    await bind(actorC);
    const beforeHeaderJourney = headerWrites;
    const created = await propose({ command: 'work-metadata',state: headerState('First synopsis') },base);
    // Ordinary reads, including the receipt-only recovery route with no pending
    // application, never acquire the mutation's exclusive proposal lock.
    const held = await f.accessPool.connect();
    try {
      await held.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`editorial:${created.proposal}`]);
      await withoutWaitingForDelivery(Promise.all([get(created.proposal),request('POST',path(created.proposal,'/recovery'),
        { profile: 'editorial-proposal-recover-v1' },null).then(r => json<Read>(r))]));
    } finally {
      await held.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`editorial:${created.proposal}`]); held.release();
    }
    await json(await review(created.proposal,1,'request_changes'));
    expect((await get(created.proposal)).state).toBe('changes_requested');
    await json(await review(created.proposal,1,'approve',actorC,tokenC));
    expect((await get(created.proposal,tokenB,actorB)).allowedActions).toContain('apply');
    await json(await revise(created.proposal,1,{ command: 'work-metadata',state: headerState('Revised synopsis') },base));
    const revised = await get(created.proposal,tokenB,actorB);
    expect(revised.approvalIds).toEqual([]); expect(revised.staleApprovalIds).toHaveLength(1);
    expect(revised.allowedActions).toContain('approve-and-apply');
    expect(revised.revision.evidence).toEqual(evidence);
    expect((await json<{ blocker: { code: string } }>(await decide(created.proposal,2,false),409)).blocker.code).toBe('required_approvals');
    expect((await json<{ blocker: { code: string } }>(await review(created.proposal,2,'approve',otherActorA,f.account.tokenA),403)).blocker.code).toBe('self_review');
    // A current controller of the proposer is also dependent, across Accounts.
    const sharedControl = randomUUID();
    await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`,[sharedControl,principalC,f.actor]);
    expect((await json<{ blocker: { code: string } }>(await review(created.proposal,2,'approve',actorC,tokenC),403)).blocker.code).toBe('self_review');
    await f.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1',[sharedControl]);
    // Revision 2 uses appointed review authority, with no ordinary edit OAuth scope.
    const applyKey = randomUUID();
    const applied = await json<Command>(await decide(created.proposal,2,true,applyKey));
    expect(applied.receipt?.beforeHeads).toEqual(base); expect(headerWrites - beforeHeaderJourney).toBe(1);
    const replay = await json<Command>(await decide(created.proposal,2,true,applyKey));
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(applied.receipt);
    expect((await json<{ blocker: { code: string } }>(await decide(created.proposal,2),409)).blocker.code).toBe('terminal_decision');
    const metadata = () => request('GET',`/v1/works/${shortId(work.work)}/metadata`,undefined,null)
      .then(r => json<{ revision: string; originalTitle: unknown; localized: Array<{ description: string }> }>(r));
    expect((await metadata()).localized[0]?.description).toBe('Revised synopsis');
    // Compensation creates a new proposal and restores the retained owner state.
    const revertKey = randomUUID();
    const reversal = await json<Command>(await request('POST',path(created.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence,actingSubject: f.actor },f.account.tokenA,revertKey),201);
    expect((await get(reversal.proposal)).proposal.reverts).toBe(created.proposal);
    await json(await decide(reversal.proposal,1));
    expect((await metadata()).localized).toEqual([]);
    const replayReversal = await json<Command>(await request('POST',path(created.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence,actingSubject: f.actor },f.account.tokenA,revertKey));
    expect(replayReversal.proposal).toBe(reversal.proposal);
    // Real head movement refuses apply, keeps the candidate, and permits revision.
    const movedBase = [{ component,head: (await metadata()).revision }];
    const stale = await propose({ command: 'work-metadata',state: headerState('Retained candidate') },movedBase);
    await f.grant(`work:edit:${work.work}`,'work.edit');
    const moved = await json<{ revision: string }>(await request('PUT',`/v1/works/${shortId(work.work)}/metadata`,{
      profile: 'work-metadata-details-v1',expectedHead: movedBase[0]!.head,state: headerState('Concurrent header'),actingSubject: f.actor }));
    expect((await json<{ blocker: { code: string } }>(await decide(stale.proposal,1),409)).blocker.code).toBe('stale_base');
    expect((await get(stale.proposal)).proposal.decision).toBeNull();
    await json(await revise(stale.proposal,1,{ command: 'work-metadata',state: headerState('Retained candidate') },[{ component,head: moved.revision }]));
    await json(await decide(stale.proposal,2));
    // A semantic component attaches to this same Work IRI, with no Work-owner predicates.
    const semanticState = (lexical: string) => ({ component: 'resource',types: [],lifecycle: 'active',
      properties: [{ predicate: 'https://example.test/catalogue/fact',value: { kind: 'string',lexical } }] });
    const semantic = await propose({ command: 'semantic-change',state: semanticState('Reviewed fact') },[{ component: work.work,head: work.workRevision }]);
    // The review role includes Work edits, but cannot substitute for the
    // semantic owner's ordinary target permission (shared kernel conformance).
    const deniedSemantic = await json<{ blocker: { code: string } }>(await decide(semantic.proposal,1),403);
    expect(deniedSemantic.blocker.code).toBe('owner_authority_required'); expect(semanticWrites).toBe(0);
    expect((await f.accessPool.query(`SELECT o.outcome FROM access.editorial_application_outcome o
      JOIN access.editorial_application a ON a.id = o.application WHERE a.proposal = $1`,[semantic.proposal])).rows)
      .toEqual([]); // Preflight denies before retaining an application intent.
    await f.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',[`semantic:edit:${work.work}`]);
    for (const [agent,principal] of [[actorB,f.otherPrincipal],[actorC,principalC]]) {
      await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'semantic.change','infinity')`,[randomUUID(),principal,agent]);
      await f.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'semantic.change','infinity')`,[randomUUID(),f.actor,agent,`semantic:edit:${work.work}`]);
    }
    await json(await revise(semantic.proposal,1,{ command: 'semantic-change',state: semanticState('Reviewed fact') },
      [{ component: work.work,head: work.workRevision }]));
    const semanticReceipt = await json<Command>(await decide(semantic.proposal,2));
    expect(semanticReceipt.receipt?.afterHeads[0]?.component).toBe(work.work); expect(semanticWrites).toBe(1);
    const reversedSemantic = await json<Command>(await request('POST',path(semantic.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence,actingSubject: f.actor }),201);
    await json(await decide(reversedSemantic.proposal,1));
    const semanticRead = await json<{ state: { properties: unknown[] } }>(await request('GET',
      `/v1/semantic/resources/${shortId(work.work)}?actingSubject=${encodeURIComponent(f.actor)}`));
    expect(semanticRead.state.properties).toEqual([]);
    // Two decisions serialize; same-key replay and new-key rejection make one effect.
    const concurrent = await propose({ command: 'work-metadata',state: headerState('Concurrent decision') },[{ component,head: (await metadata()).revision }]);
    const beforeConcurrent = headerWrites;
    const concurrentResponses = await Promise.all([decide(concurrent.proposal,1),decide(concurrent.proposal,1)]);
    expect(concurrentResponses.map(r => r.status).sort()).toEqual([200,409]); expect(headerWrites - beforeConcurrent).toBe(1);
    // The pending intent is readable while decide holds the exclusive lock and
    // waits for its owner. Recovery reports pending without cancelling/redelivery.
    const delivering = await propose({ command: 'work-metadata',state: headerState('Delivery barrier') },
      [{ component,head: (await metadata()).revision }]);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    ownerBarrier = { entered: () => entered.resolve(),released: released.promise };
    const beforeDelivery = headerWrites, delivery = decide(delivering.proposal,1);
    try {
      await Promise.race([entered.promise,delivery.then(() => { throw new Error('Owner delivery did not reach its barrier'); })]);
      const reads = await withoutWaitingForDelivery(Promise.all([get(delivering.proposal),get(delivering.proposal,tokenB,actorB),
        request('POST',path(delivering.proposal,'/recovery'),{ profile: 'editorial-proposal-recover-v1' },null).then(r => json<Read>(r,202))]));
      for (const read of reads) {
        expect(read.proposal.decision).toBeNull(); expect(read.allowedActions).toEqual(['recover']);
        expect(read.blockers.map(b => b.code)).toContain('apply_pending');
      }
      expect(headerWrites - beforeDelivery).toBe(1);
    } finally { released.resolve(); await json<Command>(await delivery); }
    expect((await get(delivering.proposal)).state).toBe('applied');
    // A lost graph response leaves a durable pending intent, including across restart.
    const lost = await propose({ command: 'work-metadata',state: headerState('Lost response candidate') },[{ component,head: (await metadata()).revision }]);
    const lostKey = randomUUID(), beforeLost = headerWrites; loseOwnerResponse = true;
    expect((await json<Command>(await decide(lost.proposal,1,true,lostKey),202)).outcome).toBe('apply_pending');
    expect((await get(lost.proposal)).allowedActions).toEqual(['recover']);
    const permitId = (await f.accessPool.query<{ id: string }>('SELECT id FROM access.editorial_application WHERE proposal = $1',[lost.proposal])).rows[0]!.id;
    const reviewerPrincipal = await f.account.verifier.verify(new Request('http://main.local',{
      headers: { authorization: `Bearer ${tokenB}` } }),['work:review']);
    await expect(f.access.register({ principal: reviewerPrincipal,actingSubject: actorB,editorialPermit: permitId,
      action: 'work.edit',scope: `work:edit:${work.work}`,idempotencyKey: `editorial:${lost.proposal}:1`,requestDigest: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    expect((await json<{ blocker: { code: string } }>(await revise(lost.proposal,1,{ command: 'work-metadata',state: headerState('Illegal overwrite') },base),409))
      .blocker.code).toBe('apply_pending');
    // Review authority can be revoked after committed effect but before receipt delivery.
    await f.accessPool.query('UPDATE access.role_binding SET active = false WHERE id = $1',[bindingB]);
    deps.editorialReview = new EditorialReviewStore(f.accessPool); app = createMainApp(graph,deps); hideReceipts = false;
    const recovered = await json<Read>(await request('POST',path(lost.proposal,'/recovery'),{ profile: 'editorial-proposal-recover-v1' },null));
    expect(recovered.state).toBe('applied'); expect(recovered.proposal.decision?.receipt?.candidate).toEqual(recovered.revision.candidate);
    const lostReplay = await json<Command>(await decide(lost.proposal,1,true,lostKey));
    expect(lostReplay.receipt).toEqual(recovered.proposal.decision?.receipt); expect(headerWrites - beforeLost).toBe(1);
    const ownerAdmission = (await f.accessPool.query<{ admission: string; state: string }>(`SELECT e.admission,a.state
      FROM access.editorial_owner_admission e JOIN access.editorial_application app ON app.id = e.application
      JOIN access.admission a ON a.id = e.admission WHERE app.proposal = $1`,[lost.proposal])).rows[0]!;
    expect(ownerAdmission.state).toBe('sealed');
    // A revoked steward cannot review/apply a fresh candidate even with an old token.
    const withdrawn = await propose({ command: 'work-metadata',state: headerState('Withdrawn candidate') },[{ component,head: (await metadata()).revision }]);
    expect((await json<{ blocker: { code: string } }>(await decide(withdrawn.proposal,1),403)).blocker.code).toBe('review_authority_required');
    await json(await request('POST',path(withdrawn.proposal,'/withdrawal'),{ profile: 'editorial-proposal-withdraw-v1',revision: 1,actingSubject: f.actor }));
    expect((await get(withdrawn.proposal)).state).toBe('withdrawn');
    const rejected = await propose({ command: 'work-metadata',state: headerState('Rejected candidate') },[{ component,head: (await metadata()).revision }]);
    await json(await decide(rejected.proposal,1,false,randomUUID(),actorC,tokenC,'rejected'));
    expect((await get(rejected.proposal)).state).toBe('rejected');
    // Crash after intent, before registration: the registration lock proves safe cancellation.
    const interrupted = await propose({ command: 'work-metadata',state: headerState('Interrupted candidate') },[{ component,head: (await metadata()).revision }]);
    const interruptedKey = randomUUID();
    await f.accessPool.query(`INSERT INTO access.editorial_application
      (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,message,required)
      VALUES ($1,$2,1,$3,$4,$5,$6,$7,true,'Interrupted',1)`,[randomUUID(),interrupted.proposal,principalC,actorC,
      `editorial:${interrupted.proposal}:1`,interruptedKey,'0'.repeat(64)]);
    const cancelled = await json<Read>(await request('POST',path(interrupted.proposal,'/recovery'),{ profile: 'editorial-proposal-recover-v1' },null));
    expect(cancelled.proposal.decision).toBeNull(); expect(cancelled.blockers.map(b => b.code)).toContain('revision_required');
    await json(await revise(interrupted.proposal,1,{ command: 'work-metadata',state: headerState('Recovered candidate') },[{ component,head: (await metadata()).revision }]));
    // SQL append/immutability guards cover alternate entry points, not just routes.
    await expect(f.accessPool.query('UPDATE access.editorial_revision SET candidate = candidate WHERE proposal = $1',[created.proposal]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(f.accessPool.query(`INSERT INTO access.editorial_review
      (id,proposal,revision,principal,reviewer,reviewer_key,outcome,message) VALUES ($1,$2,1,$3,$4,$5,'approve','Old revision')`,
    [randomUUID(),interrupted.proposal,principalC,actorC,independenceKey(interrupted.proposal,principalC)]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(f.accessPool.query(`INSERT INTO access.editorial_decision (proposal,revision,principal,actor,outcome)
      VALUES ($1,2,$2,$3,'rejected')`,[created.proposal,principalC,actorC])).rejects.toMatchObject({ code: '23514' });
    // A 51-entry inventory is a page boundary, not a product history cap.
    for (let i = 0; i < 51; i++) await json(await review(interrupted.proposal,2,'comment',actorC,tokenC,`History ${i}`));
    const historyFirst = await get(interrupted.proposal,null,undefined,'limit=50');
    expect(historyFirst.timeline).toHaveLength(50); expect(historyFirst.nextCursor).not.toBeNull();
    const historyNext = await get(interrupted.proposal,null,undefined,`limit=50&cursor=${historyFirst.nextCursor}`);
    expect(historyFirst.timeline.length + historyNext.timeline.length).toBe(54);
    expect(new Set([...historyFirst.timeline,...historyNext.timeline].map(event => event.sequence)).size).toBe(54);
    // Pages bind to selection and stop at fifty; timeline resumes without repeats.
    const first = await get(created.proposal,null,undefined,'limit=2'); expect(first.timeline).toHaveLength(2); expect(first.nextCursor).not.toBeNull();
    const next = await get(created.proposal,null,undefined,`limit=2&cursor=${first.nextCursor}`);
    expect(next.timeline[0]!.sequence).not.toBe(first.timeline[0]!.sequence);
    await json(await request('GET',path(rejected.proposal) + `?cursor=${first.nextCursor}`,undefined,null),400);
    const queue = await json<{ items: Array<{ id: string }>; nextCursor: string | null }>(await request('GET',
      `/v1/editorial/proposals?filter=mine&actingSubject=${encodeURIComponent(f.actor)}&limit=2`));
    expect(queue.items).toHaveLength(2); expect(queue.nextCursor).not.toBeNull();
    const byTarget = await json<{ items: unknown[] }>(await request('GET',
      `/v1/editorial/proposals?filter=target&target=${encodeURIComponent(work.work)}&limit=50`,undefined,null));
    expect(byTarget.items.length).toBeGreaterThan(5);
    // Hook events are durable, ordered by commit, and retain attribution after revocation.
    const events = await deps.editorialReview.eventsAfter('0',50);
    expect(events.some(event => event.kind === 'revised')).toBe(true); expect(events.some(event => event.kind === 'applied')).toBe(true);
    expect(events.every((event,i) => i === 0 || BigInt(event.sequence) > BigInt(events[i - 1]!.sequence))).toBe(true);
    expect((await deps.editorialReview.eventsAfter(events.at(-1)!.sequence,50)).some(event => event.sequence === events.at(-1)!.sequence)).toBe(false);
    await replacementController(f.accessPool,f.actor);
    await f.accessPool.query("UPDATE access.representation SET active = false WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'",
      [f.principalId,f.actor]);
    const history = await get(created.proposal);
    expect(history.proposal.proposer).toBe(f.actor); expect(history.proposal.decision?.receipt).toEqual(applied.receipt);
    expect(history.timeline.some(event => event.actor === f.actor)).toBe(true);
    await json(await request('POST',path(interrupted.proposal,'/withdrawal'),{ profile: 'editorial-proposal-withdraw-v1',revision: 2,actingSubject: f.actor }),403);
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(f.principalId); expect(serialized).not.toContain(independenceKey(created.proposal,f.principalId));
  } finally { await accountPool.end(); await f.close(); rmSync(directory,{ recursive: true,force: true }); }
},240_000);
