import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { canonicalCandidate } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { mergeDigest, type MergeTask } from '../../../services/main/src/modules/identity-merge/contract.ts';
import {
  RATING_MERGE_NATIVE_INVENTORY_SQL,
  RATING_MERGE_SELECTION_INVENTORY_SQL,
  ratingMergeHandler,
} from '../../../services/main/src/modules/rating/merge-handler.ts';
import { standingRatingSlotIri } from '../../../services/main/src/modules/rating/observation.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const zero = '00000000-0000-0000-0000-000000000000';
interface Grain { principal: string; context: string }
interface Head extends Grain {
  work: string;
  main: string;
  slot: string;
  admission: string;
  observation: string;
  revision: string;
  release: string | null;
}
interface PlanNode {
  [key: string]: unknown;
  Plans?: PlanNode[];
}
const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const grainKey = ({ principal, context }: Grain) => `${principal}|${context}`;

// These private incidence fixtures exercise planning only. Exact graph pairs,
// sealed effect receipts and compensation remain covered by their owner suites.
test('rating merge seeks bounded raw indexed grains and completely resumes sparse duplicate histories', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access });
  const personPrefix = randomUUID().slice(0, 24), contextPrefix = randomUUID().slice(0, 24);
  const people = Array.from({ length: 10_000 }, (_, n) =>
    `${personPrefix}${(n + 1).toString(16).padStart(12, '0')}`);
  const contexts = Array.from({ length: 3 }, (_, n) =>
    `https://rezics.com/id/${contextPrefix}${(n + 1).toString(16).padStart(12, '0')}`);
  const actor = id(), scope = `rating:observe:${contexts[0]}`;
  const proposal = randomUUID(), application = randomUUID();
  const task: MergeTask = {
    key: `editorial:${proposal}:1`, application, candidateDigest: '', dataEpoch: 'rating-inventory',
    handlers: [{ owner: 'rating', version: 'effective-person-vote-v3' }],
    plan: {
      operation: 'merge', source: { resource: id(), revision: id() },
      survivor: { resource: id(), revision: id() },
      evidence: [{ resource: id(), revision: id(), locator: null }],
    },
  };
  const canonical = canonicalCandidate(task.plan);
  task.candidateDigest = canonical.digest;
  const addAdmissions = async (rows: { principal: string; admission: string }[]) => {
    await pool.query(`INSERT INTO access.admission
      (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
        authority_epoch,expires_at,state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
      SELECT x.admission::uuid,x.principal::uuid,$2,$3,'rating.observation.set',x.admission,$4,
        0,now()+interval '1 hour','sealed','urn:rating-inventory:'||x.admission,
        'succeeded','rating-inventory','1',now()
      FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text)`,
    [JSON.stringify(rows), actor, scope, '1'.repeat(64)]);
  };
  const head = (work: string, principal: string, context: string, main = id(), release: string | null = null): Head => ({
    work, principal, context, main, release, slot: standingRatingSlotIri(principal, context, main),
    admission: randomUUID(), observation: id(), revision: id(),
  });
  const addHeads = async (rows: Head[]) => {
    await addAdmissions(rows);
    await pool.query(`INSERT INTO access.rating_aggregate_head
      (context,main_version,slot,work,observation,revision,principal_id,admission_id,original_admission_id,target_release)
      SELECT x.context,x.main,x.slot,x.work,x.observation,x.revision,
        x.principal::uuid,x.admission::uuid,x.admission::uuid,x.release
      FROM jsonb_to_recordset($1::jsonb)
        x(context text,main text,slot text,work text,observation text,revision text,principal text,admission text,release text)`,
    [JSON.stringify(rows)]);
  };
  const addSelections = async (work: string, grains: Grain[]) => {
    await pool.query(`INSERT INTO access.rating_merge_selection
      (context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
      SELECT x.context,$2,$3,x.principal::uuid,$4,$5,$6
      FROM jsonb_to_recordset($1::jsonb) x(context text,principal text)`,
    [JSON.stringify(grains), work, id(), id(), standingRatingSlotIri(people[0]!, contexts[0]!, id()), task.key]);
  };
  const graph = new FusekiClient('http://127.0.0.1:1/unused');
  graph.query = async (sparql) => {
    expect(sparql).toContain('ASK');
    return { boolean: false };
  };
  const dependencies = { accessPool: pool, contentPool: pool, graph };
  const handler = ratingMergeHandler(dependencies);
  const taskFor = (work: string): MergeTask => ({ ...task, plan: { ...task.plan, source: { ...task.plan.source, resource: work } } });
  try {
    await pool.query(`INSERT INTO access.principal(id,account_issuer,account_subject)
      SELECT x::uuid,'rating-inventory',x FROM jsonb_array_elements_text($1::jsonb) x`, [JSON.stringify(people)]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
    await pool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [scope]);
    const contextAdmissions = contexts.map(context => ({ context, principal: people[0]!, admission: randomUUID(), revision: id() }));
    await addAdmissions(contextAdmissions);
    await pool.query(`INSERT INTO access.rating_aggregate_context(context,realm,revision,policy_revision,admission_id)
      SELECT x.context,$2,x.revision,x.revision,x.admission::uuid
      FROM jsonb_to_recordset($1::jsonb) x(context text,revision text,admission text)`, [JSON.stringify(contextAdmissions), id()]);
    await pool.query(`INSERT INTO access.editorial_proposal
      (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
      VALUES ($1,'merge',$2,$3,'urn:rezics:context:global',$3,$4,$5,$6,ARRAY[$4::uuid])`,
    [proposal, task.plan.source, task.plan.source.resource, people[0], actor, '2'.repeat(64)]);
    await pool.query(`INSERT INTO access.editorial_revision
      (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,author_agent)
      VALUES ($1,1,$2,$3,'null',$4,$5,$6)`,
    [proposal, JSON.stringify(canonical.candidate), canonical.digest,
      JSON.stringify([task.plan.source, task.plan.survivor]), JSON.stringify(task.plan.evidence), actor]);
    await pool.query(`INSERT INTO access.editorial_application
      (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
      VALUES ($1::uuid,$2,1,$3,$4,$5,$1::text,$6,false,2,'Rating inventory fixture')`,
    [application, proposal, people[0], actor, task.key, canonical.digest]);
    await pool.query(`INSERT INTO access.identity_merge_task(task_key,application,candidate_digest,plan,data_epoch,handlers)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [task.key, application, canonical.digest, JSON.stringify(canonical.candidate), task.dataEpoch, JSON.stringify(task.handlers)]);

    const sparseWork = id();
    const grain = (person: number, context: number): Grain => ({ principal: people[person]!, context: contexts[context]! });
    const nativeGrains = [grain(0, 1), grain(1, 2), grain(2, 0), grain(3, 1), grain(5, 2), grain(7, 0)];
    const selectedGrains = [grain(0, 0), grain(0, 1), grain(0, 2), grain(1, 0), grain(2, 2), grain(4, 1), grain(5, 2), grain(6, 0)];
    await addHeads([
      ...nativeGrains.map(g => head(sparseWork, g.principal, g.context)),
      ...Array.from({ length: 40 }, () => head(sparseWork, people[0]!, contexts[1]!)),
      ...Array.from({ length: 8 }, () => head(sparseWork, people[2]!, contexts[0]!)),
      head(sparseWork, people[9]!, contexts[2]!, id(), id()),
    ]);
    await addSelections(sparseWork, selectedGrains);
    expect(handler.version).toBe('effective-person-vote-v3');
    expect(await handler.preview(taskFor(id()).plan, dependencies)).toEqual({ owner: 'rating', count: 0, complete: true });
    expect(await handler.plan(taskFor(id()), null, 3, dependencies)).toEqual({ items: [], next: null });
    expect(await handler.preview(taskFor(sparseWork).plan, dependencies)).toEqual({ owner: 'rating', count: 2, complete: false });
    const expected = [...new Set([...nativeGrains, ...selectedGrains].map(grainKey))].sort();
    const seen: string[] = [];
    let after: string | null = null;
    let shortPages = 0;
    for (let pageNumber = 0; pageNumber <= expected.length; pageNumber++) {
      const page = await handler.plan(taskFor(sparseWork), after, 3, dependencies);
      expect(page.items.length).toBeLessThanOrEqual(3);
      const keys = page.items.map(item => item.key);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(keys.length);
      if (after !== null) expect(keys.every(key => key > after!)).toBe(true);
      for (const item of page.items) {
        expect(item.before).toEqual({ policy: 'exact-rating-grain', context: item.key.split('|')[1] });
        expect(item.expectedHead).toBe(mergeDigest(item.before));
      }
      if (page.next !== null) {
        expect(page.next).toBe(keys.at(-1)!);
        expect(page.items.length).toBeGreaterThan(0);
        if (page.items.length < 3) shortPages++;
      }
      expect(await handler.plan(taskFor(sparseWork), after, 3, dependencies)).toEqual(page);
      seen.push(...keys);
      after = page.next;
      if (after === null) break;
      if (pageNumber === expected.length) throw new Error('Rating inventory did not reach EOF');
    }
    expect(seen).toEqual(expected);
    expect(shortPages).toBeGreaterThan(0);
    expect(await handler.plan(taskFor(sparseWork), expected.at(-1)!, 3, dependencies)).toEqual({ items: [], next: null });
    expect(await handler.preview(taskFor(sparseWork).plan, dependencies)).toEqual({ owner: 'rating', count: 2, complete: false });

    const workloads = [64, 10_000].map(count => ({ count, work: id() }));
    for (const { count, work } of workloads) {
      const grains = people.slice(0, count).map(principal => ({ principal, context: contexts[0]! }));
      await addHeads(grains.map(g => head(work, g.principal, g.context)));
      await addSelections(work, grains);
    }
    const largeWork = workloads[1]!.work;
    await addHeads(Array.from({ length: 10_000 }, () => head(largeWork, people[0]!, contexts[0]!)));
    await pool.query('ANALYZE access.rating_aggregate_head; ANALYZE access.rating_merge_selection');
    const measured: { count: number; source: string; seek: string; rows: number; buffers: number; plan: PlanNode }[] = [];
    for (const { count, work } of workloads) {
      for (const [source, sql, index] of [
        ['native', RATING_MERGE_NATIVE_INVENTORY_SQL, 'rating_merge_native_inventory'],
        ['selection', RATING_MERGE_SELECTION_INVENTORY_SQL, 'rating_merge_selection_inventory'],
      ] as const) {
        for (const [seek, principal, context] of [
          ['initial', zero, ''], ['resumed', people[0]!, contexts[0]!],
        ] as const) {
          const args = [work, principal, context, 33];
          const raw = (await pool.query<Grain>(sql, args)).rows;
          expect(raw).toHaveLength(33);
          if (source === 'native' && count === 10_000 && seek === 'initial')
            expect(new Set(raw.map(grainKey)).size).toBe(1);
          else expect(new Set(raw.map(grainKey)).size).toBe(33);
          const explained = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${sql}`, args);
          const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
          const scanned = nodes(plan);
          expect(scanned.some(node => /Sort|Unique|Aggregate|Seq Scan/.test(String(node['Node Type'])))).toBe(false);
          const indexNodes = scanned.filter(node => node['Index Name'] === index);
          expect(indexNodes).toHaveLength(1);
          const scan = indexNodes[0]!;
          expect(scan['Node Type']).toMatch(/Index/);
          expect(Number(scan['Actual Rows'])).toBe(33);
          expect(Number(scan['Actual Loops'])).toBe(1);
          expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
          expect(String(scan['Index Cond'])).toContain('ROW(principal_id,');
          expect(Number(plan['Actual Rows'])).toBe(33);
          const buffers = Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0);
          expect(buffers).toBeLessThanOrEqual(128);
          expect(Number(plan['Temp Read Blocks'] ?? 0) + Number(plan['Temp Written Blocks'] ?? 0)).toBe(0);
          measured.push({ count, source, seek, rows: Number(scan['Actual Rows']), buffers, plan });
        }
      }
      const initial = await handler.plan(taskFor(work), null, 32, dependencies);
      expect(initial.next).not.toBeNull();
      expect(initial.items).toHaveLength(count === 10_000 ? 1 : 32);
      expect(await handler.preview(taskFor(work).plan, dependencies)).toEqual({ owner: 'rating', count: count === 10_000 ? 1 : 32, complete: false });
      const resumed = await handler.plan(taskFor(work), grainKey({ principal: people[0]!, context: contexts[0]! }), 32, dependencies);
      expect(resumed.items.map(item => item.key)).toEqual(people.slice(1, 33).map(principal => grainKey({ principal, context: contexts[0]! })));
      expect(resumed.next).toBe(resumed.items.at(-1)!.key);
      const tail = await handler.plan(taskFor(work), grainKey({ principal: people[count - 3]!, context: contexts[0]! }), 32, dependencies);
      expect(tail.items.map(item => item.key)).toEqual(people.slice(count - 2, count).map(principal => grainKey({ principal, context: contexts[0]! })));
      expect(tail.next).toBeNull();
    }
    for (const larger of measured.filter(row => row.count === 10_000)) {
      const smaller = measured.find(row => row.count === 64 && row.source === larger.source && row.seek === larger.seek)!;
      expect(larger.buffers).toBeLessThanOrEqual(smaller.buffers + 64);
    }
    const root = resolve(import.meta.dir, '../../..');
    const sourceSHA = createHash('sha256').update(await Bun.file(resolve(root,
      'services/main/src/modules/rating/merge-handler.ts')).text()).digest('hex');
    await mkdir(resolve(root, '.temp/goal'), { recursive: true });
    await writeFile(resolve(root, '.temp/goal/rating-merge-inventory-plans.json'),
      JSON.stringify({ sourceSHA, nativeSql: RATING_MERGE_NATIVE_INVENTORY_SQL,
        selectionSql: RATING_MERGE_SELECTION_INVENTORY_SQL, measured }, null, 2));
    console.info('rating merge inventory EXPLAIN ANALYZE BUFFERS', JSON.stringify({ sourceSHA,
      measured: measured.map(({ plan: _plan, ...summary }) => summary) }));
  } finally {
    await pool.end();
    await databases.close();
  }
}, 300_000);
