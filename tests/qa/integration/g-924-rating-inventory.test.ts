import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { canonicalCandidate } from '../../../services/main/src/modules/editorial-review/contract.ts';
import {
  RATING_INVENTORY_SQL,
  readRatingAggregateInventory,
} from '../../../services/main/src/modules/access/rating-aggregate-inventory.ts';
import { standingRatingSlotIri } from '../../../services/main/src/modules/rating/observation.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface Plan {
  [key: string]: unknown;
  Plans?: Plan[];
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

/** Bulk private inventory fixture, not an alternative merge admission path.
 * Native graph/manifest and reviewed owner reconciliation remain covered by
 * g-836-sao-public-api and the rating aggregate suites. */
test('G924: indexed merged inventory stays bounded through masked votes, 100/101 and growing retained history', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access']);
  const pool = new Pool({ connectionString: databases.urls.access });
  const context = id(),
    work = id(),
    main = id(),
    originWork = id(),
    originMain = id(),
    actor = id();
  const scope = `rating:observe:${context}`;
  const people = Array.from({ length: 2048 }, () => randomUUID()).sort();
  const items = people.map((principal) => ({
    principal,
    admission: randomUUID(),
    observation: id(),
    revision: id(),
    slot: standingRatingSlotIri(principal, context, originMain),
  }));
  const contextAdmission = randomUUID();
  const proposal = randomUUID(),
    application = randomUUID(),
    task = `editorial:${proposal}:1`;
  const plan = {
    operation: 'merge',
    source: { resource: originWork, revision: id() },
    survivor: { resource: work, revision: id() },
    evidence: [],
  };
  const canonical = canonicalCandidate(plan);
  const addAdmissions = async (rows: { principal: string; admission: string }[]) => {
    await pool.query(
      `INSERT INTO access.admission
      (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
        authority_epoch,expires_at,state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
      SELECT x.admission::uuid,x.principal::uuid,$2,$3,'rating.observation.set',x.admission,$4,
        0,now()+interval '1 hour','sealed','urn:g924:'||x.admission,'succeeded','g924','1',now()
      FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text)`,
      [JSON.stringify(rows), actor, scope, '1'.repeat(64)],
    );
  };
  try {
    await pool.query(
      `INSERT INTO access.principal(id,account_issuer,account_subject)
      SELECT x::uuid,'g924-rating',x FROM jsonb_array_elements_text($1::jsonb) x`,
      [JSON.stringify(people)],
    );
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
    await pool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [scope]);
    await addAdmissions([{ principal: people[0]!, admission: contextAdmission }]);
    await pool.query(
      `INSERT INTO access.rating_aggregate_context(context,realm,revision,policy_revision,admission_id)
      VALUES ($1,$2,$3,$3,$4)`,
      [context, id(), id(), contextAdmission],
    );
    await pool.query(
      `INSERT INTO access.editorial_proposal
      (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
      VALUES ($1,'merge',$2,$3,'urn:rezics:context:global',$3,$4,$5,$6,ARRAY[$4::uuid])`,
      [proposal, plan.source, originWork, people[0], actor, '2'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO access.editorial_revision
      (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,author_agent)
      VALUES ($1,1,$2,$3,'null',$4,'[]',$5)`,
      [
        proposal,
        JSON.stringify(canonical.candidate),
        canonical.digest,
        JSON.stringify([plan.source, plan.survivor]),
        actor,
      ],
    );
    await pool.query(
      `INSERT INTO access.editorial_application
      (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
      VALUES ($1::uuid,$2,1,$3,$4,$5,$1::text,$6,false,2,'G924 inventory fixture')`,
      [application, proposal, people[0], actor, task, canonical.digest],
    );
    await pool.query(
      `INSERT INTO access.identity_merge_task(task_key,application,candidate_digest,plan,data_epoch,handlers)
      VALUES ($1,$2,$3,$4,'g924','[{"owner":"rating","version":"effective-person-vote-v3"}]')`,
      [task, application, canonical.digest, JSON.stringify(canonical.candidate)],
    );
    await addAdmissions(items);
    await pool.query(
      `INSERT INTO access.rating_aggregate_head
      (context,main_version,slot,work,observation,revision,principal_id,admission_id,original_admission_id)
      SELECT $2,$3,x.slot,$4,x.observation,x.revision,x.principal::uuid,x.admission::uuid,x.admission::uuid
      FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text,slot text,observation text,revision text)`,
      [JSON.stringify(items), context, originMain, originWork],
    );
    const native = items
      .slice(0, 32)
      .map((item) => ({
        ...item,
        admission: randomUUID(),
        observation: id(),
        revision: id(),
        slot: standingRatingSlotIri(item.principal, context, main),
      }));
    await addAdmissions(native);
    await pool.query(
      `INSERT INTO access.rating_aggregate_head
      (context,main_version,slot,work,observation,revision,principal_id,admission_id,original_admission_id)
      SELECT $2,$3,x.slot,$4,x.observation,x.revision,x.principal::uuid,x.admission::uuid,x.admission::uuid
      FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text,slot text,observation text,revision text)`,
      [JSON.stringify(native), context, main, work],
    );
    let previous = 0;
    for (const count of [16, 100, 101, 512, 2048]) {
      await pool.query(
        `INSERT INTO access.rating_merge_selection
        (context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
        SELECT $2,$3,$4,x.principal::uuid,$5,x.slot,$6
        FROM jsonb_to_recordset($1::jsonb) x(principal text,slot text)`,
        [JSON.stringify(items.slice(previous, count)), context, work, main, originMain, task],
      );
      previous = count;
      await pool.query(
        'ANALYZE access.rating_aggregate_head; ANALYZE access.rating_merge_selection',
      );
      const inventory = await readRatingAggregateInventory(pool, context, main);
      expect(inventory.heads).toHaveLength(Math.min(Math.max(32, count), 101));
      if (count <= 100) {
        expect(
          inventory.heads
            .filter((head) => !head.originWork)
            .map((head) => head.revision)
            .sort(),
        ).toEqual(native.map((item) => item.revision).sort());
        expect(new Set(inventory.heads.map((head) => head.raterKey)).size).toBe(
          inventory.heads.length,
        );
        expect(
          inventory.heads
            .filter((head) => head.originWork)
            .every(
              (head) =>
                head.work === work &&
                head.mainVersion === main &&
                head.originWork === originWork &&
                head.originMainVersion === originMain,
            ),
        ).toBe(true);
      }
      const explained = await pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${RATING_INVENTORY_SQL}`,
        [context, main],
      );
      const scanned = nodes(explained.rows[0]!['QUERY PLAN'][0]!.Plan);
      for (const node of scanned.filter((node) => Number(node['Actual Loops']) > 0)) {
        if (node['Relation Name'] === 'rating_merge_selection')
          expect(Number(node['Actual Rows'])).toBeLessThanOrEqual(101);
        if (node['Node Type'] === 'Sort')
          expect(Number(node['Actual Rows'])).toBeLessThanOrEqual(202);
        if (
          count === 2048 &&
          ['rating_aggregate_head', 'rating_merge_selection'].includes(
            String(node['Relation Name']),
          )
        ) {
          expect(node['Node Type']).toMatch(/Index/);
          expect(Number(node['Actual Rows'])).toBeLessThanOrEqual(101);
          expect(Number(node['Actual Loops'])).toBeLessThanOrEqual(101);
          expect(Number(node['Rows Removed by Filter'] ?? 0)).toBe(0);
        }
      }
    }
    // Remove unrelated candidates to probe corruption without the overflow sentinel.
    await pool.query('DELETE FROM access.rating_merge_selection WHERE principal_id<>$1', [
      items[32]!.principal,
    ]);
    const missing = items[32]!;
    const removed = await pool.query(
      `DELETE FROM access.rating_aggregate_head h WHERE observation=$1 RETURNING to_jsonb(h) AS row`,
      [missing.observation],
    );
    await expect(readRatingAggregateInventory(pool, context, main)).rejects.toThrow(
      'Merged rating origin is unavailable',
    );
    await pool.query(
      'INSERT INTO access.rating_aggregate_head SELECT (jsonb_populate_record(NULL::access.rating_aggregate_head,$1)).*',
      [removed.rows[0].row],
    );
    expect((await readRatingAggregateInventory(pool, context, main)).heads).toHaveLength(33);
    await pool.query("UPDATE access.admission SET graph_outcome='cancelled' WHERE id=$1", [
      missing.admission,
    ]);
    await expect(readRatingAggregateInventory(pool, context, main)).rejects.toThrow(
      'Rating inventory head is unavailable',
    );
    await pool.query("UPDATE access.admission SET graph_outcome='succeeded' WHERE id=$1", [
      missing.admission,
    ]);
    await pool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
    await expect(readRatingAggregateInventory(pool, context, main)).rejects.toThrow(
      'Rating inventory is unavailable',
    );
  } finally {
    await pool.end();
    await databases.close();
  }
});
