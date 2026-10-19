import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { canonicalCandidate } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import {
  listTargetsNeedingReconstruction,
  readRatingAggregateInventory,
  readStandingRatingReconstructionBatch,
  recordStandingRatingValues,
  checkRatingAggregateFence,
  STANDING_RATING_INVENTORY_SQL,
  STANDING_RATING_FENCE_SQL,
  RATING_INVENTORY_SQL,
} from '../../../services/main/src/modules/rating/aggregate-inventory.ts';
import { fenceStandingRatingTransition, refreshStandingRatingProjections } from '../../../services/main/src/modules/rating/standing-publication.ts';
import { itemCommandKey } from '../../../services/main/src/modules/identity-merge/contract.ts';
import { standingRatingSlotIri } from '../../../services/main/src/modules/rating/observation.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface NativePlan {
  Plan: PlanNode;
  'Execution Time'?: number;
  'Query Text'?: string;
}
interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

/** Exercises the real migrated Access owner and its additive state. Public
 * graph/receipt/manifest composition is independently covered by the D5-006
 * public assertions and rating-global-synthesis, rather than simulated here. */
test('standing components retain exact effective slots through 100/101/large, merge changes and bounded legacy reconstruction', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'privileged');
  const pool = new Pool({ connectionString: databases.urls.access, options: '-c role=access' });
  // LOAD/configure instrumentation on a privileged session, then execute the
  // measured SQL as Access. Normal fixture sessions retain the Access role.
  const metricsPool = new Pool({ connectionString: databases.urls.access, max: 1 });
  const context = id(), work = id(), main = id(), originWork = id(), originMain = id(), legacyMain = id(), actor = id();
  const people = Array.from({ length: 2048 }, () => randomUUID()).sort();
  const scope = `rating:observe:${context}`;
  const items = people.map(principal => ({ principal, admission: randomUUID(), observation: id(), revision: id(),
    slot: standingRatingSlotIri(principal, context, originMain) }));
  const contextAdmission = randomUUID(), proposal = randomUUID(), application = randomUUID(), task = `editorial:${proposal}:1`;
  const plan = { operation: 'merge', source: { resource: originWork, revision: id() },
    survivor: { resource: work, revision: id() }, evidence: [] };
  const canonical = canonicalCandidate(plan);
  const admissions = async (rows: { principal: string; admission: string }[]) => pool.query(`INSERT INTO access.admission
    (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,authority_epoch,expires_at,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
    SELECT x.admission::uuid,x.principal::uuid,$2,$3,'rating.observation.set',x.admission,$4,0,now()+interval '1 hour',
      'sealed','urn:g2786:'||x.admission,'succeeded','g2786','1',now()
    FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text)`, [JSON.stringify(rows), actor, scope, '1'.repeat(64)]);
  const heads = async (rows: typeof items, target: string, owner: string, known = true) => {
    await admissions(rows);
    await pool.query(`INSERT INTO access.rating_aggregate_head
      (context,main_version,slot,work,observation,revision,principal_id,admission_id,original_admission_id,value,value_known)
      SELECT $2,$3,x.slot,$4,x.observation,x.revision,x.principal::uuid,x.admission::uuid,x.admission::uuid,
        CASE WHEN $5 THEN 5::numeric ELSE NULL END,$5
      FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text,slot text,observation text,revision text)`,
    [JSON.stringify(rows), context, target, owner, known]);
  };
  const component = async (target: string) => (await pool.query(`SELECT slots,unvalued,histogram
    FROM access.rating_standing_component WHERE context=$1 AND main_version=$2`, [context, target])).rows[0];
  const expectExact = async (target: string) => {
    const state = await component(target);
    const recomputed = (await pool.query(`SELECT count(*)::int AS slots,
      count(*) FILTER (WHERE NOT value_known)::int AS unvalued,
      COALESCE((SELECT jsonb_object_agg(bin,n) FROM (SELECT trim_scale(value)::text AS bin,count(*)::int AS n
        FROM access.rating_standing_contribution WHERE context=$1 AND main_version=$2 AND value_known AND value IS NOT NULL
        GROUP BY value) bins),'{}'::jsonb) AS histogram
      FROM access.rating_standing_contribution WHERE context=$1 AND main_version=$2`, [context, target])).rows[0];
    expect(state).toEqual(recomputed);
    return state;
  };
  try {
    await pool.query(`INSERT INTO access.principal(id,account_issuer,account_subject)
      SELECT x::uuid,'g2786-standing',x FROM jsonb_array_elements_text($1::jsonb) x`, [JSON.stringify(people)]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
    await grantFixtureAuthority(pool, { scope, requireDispatch: true,
      representations: [{ principalId: people[0]!, actor, action: 'rating.observation.set', lifetime: '8 hours' }],
      grant: { actor, action: 'rating.observation.set', lifetime: '8 hours' } });
    await admissions([{ principal: people[0]!, admission: contextAdmission }]);
    await pool.query(`INSERT INTO access.rating_aggregate_context(context,realm,revision,policy_revision,admission_id)
      VALUES ($1,$2,$3,$3,$4)`, [context, id(), id(), contextAdmission]);
    await pool.query(`INSERT INTO access.editorial_proposal
      (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
      VALUES ($1,'merge',$2,$3,'urn:rezics:context:global',$3,$4,$5,$6,ARRAY[$4::uuid])`,
    [proposal, plan.source, originWork, people[0], actor, '2'.repeat(64)]);
    await pool.query(`INSERT INTO access.editorial_revision
      (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,author_agent)
      VALUES ($1,1,$2,$3,'null',$4,'[]',$5)`,
    [proposal, JSON.stringify(canonical.candidate), canonical.digest, JSON.stringify([plan.source, plan.survivor]), actor]);
    await pool.query(`INSERT INTO access.editorial_application
      (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
      VALUES ($1::uuid,$2,1,$3,$4,$5,$1::text,$6,false,2,'G2786 standing owner fixture')`,
    [application, proposal, people[0], actor, task, canonical.digest]);
    await pool.query(`INSERT INTO access.identity_merge_task(task_key,application,candidate_digest,plan,data_epoch,handlers)
      VALUES ($1,$2,$3,$4,'g2786','[{"owner":"rating","version":"effective-person-vote-v3"}]')`,
    [task, application, canonical.digest, JSON.stringify(canonical.candidate)]);

    // SQL and application slot identities must match, including escaped JSON.
    expect((await pool.query('SELECT access.rating_standing_slot($1,$2,$3) AS slot',
      [people[0], context, originMain])).rows[0].slot).toBe(items[0]!.slot);
    let previous = 0;
    const currentTargets = [{main:id(),work:id()},{main:id(),work:id()}].sort((a,b) => a.main.localeCompare(b.main));
    const workMeasurements: Record<string,unknown>[] = [];
    const measure = async (sql: string, parameters: unknown[]) => {
      const client = await metricsPool.connect(), plans: NativePlan[] = [];
      const capture = (notice: { message?: string }) => {
        const message = notice.message ?? '', start = message.indexOf('{');
        if (start >= 0) {
          const value = JSON.parse(message.slice(start)) as NativePlan;
          if (value.Plan) plans.push(value);
        }
      };
      try {
        await client.query(`RESET ROLE; LOAD 'auto_explain';
          SET auto_explain.log_analyze=on; SET auto_explain.log_timing=off;
          SET auto_explain.log_buffers=on; SET auto_explain.log_nested_statements=on;
          SET auto_explain.log_format=json; SET auto_explain.log_level=notice;
          SET auto_explain.log_min_duration=0; SET ROLE access`);
        client.on('notice',capture);
        await client.query(sql,parameters);
        // A Function Scan's output count omits work inside the SQL function.
        // Include every nested plan under the same row-work measurement.
        if (sql !== RATING_INVENTORY_SQL) expect(plans.some(plan => planNodes(plan.Plan)
          .some(node => node['Relation Name'] === 'rating_standing_component'))).toBe(true);
        const examined = plans.flatMap(plan => planNodes(plan.Plan)).reduce((sum,node) => sum
          + ((node['Actual Rows'] ?? 0)+(node['Rows Removed by Filter'] ?? 0)+(node['Rows Removed by Join Filter'] ?? 0))
            * (node['Actual Loops'] ?? 0),0);
        return { examined, milliseconds: plans.reduce((sum,plan) => sum+(plan['Execution Time'] ?? 0),0), plans };
      } finally {
        client.removeListener('notice',capture);
        await client.query('RESET ROLE; SET auto_explain.log_min_duration=-1; SET ROLE access');
        client.release();
      }
    };
    for (const population of [100, 101, 102, 512, 2048]) {
      await heads(items.slice(previous, population), originMain, originWork);
      previous = population;
      expect(await expectExact(originMain)).toEqual({ slots: population, unvalued: 0, histogram: { '5': population } });
      const inventory = await readRatingAggregateInventory(pool, context, originMain);
      expect(inventory.heads).toHaveLength(Math.min(population, 101));
      expect(inventory.standing).toMatchObject({ slots: population, unvalued: 0, histogram: { '5': population } });
      expect(!!inventory.standing!.witness).toBe(population > 100);

      // Every native principal now has a matching pending origin job, although
      // its native component and first retained delivery are fully current.
      // EXPLAIN the actual inventory and final synthesis SQL, not a LIMIT-only
      // surrogate. The native readiness path must not compare N sealed heads.
      for (const target of currentTargets) await pool.query(`INSERT INTO access.rating_merge_selection
        (context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
        SELECT $2,$3,$4,x.principal::uuid,$5,x.slot,$6
        FROM jsonb_to_recordset($1::jsonb) x(principal text,slot text)`,
      [JSON.stringify(items.slice(0,population)),context,target.work,target.main,originMain,task]);
      const replacements = items.slice(0,population).map(item => ({ ...item, admission: randomUUID() }));
      await admissions(replacements);
      await pool.query(`UPDATE access.rating_aggregate_head h SET admission_id=x.admission::uuid
        FROM jsonb_to_recordset($1::jsonb) x(principal text,admission text)
        WHERE h.context=$2 AND h.main_version=$3 AND h.principal_id=x.principal::uuid`,
      [JSON.stringify(replacements),context,originMain]);
      expect(Number((await pool.query('SELECT count(*) FROM access.rating_standing_refresh WHERE context=$1', [context])).rows[0].count)).toBe(population);
      const nativeCurrent = await readRatingAggregateInventory(pool,context,originMain);
      const delivered = await readRatingAggregateInventory(pool,context,currentTargets[0]!.main);
      expect(nativeCurrent.standing!.slots).toBe(population);
      expect(delivered.standing!.slots).toBe(population);
      await expect(readRatingAggregateInventory(pool,context,currentTargets[1]!.main)).rejects.toThrow('publication is incomplete');
      const cuts = [originMain,currentTargets[0]!.main].map((mainVersion,index) => ({ context,main_version:mainVersion,
        generation: [nativeCurrent,delivered][index]!.standingGeneration! }));
      const readiness = await measure('SELECT * FROM access.rating_standing_publication($1,$2)',[context,originMain]);
      const read = await measure(STANDING_RATING_INVENTORY_SQL,[context,originMain]);
      const fence = await measure(STANDING_RATING_FENCE_SQL,[JSON.stringify(cuts)]);
      workMeasurements.push({ population, readiness, read, fence });
      await Bun.write(`${import.meta.dir}/../../../.temp/goal/standing-native-work.json`,JSON.stringify(workMeasurements));
      expect(readiness.examined).toBeLessThan(64);
      expect(read.examined).toBeLessThan(2000);
      expect(fence.examined).toBeLessThan(128);
      await pool.query('DELETE FROM access.rating_merge_selection WHERE context=$1 AND main_version=ANY($2::text[])',[context,currentTargets.map(target => target.main)]);
      while (!(await refreshStandingRatingProjections(pool,{ context,limit:100 })).complete) { /* one bounded origin page */ }
    }
    console.log('standing native readiness work', JSON.stringify(workMeasurements.map(row => ({ population:row.population,
      readiness:(row.readiness as {examined:number}).examined, read:(row.read as {examined:number}).examined,
      fence:(row.fence as {examined:number}).examined }))));
    await Bun.write(`${import.meta.dir}/../../../.temp/goal/standing-native-work.json`,JSON.stringify(workMeasurements));
    await pool.query(`INSERT INTO access.rating_merge_selection
      (context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
      SELECT $2,$3,$4,x.principal::uuid,$5,x.slot,$6
      FROM jsonb_to_recordset($1::jsonb) x(principal text,slot text)`,
    [JSON.stringify(items), context, work, main, originMain, task]);
    const masked = items.slice(64,96).map(item => ({ ...item, admission: randomUUID(), observation: id(), revision: id(),
      slot: standingRatingSlotIri(item.principal,context,main) }));
    await heads(masked,main,work);
    await pool.query('ANALYZE access.rating_aggregate_head; ANALYZE access.rating_merge_selection');
    const mixed = await measure(RATING_INVENTORY_SQL,[context,main]);
    workMeasurements.push({ population:2048, mixed });
    await Bun.write(`${import.meta.dir}/../../../.temp/goal/standing-native-work.json`,JSON.stringify(workMeasurements));
    for (const node of mixed.plans.flatMap(plan => planNodes(plan.Plan))) {
      if (!node['Actual Loops']) continue;
      if (node['Node Type'] === 'Sort') expect(node['Actual Rows']).toBeLessThanOrEqual(202);
      if (['rating_aggregate_head','rating_merge_selection'].includes(node['Relation Name'] ?? '')) {
        expect(node['Node Type']).toMatch(/Index/);
        expect(node['Actual Rows']).toBeLessThanOrEqual(101);
        expect(node['Actual Loops']).toBeLessThanOrEqual(101);
        expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
      }
    }
    await pool.query('DELETE FROM access.rating_aggregate_head WHERE context=$1 AND main_version=$2 AND principal_id=ANY($3::uuid[])',
      [context,main,masked.map(item => item.principal)]);
    expect(await expectExact(main)).toEqual({ slots: 2048, unvalued: 0, histogram: { '5': 2048 } });
    const native = { ...items[0]!, admission: randomUUID(), observation: id(), revision: id(),
      slot: standingRatingSlotIri(people[0]!, context, main) };
    await heads([native], main, work);
    await pool.query('UPDATE access.rating_aggregate_head SET value=8.5 WHERE context=$1 AND main_version=$2 AND slot=$3',
      [context, main, native.slot]);
    expect(await expectExact(main)).toMatchObject({ slots: 2048, histogram: { '5': 2047, '8.5': 1 } });
    await pool.query('UPDATE access.rating_aggregate_head SET value=NULL WHERE context=$1 AND main_version=$2 AND slot=ANY($3::text[])',
      [context, originMain, items.slice(0, 2).map(item => item.slot)]);
    expect(await expectExact(originMain)).toMatchObject({ slots: 2048, histogram: { '5': 2046 } });
    expect(await expectExact(main)).toMatchObject({ slots: 2048, histogram: { '5': 2046, '8.5': 1 } });
    await pool.query('DELETE FROM access.rating_merge_selection WHERE context=$1 AND main_version=$2', [context, main]);
    expect(await expectExact(main)).toEqual({ slots: 1, unvalued: 0, histogram: { '8.5': 1 } });

    // Deleting the witness at 102 leaves an immediately verifiable 101-person
    // component, with no unrelated seal or reconstruction needed to heal it.
    const deletionMain = id();
    const deletable = items.slice(0, 102).map(item => ({ ...item, admission: randomUUID(), observation: id(), revision: id(),
      slot: standingRatingSlotIri(item.principal, context, deletionMain) }));
    await heads(deletable, deletionMain, work);
    for (const population of [102, 101]) {
      const before = await readRatingAggregateInventory(pool, context, deletionMain);
      expect(before.standing!.slots).toBe(population);
      expect(before.standing!.witness).toBeTruthy();
      const removedSlot = before.standing!.witness!.slot;
      await pool.query('DELETE FROM access.rating_aggregate_head WHERE context=$1 AND main_version=$2 AND slot=$3',
        [context, deletionMain, removedSlot]);
      const after = await readRatingAggregateInventory(pool, context, deletionMain);
      expect(after.standing!.slots).toBe(population - 1);
      expect(await expectExact(deletionMain)).toMatchObject({ slots: population - 1, histogram: { '5': population - 1 } });
      if (population === 102) {
        expect(after.standing!.witness).toBeTruthy();
        expect(after.standing!.witness!.slot).not.toBe(removedSlot);
      }
    }

    // One origin can occur in far more retained survivor selections than the
    // address hop bound. A seal changes at most one projection synchronously;
    // the durable pending fence prevents any stale component being called exact.
    const retained = Array.from({ length: 137 }, () => ({ main: id(), work: id() })).sort((a, b) => a.main.localeCompare(b.main));
    const source = items[5]!;
    await pool.query(`INSERT INTO access.rating_merge_selection
      (context,work,main_version,principal_id,origin_main_version,origin_slot,task_key)
      SELECT $2,x.work,x.main,$3::uuid,$4,$5,$6 FROM jsonb_to_recordset($1::jsonb) x(work text,main text)`,
    [JSON.stringify(retained), context, source.principal, originMain, source.slot, task]);
    const countValue = async (value: number) => Number((await pool.query(`SELECT count(*) AS n FROM access.rating_standing_contribution
      WHERE context=$1 AND main_version=ANY($2::text[]) AND value=$3`, [context, retained.map(target => target.main), value])).rows[0].n);
    const oldCut = await readRatingAggregateInventory(pool, context, retained.at(-1)!.main);
    await pool.query('UPDATE access.rating_aggregate_head SET value=4 WHERE context=$1 AND main_version=$2 AND slot=$3',
      [context, originMain, source.slot]);
    expect(await countValue(4)).toBe(1);
    expect((await pool.query('SELECT pending FROM access.rating_standing_publication($1,$2)', [context, originMain])).rows[0].pending).toBe('0');
    expect((await readRatingAggregateInventory(pool, context, originMain)).standing!.slots).toBe(2048);
    expect((await readRatingAggregateInventory(pool, context, retained[0]!.main)).standing!.histogram).toEqual({ '4': 1 });
    expect((await readRatingAggregateInventory(pool, context, deletionMain)).standing!.slots).toBe(100);
    await expect(readRatingAggregateInventory(pool, context, retained.at(-1)!.main)).rejects.toThrow('publication is incomplete');
    expect(await checkRatingAggregateFence(pool, oldCut.recoveryGeneration, undefined, [{ context, mainVersion: retained.at(-1)!.main, generation: oldCut.standingGeneration! }])).toBe(false);
    expect(await refreshStandingRatingProjections(pool, { context, limit: 32 })).toMatchObject({ refreshed: 32, complete: false });
    expect(await countValue(4)).toBe(33);
    expect((await readRatingAggregateInventory(pool, context, retained[32]!.main)).standing!.histogram).toEqual({ '4': 1 });
    await expect(readRatingAggregateInventory(pool, context, retained[33]!.main)).rejects.toThrow('publication is incomplete');
    expect((await readRatingAggregateInventory(pool, context, deletionMain)).standing!.slots).toBe(100);

    // A newer source seal rewinds the persisted frontier. Lost local cursors
    // cannot skip the earlier targets now carrying that previous value.
    await pool.query('UPDATE access.rating_aggregate_head SET value=3 WHERE context=$1 AND main_version=$2 AND slot=$3',
      [context, originMain, source.slot]);
    expect(await countValue(3)).toBe(1);
    expect(await refreshStandingRatingProjections(pool, { context, limit: 100 })).toMatchObject({ refreshed: 100, complete: false });
    expect(await refreshStandingRatingProjections(pool, { context, limit: 100 })).toMatchObject({ refreshed: 36, complete: true });
    expect(await countValue(3)).toBe(137);
    for (const target of retained) await expectExact(target.main);

    // Deletion uses the same bounded path, retaining missing origins as unknown
    // instead of dropping their selected slots or publishing truncated figures.
    await pool.query('DELETE FROM access.rating_aggregate_head WHERE context=$1 AND main_version=$2 AND slot=$3',
      [context, originMain, source.slot]);
    expect(await refreshStandingRatingProjections(pool, { context, limit: 32 })).toMatchObject({ refreshed: 32, complete: false });
    await expect(readRatingAggregateInventory(pool, context, retained.at(-1)!.main)).rejects.toThrow('publication is incomplete');
    expect((await readRatingAggregateInventory(pool, context, deletionMain)).standing!.slots).toBe(100);
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 100, complete: false });
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 4, complete: true });
    expect(await expectExact(originMain)).toMatchObject({ slots: 2047, unvalued: 0 });
    for (const target of retained) expect(await expectExact(target.main)).toEqual({ slots: 1, unvalued: 1, histogram: {} });

    // Reconstruction also has bounded native fanout; it cannot hide 137
    // projection updates behind one verified head's CAS.
    const reconstructed = { ...source, admission: randomUUID(), observation: id(), revision: id() };
    await heads([reconstructed], originMain, originWork, false);
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 100, complete: false });
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 36, complete: true });
    const recovery = (await pool.query('SELECT generation FROM access.recovery_fence WHERE id')).rows[0].generation;
    expect(await recordStandingRatingValues(pool, context, recovery,
      [{ mainVersion: originMain, slot: reconstructed.slot, revision: reconstructed.revision, value: 5 }])).toBe(1);
    expect(await countValue(5)).toBe(1);
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 100, complete: false });
    expect(await refreshStandingRatingProjections(pool, { context })).toMatchObject({ refreshed: 36, complete: true });
    expect(await countValue(5)).toBe(137);
    await pool.query('DELETE FROM access.rating_merge_selection WHERE context=$1 AND main_version=ANY($2::text[])',
      [context, retained.map(target => target.main)]);

    // The fence is component-wide, regardless of a native/inherited witness.
    // An attempted early journal completion cannot reopen it. The real identity
    // graph interruption assertions remain in the isolated public prove phase.
    const beforeTransition = await readRatingAggregateInventory(pool, context, originMain);
    const oldest = await pool.connect();
    try {
      await oldest.query('BEGIN');
      await oldest.query('SELECT pg_current_xact_id()'); // pin xmin before the identity transition
      await fenceStandingRatingTransition(pool, task, { sourceWork: originWork, sourceMainVersion: originMain, survivorWork: work, survivorMainVersion: main, originalKey: null });
      await fenceStandingRatingTransition(pool, task, { sourceWork: originWork, sourceMainVersion: originMain, survivorWork: work, survivorMainVersion: main, originalKey: null });
      expect((await pool.query('SELECT pending FROM access.rating_standing_publication($1,$2)', [context, originMain])).rows[0].pending).toBe('1');
      await expect(readRatingAggregateInventory(pool, context, originMain)).rejects.toThrow('publication is incomplete');
      expect((await readRatingAggregateInventory(pool, context, deletionMain)).standing!.slots).toBe(100);
      const completion = () => pool.query(`INSERT INTO access.identity_merge_completion(task_key,receipt,command_key,result)
        VALUES ($1,'urn:standing-owner-fixture:complete',$2,'null')`, [task, itemCommandKey(task, 'identity-merge', '$finalize')]);
      await expect(completion()).rejects.toThrow('merge reconciliation is incomplete');
      expect((await pool.query('SELECT pending FROM access.rating_standing_publication($1,$2)', [context, originMain])).rows[0].pending).toBe('1');
      await pool.query(`INSERT INTO access.identity_merge_page(task_key,owner,page,exhausted)
        VALUES ($1,'rating',1,true)`, [task]);
      await completion();
      await fenceStandingRatingTransition(pool, task, { sourceWork: originWork, sourceMainVersion: originMain, survivorWork: work, survivorMainVersion: main, originalKey: null }); // completed replay must not create a new pending marker
      // An unrelated older transaction must not hold a now-consistent cut.
      expect((await pool.query('SELECT pending FROM access.rating_standing_publication($1,$2)', [context, originMain])).rows[0].pending).toBe('0');
      expect((await readRatingAggregateInventory(pool, context, originMain)).standing!.slots).toBe(2048);
      await oldest.query('COMMIT');
    } finally { await oldest.query('ROLLBACK'); oldest.release(); }
    expect((await pool.query('SELECT pending FROM access.rating_standing_publication($1,$2)', [context, originMain])).rows[0].pending).toBe('0');
    expect(await checkRatingAggregateFence(pool, beforeTransition.recoveryGeneration, undefined, [{ context, mainVersion: originMain, generation: beforeTransition.standingGeneration! }])).toBe(false);
    expect((await readRatingAggregateInventory(pool, context, originMain)).standing!.slots).toBe(2048);

    const legacy = items.slice(0, 201).map(item => ({ ...item, admission: randomUUID(), observation: id(), revision: id(),
      slot: standingRatingSlotIri(item.principal, context, legacyMain) }));
    await heads(legacy, legacyMain, work, false);
    expect(await component(legacyMain)).toEqual({ slots: 201, unvalued: 201, histogram: {} });
    expect((await listTargetsNeedingReconstruction(pool, { context, standing: true })).targets)
      .toContainEqual({ context, target: legacyMain, slots: 201, unvalued: 201 });
    let after = '', generation = '', scanned = 0;
    for (const size of [100, 100, 1, 0]) {
      const page = await readStandingRatingReconstructionBatch(pool, context, legacyMain, after, 100);
      expect(page.heads).toHaveLength(size);
      generation = page.recoveryGeneration;
      const verified = page.heads.map(head => ({ mainVersion: head.mainVersion!, slot: head.slot, revision: head.revision, value: 5 }));
      expect(await recordStandingRatingValues(pool, context, generation, verified)).toBe(size);
      expect(await recordStandingRatingValues(pool, context, generation, verified)).toBe(0);
      after = page.heads.at(-1)?.effectiveSlot ?? after;
      scanned += size;
      await expectExact(legacyMain);
    }
    expect(scanned).toBe(201);
    expect(await component(legacyMain)).toEqual({ slots: 201, unvalued: 0, histogram: { '5': 201 } });
    expect((await listTargetsNeedingReconstruction(pool, { context, standing: true })).targets).toEqual([]);
    const last = legacy[0]!;
    expect(await recordStandingRatingValues(pool, context, generation,
      [{ mainVersion: legacyMain, slot: last.slot, revision: id(), value: 9 }])).toBe(0);
    await expect(recordStandingRatingValues(pool, context, 'stale-generation', [])).rejects.toThrow('Recovery fence changed');
    const cancellation = new AbortController(); cancellation.abort();
    await expect(readStandingRatingReconstructionBatch(pool, context, legacyMain, '', 100, cancellation.signal)).rejects.toThrow();
    await expect(readStandingRatingReconstructionBatch(pool, context, legacyMain, '', 101)).rejects.toThrow('invalid standing reconstruction page');
  } finally {
    await metricsPool.end();
    await pool.end();
    await databases.close();
  }
}, 120_000);
