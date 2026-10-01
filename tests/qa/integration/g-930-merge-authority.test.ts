import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

async function checked<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

// Copied from G922-H2. The fixed boundary refuses this pair at proposal, before
// either source-only human can redirect it. G-922's shared todo stays untouched.
test('G922-H2: two source reviewers cannot merge a public Work into a private survivor they can only read', async () => {
  const f = await startMediaStack('g-930-counterexample', { profileCredits: true });
  try {
    const proposer = await f.member('proposer'), first = await f.member('first-human'),
      second = await f.member('second-human'), owner = await f.member('private-owner');
    const people = [proposer, first, second, owner];
    for (const person of people) await person.grant(`agent:self:${person.actor}`, 'agent.control');
    const tokens = new Map(people.map(person => [person.token, person.principal]));
    const app = createMainApp(f.fuseki, {
      environment: f.env, access: f.access,
      account: { verify: async request => {
        const principal = tokens.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
        if (!principal) throw new Error('Unknown QA bearer');
        return principal;
      } },
      identityMerge: { accessPool: f.accessPool, contentPool: f.contentPool },
      editorialReview: new EditorialReviewStore(f.accessPool),
    });
    const call = (path: string, body: object, token: string, key = randomUUID()) => app.handle(
      new Request(`http://main.local${path}`, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key,
      }, body: JSON.stringify(body) }));
    const source = await f.publicWork(proposer.actor, ['en'], 'G922 public duplicate');
    const survivor = await f.privateWork(owner.actor, 'G922 private original');
    for (const person of [proposer, first, second]) await person.grant(`work:read:${survivor.work}`, 'work.read');
    for (const person of [first, second]) await person.grant(`work:review:${source.work}`, 'work.review');
    expect((await f.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE scope_id=$1 AND action='work.edit' AND recipient_subject=ANY($2::text[])`,
    [`work:edit:${survivor.work}`, [first.actor, second.actor]])).rows).toEqual([]);
    const heads = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE { GRAPH <${GRAPHS.current}> {
      VALUES ?work { <${source.work}> <${survivor.work}> } ?work rv:head ?head } }`)).results!.bindings;
    const revision = (work: string) => heads.find(row => row.work!.value === work)!.head!.value;
    const candidate = { operation: 'merge', source: { resource: source.work, revision: revision(source.work) },
      survivor: { resource: survivor.work, revision: revision(survivor.work) },
      evidence: [{ resource: source.work, revision: revision(source.work), locator: 'title-and-grain' }] };
    const proposed = await call('/v1/editorial/proposals', {
      profile: 'editorial-proposal-create-v1', kind: 'merge', target: { resource: source.work,
        revision: revision(source.work), context: 'urn:rezics:context:global' }, candidate,
      baseHeads: heads.map(row => ({ component: row.work!.value, head: row.head!.value })),
      evidence: candidate.evidence, actingSubject: proposer.actor,
    }, proposer.token);
    expect(proposed.status).toBe(400);
    expect((await f.accessPool.query('SELECT 1 FROM access.editorial_proposal WHERE resource=$1',[source.work])).rowCount).toBe(0);
    const redirect = await f.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      <${source.work}> rv:mergedInto <${survivor.work}> } }`);
    expect(redirect.boolean, 'Read-only survivor access cannot authorize cross-owner identity/person-state changes').toBe(false);
  } finally { await f.stop(); }
}, 180_000);

type Member = Awaited<ReturnType<Awaited<ReturnType<typeof startMediaStack>>['member']>>;
type Command = { proposal: string; revision: number; outcome: string; receipt?: OwnerReceipt };
async function mergeWorld(label: string) {
  const f = await startMediaStack(label, { profileCredits: true });
  try {
    const proposer = await f.member('proposer'), first = await f.member('first'), second = await f.member('second'),
      older = await f.member('older'), owner = await f.member('owner');
    const people = [proposer,first,second,older,owner];
    for (const person of people) await person.grant(`agent:self:${person.actor}`,'agent.control');
    const tokens = new Map(people.map(person => [person.token,person.principal]));
    let afterIntent: (() => Promise<void>) | undefined;
    const editorialPool = new Proxy(f.accessPool,{ get(pool,property) {
      if (property === 'connect') return async () => {
        const client = await pool.connect();
        let intent = false;
        return new Proxy(client,{ get(connection,key) {
          if (key === 'query') return async (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (sql.includes('INSERT INTO access.editorial_application\n')) intent = true;
            const result: unknown = await Reflect.apply(connection.query,connection,args);
            if (sql === 'COMMIT' && intent && afterIntent) {
              const callback = afterIntent; afterIntent = undefined;
              await callback();
            }
            return result;
          };
          const value: unknown = Reflect.get(connection,key,connection);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      const value: unknown = Reflect.get(pool,property,pool);
      return typeof value === 'function' ? value.bind(pool) : value;
    } });
    const store = new EditorialReviewStore(editorialPool);
    const app = createMainApp(f.fuseki,{ environment: f.env,access: f.access,
      account: { verify: async request => {
        const principal = tokens.get(request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '');
        if (!principal) throw new Error('Unknown QA bearer');
        return principal;
      } },identityMerge: { accessPool: f.accessPool,contentPool: f.contentPool },editorialReview: store,
      libraryStatus: new ReaderLibraryStatusStore(f.contentPool) });
    const source = await f.catalogueWork(proposer.actor,'G930 source'), survivor = await f.catalogueWork(owner.actor,'G930 survivor');
    await f.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(source.work)} rv:catalogueVisible true . ${iri(survivor.work)} rv:catalogueVisible true } }`);
    const heads = async () => (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { VALUES ?work { ${iri(source.work)} ${iri(survivor.work)} } ?work rv:head ?head } }`)).results!.bindings
      .map(row => ({ component: row.work!.value,head: row.head!.value }));
    const originalHeads = await heads(), pin = (resource: string) => ({ resource,
      revision: originalHeads.find(head => head.component === resource)!.head });
    const evidence = [{ ...pin(source.work),locator: 'matching title and grain' }];
    const candidate = { operation: 'merge',source: pin(source.work),survivor: pin(survivor.work),evidence };
    const target = { ...pin(source.work),context: 'urn:rezics:context:global' };
    const call = (method: string,path: string,body?: object,person = proposer,key = randomUUID()) => app.handle(
      new Request(`http://main.local${path}`,{ method,headers: { authorization: `Bearer ${person.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),'idempotency-key': key },
      ...(body ? { body: JSON.stringify({ ...body,actingSubject: person.actor }) } : {}) }));
    const path = (proposal: string,suffix = '') => `/v1/editorial/proposals/${proposal}${suffix}`;
    const propose = (plan: object = candidate) => call('POST','/v1/editorial/proposals',{
      profile: 'editorial-proposal-create-v1',kind: 'merge',target,candidate: plan,baseHeads: originalHeads,evidence });
    const review = (proposal: string,person: Member,revision = 1) => call('POST',path(proposal,'/reviews'),{
      profile: 'editorial-proposal-review-v1',revision,outcome: 'approve',message: 'Reviewed both identities' },person);
    const decide = (proposal: string,person = second,approve = false,key = randomUUID(),revision = 1) => call('POST',path(proposal,'/decisions'),{
      profile: 'editorial-proposal-decide-v1',revision,outcome: 'applied',approve,message: 'Reviewed pair' },person,key);
    const read = async (proposal: string,person = second) => checked<{ state: string; approvalIds: string[];
      blockers: { code: string }[]; allowedActions: string[] }>(await call('GET',`${path(proposal)}?actingSubject=${encodeURIComponent(person.actor)}`,undefined,person));
    const redirect = async () => (await f.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(source.work)} rv:mergedInto ${iri(survivor.work)} } }`)).boolean;
    const permission = (person: Member,work: string,action: 'work.review'|'work.edit',active: boolean) => f.accessPool.query(
      'UPDATE access.permission_grant SET active=$1 WHERE recipient_subject=$2 AND scope_id=$3 AND action=$4',
      [active,person.actor,`${action === 'work.edit' ? 'work:edit' : 'work:review'}:${work}`,action]);
    const grant = async (person: Member,work: string) => {
      await person.grant(`work:read:${work}`,'work.read');
      await person.grant(`work:review:${work}`,'work.review');
      await person.grant(`work:edit:${work}`,'work.edit');
    };
    const finish = async (proposal: string,person = second,key = randomUUID(),revision = 1) => {
      for (let n = 0; n < 16; n++) {
        const response = await decide(proposal,person,false,key,revision);
        const result = await checked<Command>(response,response.status === 202 ? 202 : 200);
        if (response.status === 200) { expect(result.outcome).toBe('applied'); return result; }
      }
      throw new Error('Merge did not finish within the bounded retries');
    };
    return { f,proposer,first,second,older,owner,source,survivor,people,candidate,target,heads,call,path,
      propose,review,decide,read,redirect,permission,grant,finish,
      afterIntent: (callback: () => Promise<void>) => { afterIntent = callback; } };
  } catch (error) { await f.stop(); throw error; }
}

test('G930: proposal, approval and apply require review and owner authority on each public Work', async () => {
  const w = await mergeWorld('g-930-boundaries');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    // Native owner fixture data: this test exercises merge dispatch, while the
    // baseline reader provisioning journey belongs to the library suite.
    const library = new ReaderLibraryStatusStore(w.f.contentPool);
    for (const person of [w.first,w.second]) await library.write({ agent: person.actor,work: w.source.work,
      status: 'read',expectedVersion: 0,idempotencyKey: randomUUID() });
    for (const work of [w.source.work,w.survivor.work]) for (const action of ['work.review','work.edit'] as const) {
      await w.permission(w.proposer,work,action,false);
      const denied = await checked<{ blocker: { code: string } }>(await w.propose(),403);
      expect(denied.blocker.code).toBe(action === 'work.edit' ? 'owner_authority_required' : 'review_authority_required');
      await w.permission(w.proposer,work,action,true);
    }
    expect((await w.f.accessPool.query('SELECT 1 FROM access.editorial_proposal WHERE resource=$1',[w.source.work])).rowCount).toBe(0);
    const proposal = await checked<Command>(await w.propose(),201);
    for (const work of [w.source.work,w.survivor.work]) for (const action of ['work.review','work.edit'] as const) {
      await w.permission(w.first,work,action,false);
      expect((await w.review(proposal.proposal,w.first)).status).toBe(403);
      expect((await w.read(proposal.proposal,w.first)).allowedActions).not.toContain('review');
      await w.permission(w.first,work,action,true);
    }
    await checked(await w.review(proposal.proposal,w.first));
    await checked(await w.review(proposal.proposal,w.second));
    expect((await w.read(proposal.proposal)).approvalIds).toHaveLength(2);
    for (const work of [w.source.work,w.survivor.work]) for (const action of ['work.review','work.edit'] as const) {
      await w.permission(w.first,work,action,false);
      const revoked = await w.read(proposal.proposal);
      expect(revoked.approvalIds).toHaveLength(1);
      expect(revoked.allowedActions).not.toContain('apply');
      expect((await w.decide(proposal.proposal)).status).toBe(409);
      expect(await w.redirect()).toBe(false);
      await w.permission(w.first,work,action,true);
      await w.permission(w.second,work,action,false);
      expect((await w.decide(proposal.proposal)).status).toBe(403);
      await w.permission(w.second,work,action,true);
    }
    expect((await w.f.accessPool.query('SELECT 1 FROM access.editorial_application WHERE proposal=$1',[proposal.proposal])).rowCount).toBe(0);
    const firstRead = w.f.fuseki.queries;
    await w.read(proposal.proposal);
    expect(w.f.fuseki.queries - firstRead).toBeLessThan(64);
    const applied = await w.finish(proposal.proposal);
    expect(applied.receipt?.owner).toMatchObject({ outcomes: { moved: 2 } });
    expect((await w.f.contentPool.query('SELECT status FROM reader.library_status WHERE work=$1',[w.survivor.work])).rows)
      .toEqual([{ status: 'read' },{ status: 'read' }]);
    expect(await w.redirect()).toBe(true);
  } finally { await w.f.stop(); }
},180_000);

test('G930: disclosure changes are rejected at proposal, approval, apply and compensating unmerge', async () => {
  const w = await mergeWorld('g-930-disclosure');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    const disclosure = (isPublic: boolean) => w.f.fuseki.update(`PREFIX rv: <${RV}> ${isPublic ? 'INSERT' : 'DELETE'} DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
    await disclosure(false);
    expect((await w.propose()).status).toBe(400);
    await disclosure(true);
    const proposal = await checked<Command>(await w.propose(),201);
    await checked(await w.review(proposal.proposal,w.first));
    await disclosure(false);
    expect((await w.review(proposal.proposal,w.second)).status).toBe(400);
    expect((await w.decide(proposal.proposal,w.second,true)).status).toBe(400);
    expect(await w.redirect()).toBe(false);
    await disclosure(true);
    await checked(await w.review(proposal.proposal,w.second));
    await w.finish(proposal.proposal);
    await disclosure(false);
    expect((await w.call('POST',w.path(proposal.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence: [] })).status).toBe(400);
    expect(await w.redirect()).toBe(true);
    await disclosure(true);
    const reversal = await checked<Command>(await w.call('POST',w.path(proposal.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence: [] }),201);
    for (const person of [w.first,w.second]) await checked(await w.review(reversal.proposal,person));
    for (const work of [w.source.work,w.survivor.work]) {
      await w.permission(w.first,work,'work.edit',false);
      expect((await w.decide(reversal.proposal)).status).toBe(409);
      expect(await w.redirect()).toBe(true);
      await w.permission(w.first,work,'work.edit',true);
    }
    await w.finish(reversal.proposal);
    expect(await w.redirect()).toBe(false);
  } finally { await w.f.stop(); }
},180_000);

test('G930: revoked newer approvals cannot shadow an older eligible reviewer of both Works', async () => {
  const w = await mergeWorld('g-930-current-basis');
  try {
    for (const person of [w.proposer,w.first,w.second,w.older]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    const proposal = await checked<Command>(await w.propose(),201);
    for (const person of [w.older,w.first,w.second]) await checked(await w.review(proposal.proposal,person));
    await w.permission(w.first,w.survivor.work,'work.edit',false);
    expect((await w.read(proposal.proposal)).approvalIds).toHaveLength(2);
    await w.finish(proposal.proposal);
    expect(await w.redirect()).toBe(true);
  } finally { await w.f.stop(); }
},180_000);

test('G930: revocation after durable apply intent prevents dispatch and preserves the candidate for a fresh revision', async () => {
  const w = await mergeWorld('g-930-dispatch-revocation');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    const proposal = await checked<Command>(await w.propose(),201);
    for (const person of [w.first,w.second]) await checked(await w.review(proposal.proposal,person));
    const key = randomUUID();
    w.afterIntent(async () => { await w.permission(w.second,w.survivor.work,'work.edit',false); });
    expect((await w.decide(proposal.proposal,w.second,false,key)).status).toBe(403);
    expect((await w.f.accessPool.query('SELECT 1 FROM access.editorial_application WHERE proposal=$1',[proposal.proposal])).rowCount).toBe(1);
    expect((await w.f.accessPool.query('SELECT 1 FROM access.identity_merge_task WHERE task_key=$1',
      [`editorial:${proposal.proposal}:1`])).rowCount).toBe(0);
    expect(await w.redirect()).toBe(false);
    expect((await w.decide(proposal.proposal,w.second,false,key)).status).toBe(409);
    await w.permission(w.second,w.survivor.work,'work.edit',true);
    const retained = await checked<{ revision: { candidate: unknown; baseHeads: unknown[] } }>(
      await w.call('GET',`${w.path(proposal.proposal)}?actingSubject=${encodeURIComponent(w.proposer.actor)}`));
    expect(retained.revision.candidate).toEqual(w.candidate);
    await checked(await w.call('POST',w.path(proposal.proposal,'/revisions'),{
      profile: 'editorial-proposal-revise-v1',revision: 1,candidate: retained.revision.candidate,
      baseHeads: retained.revision.baseHeads,evidence: [] }));
    for (const person of [w.first,w.second]) await checked(await w.review(proposal.proposal,person,2));
    await w.finish(proposal.proposal,w.second,randomUUID(),2);
    expect(await w.redirect()).toBe(true);
  } finally { await w.f.stop(); }
},180_000);

test('G930: a publication downgrade between authority preflight and the native graph effect cannot commit a redirect', async () => {
  const w = await mergeWorld('g-930-publication-race');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    const proposal = await checked<Command>(await w.propose(),201);
    for (const person of [w.first,w.second]) await checked(await w.review(proposal.proposal,person));
    const native = w.f.fuseki.commandWithReceipt.bind(w.f.fuseki);
    let downgraded = false;
    w.f.fuseki.commandWithReceipt = async input => {
      if (!downgraded && input.update.includes('rv:mergedInto')) {
        downgraded = true;
        await w.f.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
          ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
      }
      return native(input);
    };
    const key = randomUUID();
    // Ordered delivery retains an uncertain/guarded owner stage as pending;
    // the native receipt and redirect must both remain absent.
    expect((await w.decide(proposal.proposal,w.second,false,key)).status).toBe(202);
    expect(downgraded).toBe(true);
    expect(await w.redirect()).toBe(false);
    expect((await w.f.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt rv:mergeTask "editorial:${proposal.proposal}:1" } }`)).boolean).toBe(false);
    w.f.fuseki.commandWithReceipt = native;
    await w.f.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
    await w.finish(proposal.proposal,w.second,key);
    expect(await w.redirect()).toBe(true);
  } finally { await w.f.stop(); }
},180_000);

test('G930: equally restricted Works can merge and unmerge with explicit authority on both', async () => {
  const w = await mergeWorld('g-930-private-pair');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    await w.f.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(w.source.work)} rv:catalogueVisible true . ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
    const proposal = await checked<Command>(await w.propose(),201);
    for (const person of [w.first,w.second]) await checked(await w.review(proposal.proposal,person));
    await w.finish(proposal.proposal);
    expect(await w.redirect()).toBe(true);
    const reversal = await checked<Command>(await w.call('POST',w.path(proposal.proposal,'/reversal'),{
      profile: 'editorial-proposal-revert-v1',evidence: [] }),201);
    for (const person of [w.first,w.second]) await checked(await w.review(reversal.proposal,person));
    await w.finish(reversal.proposal);
    expect(await w.redirect()).toBe(false);
  } finally { await w.f.stop(); }
},180_000);

test('G930: catalogue owner roles remain valid only while both reviewed Works are public at the native effect', async () => {
  const w = await mergeWorld('g-930-catalogue-role');
  try {
    for (const person of [w.proposer,w.first,w.second]) for (const work of [w.source.work,w.survivor.work]) await w.grant(person,work);
    for (const work of [w.source.work,w.survivor.work]) await w.permission(w.first,work,'work.edit',false);
    const family = randomUUID(),client = await w.f.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
      await client.query(`INSERT INTO access.role_family (id,owner_subject,scope_id,head_revision)
        VALUES ($1,$2,'work:create:root',1)`,[family,w.first.actor]);
      await client.query("INSERT INTO access.role_revision (family_id,revision,permissions) VALUES ($1,1,ARRAY['work.edit'])",[family]);
      await client.query(`INSERT INTO access.role_binding (id,family_id,role_revision,issuer_subject,recipient_subject,valid_until,assigned_by_principal)
        VALUES ($1,$2,1,$3,$3,'infinity',$4)`,[randomUUID(),family,w.first.actor,w.first.principalId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const proposal = await checked<Command>(await w.propose(),201);
    for (const person of [w.first,w.second]) await checked(await w.review(proposal.proposal,person));
    const native = w.f.fuseki.commandWithReceipt.bind(w.f.fuseki);
    let downgraded = false;
    w.f.fuseki.commandWithReceipt = async input => {
      if (!downgraded && input.update.includes('rv:mergedInto')) {
        downgraded = true;
        // The disclosure comparison alone accepts private -> private. The
        // catalogue reviewer's public-only owner proof must also be fenced.
        await w.f.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
          ${iri(w.source.work)} rv:catalogueVisible true . ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
      }
      return native(input);
    };
    const key = randomUUID();
    expect((await w.decide(proposal.proposal,w.second,false,key)).status).toBe(202);
    expect(downgraded).toBe(true);
    expect(await w.redirect()).toBe(false);
    w.f.fuseki.commandWithReceipt = native;
    await w.f.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(w.source.work)} rv:catalogueVisible true . ${iri(w.survivor.work)} rv:catalogueVisible true } }`);
    await w.finish(proposal.proposal,w.second,key);
    expect(await w.redirect()).toBe(true);
  } finally { await w.f.stop(); }
},180_000);
