import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { canonicalCandidate } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { itemCommandKey } from '../../../services/main/src/modules/identity-merge/contract.ts';
import { fenceStandingRatingTransition, refreshStandingRatingProjections } from '../../../services/main/src/modules/rating/standing-publication.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface NativePlan { Plan: PlanNode; 'Query Text'?: string }
interface PlanNode {
  'Node Type': string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number; Plans?: PlanNode[];
}
const rowWork = (node: PlanNode): number => ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)
  + (node['Rows Removed by Join Filter'] ?? 0)) * (node['Actual Loops'] ?? 0)
  + (node.Plans ?? []).reduce((n, child) => n + rowWork(child), 0);
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

/** This private native fixture measures the actual owner functions, including
 * SQL hidden inside triggers. It is not a corpus or public outcome assertion;
 * rating-standing-availability exercises genuine editorial/graph composition. */
test('standing lineage discovery persists limit-one progress without recursive depth, breadth or exhausted-history work', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'privileged');
  const pool = new Pool({ connectionString: databases.urls.access, max: 1 });
  const context = id(), sourceWork = id(), sourceMainVersion = id(), survivorWork = id(), survivorMainVersion = id();
  const cut = { sourceWork, sourceMainVersion, survivorWork, survivorMainVersion, originalKey: null as string | null };
  const principal = randomUUID(), actor = id(), proposal = randomUUID();
  const original = `editorial:${proposal}:1`, inverse = `editorial:${proposal}:2`;
  const source = { resource: sourceWork, revision: id() }, survivor = { resource: survivorWork, revision: id() };
  const plans: NativePlan[] = [], measurements: { label: string; plans: NativePlan[] }[] = [];
  let capture = false;
  const measure = async <T>(label: string, operation: () => Promise<T>) => {
    plans.length = 0; capture = true;
    await pool.query('RESET ROLE; SET auto_explain.log_min_duration=0; SET ROLE access');
    try {
      const result = await operation();
      // Nested SQL must be visible: a Function Scan alone says nothing about
      // hidden work. Timing is disabled but rows, loops and buffers are native.
      expect(plans.some(plan => nodes(plan.Plan).some(node => node['Relation Name']?.startsWith('rating_standing_')))).toBe(true);
      expect(plans.every(plan => !nodes(plan.Plan).some(node => node['Node Type'] === 'Recursive Union'))).toBe(true);
      expect(Math.max(...plans.map(plan => rowWork(plan.Plan)))).toBeLessThan(512);
      measurements.push({ label, plans: structuredClone(plans) });
      return result;
    } finally {
      capture = false;
      await pool.query('RESET ROLE; SET auto_explain.log_min_duration=-1; SET ROLE access');
    }
  };
  try {
    const client = await pool.connect();
    client.on('notice', notice => {
      if (!capture) return;
      const message = notice.message ?? '';
      const start = message.indexOf('{');
      if (start < 0) return;
      const value = JSON.parse(message.slice(start)) as NativePlan;
      if (value.Plan) plans.push(value);
    });
    try {
      await client.query("LOAD 'auto_explain'");
      await client.query(`SET auto_explain.log_analyze=on; SET auto_explain.log_timing=off;
        SET auto_explain.log_buffers=on; SET auto_explain.log_nested_statements=on;
        SET auto_explain.log_format=json; SET auto_explain.log_level=notice;
        SET auto_explain.log_min_duration=-1; SET statement_timeout='5s'; SET lock_timeout='2s'; SET ROLE access`);
    } finally { client.release(); }
    await pool.query("INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1::uuid,'standing-work',$1::text)", [principal]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent')", [actor]);
    await pool.query(`INSERT INTO access.editorial_proposal
      (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
      VALUES($1,'merge',$2,$3,'urn:rezics:context:global',$3,$4,$5,$6,ARRAY[$4::uuid])`,
    [proposal,source,sourceWork,principal,actor,'2'.repeat(64)]);
    const task = async (n: number) => {
      const key = `editorial:${proposal}:${n}`, application = randomUUID();
      const canonical = canonicalCandidate({ operation:n === 1 ? 'merge' : 'unmerge', source,survivor,evidence:[],
        ...(n === 1 ? {} : { original }) });
      await pool.query(`INSERT INTO access.editorial_revision
        (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,author_agent)
        VALUES($1,$2,$3,$4,'null',$5,'[]',$6)`,
      [proposal,n,JSON.stringify(canonical.candidate),canonical.digest,JSON.stringify([source,survivor]),actor]);
      await pool.query(`INSERT INTO access.editorial_application
        (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$1::text,$7,false,2,'Bounded lineage native fixture')`,
      [application,proposal,n,principal,actor,key,canonical.digest]);
      await pool.query(`INSERT INTO access.identity_merge_task(task_key,application,candidate_digest,plan,data_epoch,handlers,original_key)
        VALUES($1,$2,$3,$4,'standing-work','[{"owner":"rating","version":"effective-person-vote-v3"}]',$5)`,
      [key,application,canonical.digest,JSON.stringify(canonical.candidate),n === 1 ? null : original]);
    };
    const complete = async (key: string) => {
      await pool.query("INSERT INTO access.identity_merge_page(task_key,owner,page,exhausted) VALUES($1,'rating',1,true)", [key]);
      await pool.query(`INSERT INTO access.identity_merge_completion(task_key,receipt,command_key,result)
        VALUES($1,'urn:standing-work:complete:'||$1,$2,'null')`,[key,itemCommandKey(key,'identity-merge','$finalize')]);
    };
    await task(1);
    expect(await fenceStandingRatingTransition(pool,original,cut)).toBe('pending');
    await complete(original);

    // A long chain and a broad frontier share one retained root. Unique node
    // identities model private retained histories without inventing graph proof.
    const lineage: { context: string; lineage: string; task_key: string; parent_lineage: string | null }[] = [];
    const path = (key: string, parent: string | null) => createHash('sha256').update(JSON.stringify([key,parent])).digest('hex');
    const root = path(original,null);
    lineage.push({ context,lineage:root,task_key:original,parent_lineage:null });
    let parent = root;
    for (let n = 0; n < 256; n++) {
      const key = `editorial:${randomUUID()}:1`, child = path(key,parent);
      lineage.push({ context,lineage:child,task_key:key,parent_lineage:parent }); parent = child;
    }
    for (let n = 0; n < 512; n++) {
      const key = `editorial:${randomUUID()}:1`, child = path(key,root);
      lineage.push({ context,lineage:child,task_key:key,parent_lineage:root });
    }
    await pool.query(`INSERT INTO access.rating_standing_lineage(context,lineage,task_key,parent_lineage)
      SELECT context,lineage,task_key,parent_lineage FROM jsonb_to_recordset($1::jsonb)
        x(context text,lineage text,task_key text,parent_lineage text)`,[JSON.stringify(lineage)]);
    // Exhausted transitions stay in the authority history but not the live
    // continuation index. New reads and retries must never aggregate them.
    const history = Array.from({length:2048},() => `editorial:${randomUUID()}:1`);
    await pool.query(`INSERT INTO access.rating_standing_transition
      (task_key,source_work,source_main_version,survivor_work,survivor_main_version,finished,prepared)
      SELECT x,$2,$3,$4,$5,true,true FROM jsonb_array_elements_text($1::jsonb) x`,
    [JSON.stringify(history),sourceWork,sourceMainVersion,survivorWork,survivorMainVersion]);
    await task(2);
    await pool.query(`INSERT INTO access.rating_standing_transition
      (task_key,source_work,source_main_version,survivor_work,survivor_main_version,original_key)
      VALUES($1,$2,$3,$4,$5,$6)`,[inverse,sourceWork,sourceMainVersion,survivorWork,survivorMainVersion,original]);
    const advance = async () => (await pool.query('SELECT * FROM access.advance_rating_standing_transition($1,1)',[inverse])).rows[0];
    expect(await measure('preparation: first limit-one page',advance)).toMatchObject({steps:1,prepared:false,refreshed:0});
    const firstCursor = (await pool.query('SELECT * FROM access.rating_standing_progress WHERE task_key=$1',[inverse])).rows[0];
    const cancelled = new AbortController(); cancelled.abort();
    await expect(fenceStandingRatingTransition(pool,inverse,{...cut,originalKey:original},cancelled.signal)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM access.rating_standing_progress WHERE task_key=$1',[inverse])).rows[0]).toEqual(firstCursor);
    let pages = 1;
    for (; pages < 4096; pages++) {
      const value = pages % 128 === 0 ? await measure(`preparation: page ${pages}`,advance) : await advance();
      expect(value.steps).toBe(1);
      if (value.prepared) break;
    }
    expect(pages).toBeLessThan(4096);
    expect(Number((await pool.query('SELECT count(*) FROM access.rating_standing_lineage WHERE revoked_by=$1',[inverse])).rows[0].count)).toBe(lineage.length);
    expect(await fenceStandingRatingTransition(pool,inverse,{...cut,originalKey:original})).toBe('pending');
    expect((await pool.query('SELECT access.rating_standing_merge_revoked($1,$2) AS revoked',[context,parent])).rows[0].revoked).toBe(false);
    await measure('journal completion: bounded first cleanup page',() => complete(inverse));
    expect((await measure('deep leaf revocation: point read',() => pool.query(
      'SELECT access.rating_standing_merge_revoked($1,$2) AS revoked',[context,parent]))).rows[0].revoked).toBe(true);
    let cleanupPages = 0;
    for (; cleanupPages < 2048; cleanupPages++) {
      const operation = () => refreshStandingRatingProjections(pool,{limit:1});
      const value = cleanupPages % 128 === 0 ? await measure(`cleanup: page ${cleanupPages}`,operation) : await operation();
      expect(value.refreshed).toBe(0); // metadata work is not a deleted rating
      if (value.complete) break;
    }
    expect(cleanupPages).toBeLessThan(2048);
    expect(await measure('exhausted history: retry',() => refreshStandingRatingProjections(pool,{limit:1})))
      .toMatchObject({refreshed:0,complete:true});
    expect(await measure('finished identity: replay',() => fenceStandingRatingTransition(pool,inverse,{...cut,originalKey:original}))).toBe('finished');
    console.log('standing lineage native work',JSON.stringify({nodes:lineage.length,depth:256,breadth:512,history:history.length,pages,cleanupPages,
      samples:measurements.map(({label,plans:sample}) => ({label,maxExamined:Math.max(...sample.map(plan => rowWork(plan.Plan)))}))}));
    await Bun.write(`${import.meta.dir}/../../../.temp/goal/standing-lineage-native-work.json`,JSON.stringify(measurements));
  } finally {
    await pool.end();
    await databases.close();
  }
},120_000);
