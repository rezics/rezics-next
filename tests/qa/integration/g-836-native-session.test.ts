import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { canonicalCandidate, EditorialBlocked, EditorialInvalid, type EditorialAdapter, type Proposal } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { EditorialReviewStore, type EditorialCall } from '../../../services/main/src/modules/editorial-review/store.ts';
import { ownerReceipt } from '../../../services/main/src/modules/editorial-review/runtime.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { independenceKey, requireReview, reviewBasis } from '../../../services/main/src/modules/editorial-review/authority.ts';
import { controlTransaction } from '../../../services/main/src/modules/access/topology-control.ts';
import { AccessMergeJournal } from '../../../services/main/src/modules/identity-merge/journal.ts';
import { checkedPlan, itemCommandKey, type MergeTask } from '../../../services/main/src/modules/identity-merge/contract.ts';
import { sessionMergeHandler } from '../../../services/main/src/modules/session/merge-handler.ts';
import type { SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

/** Native retained-attempt coverage and shared Access/Jena review authority.
 * This is deliberately separate from the outstanding SAO public merge journey. */
test('G836: native sessions remain separate, indexed by source and selection, under two independent human reviews', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const graph = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
  const id = () => `https://rezics.com/id/${randomUUID()}`;
  const source = id(), survivor = id(), main = id(), sourceRevision = id(), survivorRevision = id(), selected = id();
  const agents = [id(), id(), id(), id(), id()], principals = [randomUUID(), randomUUID(), randomUUID(), randomUUID()], subjects = principals.map(() => randomUUID());
  const scope = 'editorial:review:urn:rezics:context:global';
  const deps = { contentPool, accessPool, graph }, handler = sessionMergeHandler(deps), journal = new AccessMergeJournal(accessPool);
  try {
    await migrateContent(contentPool);
    const epochRows = (await graph.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing }
    } LIMIT 2`)).results?.bindings ?? [];
    expect(epochRows).toHaveLength(1);
    const epoch = epochRows[0]!.epoch!.value;
    for (let n = 0; n < principals.length; n++) await accessPool.query(`INSERT INTO access.principal
      (id,account_issuer,account_subject) VALUES ($1,'https://g836.example.test',$2)`, [principals[n], subjects[n]]);
    await accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    for (let n = 0; n < agents.length; n++) {
      await accessPool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [agents[n]]);
      await accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), principals[n === 3 ? 1 : n === 4 ? 3 : n], agents[n]]);
      if (n) await accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'work.review','infinity')`, [randomUUID(), agents[0], agents[n], scope]);
    }
    await graph.update(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${agents.map((agent, n) => `${iri(agent)} a rv:Agent ; rv:agentKind rv:${n === 3 ? 'ServiceAgent' : 'PersonAgent'} .`).join('\n')}
      ${iri(source)} a <https://schema.org/CreativeWork> ; rv:mainVersion ${iri(main)} ; rv:head ${iri(sourceRevision)} ;
        rdfs:label "Sword Art Online 1"@en ; rv:catalogueVisible true .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(source)} .
    } }`);
    const plan = checkedPlan({ operation: 'merge', source: { resource: source, revision: sourceRevision },
      survivor: { resource: survivor, revision: survivorRevision }, evidence: [{ resource: source, revision: sourceRevision, locator: null }] });
    const createTask = async (approve: boolean, overlappingHistory = false) => {
      const proposal = randomUUID(), application = randomUUID(), candidate = canonicalCandidate(plan);
      const target = { resource: source, revision: sourceRevision, context: 'urn:rezics:context:global' as const, work: source };
      await accessPool.query(`INSERT INTO access.editorial_proposal
        (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
        VALUES ($1,'merge',$2,$3,$4,$3,$5,$6,$7,ARRAY[$5::uuid])`,
      [proposal, target, source, target.context, principals[0], agents[0], independenceKey(proposal, principals[0]!)]);
      await accessPool.query(`INSERT INTO access.editorial_revision
        (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,owner_command,author_agent)
        VALUES ($1,1,$2,$3,'null',$4,$5,$6,$7)`, [proposal, JSON.stringify(candidate.candidate), candidate.digest,
        JSON.stringify([{ component: source, head: sourceRevision }, { component: survivor, head: survivorRevision }]),
        JSON.stringify(plan.evidence), { action: 'work.edit', scope: `work:edit:${source}`, digest: candidate.digest }, agents[0]]);
      for (const [principal, agent] of overlappingHistory
        ? [[principals[3]!, agents[4]!], [principals[2]!, agents[2]!], [principals[1]!, agents[1]!]]
        : [[principals[1]!, agents[1]!]]) {
        await accessPool.query(`INSERT INTO access.editorial_review
          (id,proposal,revision,principal,reviewer,reviewer_key,outcome,message)
          VALUES ($1,$2,1,$3,$4,$5,'approve','Independent human stance')`,
        [randomUUID(), proposal, principal, agent, independenceKey(proposal, principal!)]);
      }
      await accessPool.query(`INSERT INTO access.editorial_application
        (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
        VALUES ($1::uuid,$2,1,$3,$4,$5,$1::text,$6,$7,2,'Second human')`,
      [application, proposal, principals[2], agents[2], `editorial:${proposal}:1`, candidate.digest, approve]);
      const task: MergeTask = { key: `editorial:${proposal}:1`, application, candidateDigest: candidate.digest, plan, dataEpoch: epoch,
        handlers: [{ owner: handler.owner, version: handler.version }] };
      await journal.locked(task.key, owner => owner.prepare(task));
      const proposalObject: Proposal = { id: proposal, kind: 'merge', target, proposer: agents[0]!,
        proposerKey: independenceKey(proposal, principals[0]!), latestRevision: 1, decision: null };
      return { task, proposal: proposalObject };
    };
    const sessions: SessionState[] = [];
    for (let n = 0; n < 33; n++) {
      const target = { resource: source, base: 'work' as const, work: source, revision: sourceRevision,
        types: ['https://schema.org/Book'], disclosure: 'public' as const };
      const state: SessionState = { id: id(), target, state: 'planned', startedOn: null, finishedOn: null,
        selections: [{ target: { ...target, resource: selected, base: 'realization', revision: id() },
          language: 'en', format: 'ebook', progress: 'locator' }], locators: [], completedAt: null,
        version: 1, createdAt: '2026-10-01T00:00:00Z', changedAt: '2026-10-01T00:00:00Z' };
      await contentPool.query(`INSERT INTO reader.consumption_session
        (id,principal_issuer,principal_subject,agent,work,state,version)
        VALUES ($1,'https://g836.example.test',$2,$3,$4,$5,1)`, [state.id, principals[n % 3], agents[n % 3], source, state]);
      await contentPool.query(`INSERT INTO reader.consumption_session_target
        (session,principal_issuer,principal_subject,agent,resource,attempt_order)
        SELECT id,principal_issuer,principal_subject,agent,$2,attempt_order FROM reader.consumption_session WHERE id=$1`, [state.id, selected]);
      sessions.push(state);
    }
    const denied = await createTask(false), admitted = await createTask(true);
    expect(await handler.preview(plan, deps)).toEqual({ owner: 'session', count: 32, complete: false });
    expect(await handler.preview({ ...plan, source: { resource: selected, revision: sourceRevision } }, deps))
      .toEqual({ owner: 'session', count: 32, complete: false });
    const page = await handler.plan(admitted.task, null, 32, deps);
    expect(page.items).toHaveLength(32);
    const tail = await handler.plan(admitted.task, page.next, 32, deps);
    expect(tail.items).toHaveLength(1);
    expect(new Set([...page.items, ...tail.items].map(item => item.key)).size).toBe(33);
    const item = page.items[0]!;
    await expect(handler.apply(denied.task, item, itemCommandKey(denied.task.key, 'session', item.key), deps))
      .rejects.toBeInstanceOf(EditorialBlocked);
    expect((await contentPool.query('SELECT 1 FROM reader.consumption_session_merge_receipt WHERE task_key=$1', [denied.task.key])).rowCount).toBe(0);
    await expect(controlTransaction(accessPool, client => requireReview(client, admitted.proposal,
      principals[1]!, agents[3]!, graph))).rejects.toBeInstanceOf(EditorialBlocked);
    const sharedController = randomUUID();
    await accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [sharedController, principals[1], agents[2]]);
    const prospective = { principal: principals[2]!, review: { id: randomUUID(), proposal: admitted.proposal.id,
      revision: 1, reviewer: agents[2]!, reviewerKey: independenceKey(admitted.proposal.id, principals[2]!),
      outcome: 'approve' as const, message: '', sequence: '0' } };
    expect((await controlTransaction(accessPool, client => reviewBasis(client, admitted.proposal, 2, graph, prospective)))
      .reviews.filter(review => review.outcome === 'approve')).toHaveLength(1);
    const olderIndependent = await createTask(false, true);
    const counted = await controlTransaction(accessPool, client => reviewBasis(client, olderIndependent.proposal, 2, graph));
    expect(counted.reviews.filter(review => review.outcome === 'approve').map(review => review.reviewer).sort())
      .toEqual([agents[1]!, agents[4]!].sort());
    await expect(handler.apply(admitted.task, item, itemCommandKey(admitted.task.key, 'session', item.key), deps))
      .rejects.toBeInstanceOf(EditorialBlocked);
    await accessPool.query('UPDATE access.representation SET active=false WHERE id=$1', [sharedController]);
    const key = itemCommandKey(admitted.task.key, 'session', item.key);
    const result = await handler.apply(admitted.task, item, key, deps);
    expect(result.outcome).toBe('retained');
    // Lose the acknowledgement, then change current authority before retry.
    await accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2', [agents[2], scope]);
    expect(await sessionMergeHandler(deps).apply(admitted.task, item, key, deps)).toEqual(result);
    expect((await contentPool.query('SELECT 1 FROM reader.consumption_session_merge_receipt WHERE command_key=$1', [key])).rowCount).toBe(1);
    const unchanged = (await contentPool.query<{ state: SessionState }>(
      'SELECT state FROM reader.consumption_session WHERE work=$1 ORDER BY id COLLATE "C"', [source])).rows;
    expect(unchanged.map(row => row.state)).toEqual(sessions.sort((a, b) => a.id.localeCompare(b.id)));
    await expect(contentPool.query('UPDATE reader.consumption_session_merge_receipt SET task_key=$2 WHERE command_key=$1', [key, denied.task.key])).rejects.toThrow();
    await expect(contentPool.query(`INSERT INTO reader.consumption_session_merge_receipt
      (command_key,task_key,request_digest,session,result) VALUES ($1,$2,$3,$4,'{}')`,
    [`merge:${'f'.repeat(64)}`, admitted.task.key, admitted.task.candidateDigest, item.key])).rejects.toThrow();
    const indexes = (await contentPool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname='reader' AND indexname IN ('consumption_session_merge_inventory','consumption_session_selection_merge_inventory')`)).rows;
    expect(indexes).toHaveLength(2);

    // Exercise G-865's actual persisted resume path through a controlled owner
    // port. The native identity finalizer is still outstanding; this fixture
    // qualifies lifecycle dispatch/replay, not a production merge effect.
    await accessPool.query('UPDATE access.permission_grant SET active=true WHERE recipient_subject=$1 AND scope_id=$2', [agents[2], scope]);
    let deliveries = 0, initialDeliveries = 0;
    const permits: string[] = [], operationKeys: string[] = [];
    const adapter: EditorialAdapter = { kind: 'merge', requiredApprovals: 2,
      validate(_target, raw, heads) { return Promise.resolve({ candidate: canonicalCandidate(checkedPlan(raw)).candidate,
        before: null, baseHeads: heads, ownerCommand: { action: 'work.edit', scope: `work:edit:${source}`, digest: canonicalCandidate(raw).digest } }); },
      preview() { return Promise.resolve([]); },
      apply() { initialDeliveries++; return Promise.resolve({ outcome: 'pending' }); },
      resolve() { return Promise.resolve(null); },
      resume(input) {
        deliveries++; permits.push(input.permit.proof); operationKeys.push(input.operationKey);
        return Promise.resolve(deliveries === 1 ? { outcome: 'pending' }
          : { outcome: 'applied', receipt: ownerReceipt(input, `urn:g836:resume:${input.permit.proof}`, id(), { task: input.operationKey }) });
      },
      compensate(receipt) { return Promise.resolve({ candidate: canonicalCandidate({ ...plan, operation: 'unmerge', original: admitted.task.key }).candidate,
        before: receipt.candidate, baseHeads: receipt.afterHeads }); },
    };
    const modules = Promise.resolve(new Map([['merge', { kind: 'merge', create: () => adapter }]]));
    const principal = { issuer: 'https://g836.example.test', subject: subjects[2]! };
    const work: MainWorkDependencies = { environment: { fuseki: graph, objectDirectory: '.temp/g-836-native-session',
      lineage: { dataEpoch: epoch, routingEpoch: epochRows[0]!.routing!.value } }, account: { verify: () => Promise.resolve(principal) },
      access: { activePrincipalId: () => Promise.resolve(principals[2]!), canReadWork: () => Promise.resolve(true) } as never };
    const call: EditorialCall = { work, request: new Request('http://main.local/v1/editorial/proposals',
      { headers: { authorization: 'Bearer fixture-verified-by-account-port' } }), principal, actingSubject: agents[2]! };
    const store = new EditorialReviewStore(accessPool, modules), retryKey = randomUUID();
    const decision = { revision: 1, outcome: 'applied' as const, approve: false, message: '' };
    expect((await store.decide(call, admitted.proposal.id, decision, retryKey)).outcome).toBe('apply_pending');
    await store.get(call, admitted.proposal.id);
    expect(deliveries).toBe(1);
    expect(initialDeliveries).toBe(0);
    await accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2', [agents[2], scope]);
    await expect(store.decide(call, admitted.proposal.id, decision, retryKey)).rejects.toBeInstanceOf(EditorialBlocked);
    expect(deliveries).toBe(1);
    await accessPool.query('UPDATE access.permission_grant SET active=true WHERE recipient_subject=$1 AND scope_id=$2', [agents[2], scope]);
    expect((await store.decide(call, admitted.proposal.id, decision, retryKey)).outcome).toBe('applied');
    expect(permits).toEqual([admitted.task.application, admitted.task.application]);
    expect(operationKeys).toEqual([admitted.task.key, admitted.task.key]);
    const replay = await new EditorialReviewStore(accessPool, modules).decide(call, admitted.proposal.id, decision, retryKey);
    expect(replay.replayed).toBe(true);
    expect(deliveries).toBe(2);
    await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(source)} rv:mergedInto ${iri(survivor)} . } }`);
    const reversal = await store.revert(call, admitted.proposal.id, plan.evidence, randomUUID());
    const reversalRead = await store.get(call, reversal.proposal);
    expect(reversalRead.proposal.target.resource).toBe(source);
    expect(reversalRead.proposal.reverts).toBe(admitted.proposal.id);
    const invalidModules = Promise.resolve(new Map([['merge', { kind: 'merge',
      create: () => ({ ...adapter, requiredApprovals: 1 as const }) }]]));
    await expect(new EditorialReviewStore(accessPool, invalidModules).get(call, admitted.proposal.id)).rejects.toBeInstanceOf(EditorialInvalid);
  } finally { await contentPool.end(); await accessPool.end(); }
});
