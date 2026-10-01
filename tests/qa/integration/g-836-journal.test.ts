import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { canonicalCandidate, type Json } from '../../../services/main/src/modules/editorial-review/contract.ts';
import type { MergeTaskRuntime } from '../../../services/main/src/modules/identity-merge/engine.ts';
import { runMergeFixture } from '../../../services/main/tests/g-836-task-driver.ts';
import { AccessMergeJournal } from '../../../services/main/src/modules/identity-merge/journal.ts';
import { assertMergeCoverage } from '../../../services/main/src/modules/identity-merge/handlers.ts';
import { discoverOwnerIdentityReferences }
  from '../../../services/main/src/modules/identity-merge/reference-discovery.ts';
import { itemCommandKey, MergeConflict, MergePending, type ItemOutcome, type MergeHandler, type MergeTask,
  type TaskCompletion } from '../../../services/main/src/modules/identity-merge/contract.ts';

/** This is real PostgreSQL journal/recovery evidence with a transactional probe
 * owner. It is deliberately not the public SAO merge acceptance journey; native
 * catalogue owner execution is exercised in g-836-sao-public-api.test.ts. */
test('G836: Access task/item ledger survives delivery loss, races, paging and exact compensating ambiguity', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const schema = `g836_${randomUUID().replaceAll('-', '')}`;
  const source = `https://rezics.com/id/${randomUUID()}`, survivor = `https://rezics.com/id/${randomUUID()}`;
  const sourceRevision = `https://rezics.com/id/${randomUUID()}`, survivorRevision = `https://rezics.com/id/${randomUUID()}`;
  const principal = randomUUID(), agent = `https://rezics.com/id/${randomUUID()}`;
  let loseAcknowledgement = true, effects = 0, finalizations = 0;
  const makeTask = async (original?: MergeTask, required: 1 | 2 = 2): Promise<MergeTask> => {
    const proposal = randomUUID(), application = randomUUID();
    const plan = { operation: original ? 'unmerge' : 'merge', source: { resource: source, revision: sourceRevision },
      survivor: { resource: survivor, revision: survivorRevision },
      evidence: [{ resource: source, revision: sourceRevision, locator: null }],
      ...(original ? { original: original.key } : {}) } as MergeTask['plan'];
    const canonical = canonicalCandidate(plan);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Bootstrap an immutable lifecycle application, not an alternative
      // approval implementation. Review/admission policy belongs to G-865.
      await client.query(`INSERT INTO access.editorial_proposal
        (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
        VALUES ($1,'merge',$2,$3,'urn:rezics:context:global',$3,$4,$5,$6,ARRAY[$4::uuid])`,
      [proposal, { resource: source, revision: sourceRevision, context: 'urn:rezics:context:global', work: source },
        source, principal, agent, '1'.repeat(64)]);
      await client.query(`INSERT INTO access.editorial_revision
        (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,author_agent)
        VALUES ($1,1,$2,$3,'null',$4,$5,$6)`, [proposal, JSON.stringify(canonical.candidate), canonical.digest,
        JSON.stringify([{ component: source, head: sourceRevision }, { component: survivor, head: survivorRevision }]),
        JSON.stringify(plan.evidence), agent]);
      await client.query(`INSERT INTO access.editorial_application
        (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,required,message)
        VALUES ($1,$2,1,$3,$4,$5,$7,$6,false,$8,'Probe admitted application')`,
      [application, proposal, principal, agent, `editorial:${proposal}:1`, canonical.digest, application, required]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { key: `editorial:${proposal}:1`, application, candidateDigest: canonical.digest, plan,
      dataEpoch: 'g836-probe-epoch', handlers: [{ owner: 'probe', version: 'v1' }] };
  };
  interface NativeRow { id: string; target: string; head: string; value: string }
  const commit = async (task: MergeTask, key: string, work: () => Promise<ItemOutcome | TaskCompletion>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const prior = (await client.query<{ result: ItemOutcome | TaskCompletion }>(
        `SELECT result FROM ${schema}.receipt WHERE key = $1`, [key])).rows[0];
      if (prior) { await client.query('COMMIT'); return prior.result; }
      // Execute the native effect on THIS connection together with its receipt.
      const result = await work();
      await client.query(`INSERT INTO ${schema}.receipt (key,task,result) VALUES ($1,$2,$3)`,
        [key, task.key, JSON.stringify(result)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  // Each native owner effect has its own transaction and stable receipt. Keeping
  // this separate from Access is essential to exercise the uncertain-write gap.
  const nativeItem = async (task: MergeTask, item: { key: string; expectedHead: string | null; before: Json }, key: string,
    original?: { result: ItemOutcome; before: Json }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const prior = (await client.query<{ result: ItemOutcome }>(`SELECT result FROM ${schema}.receipt WHERE key=$1`, [key])).rows[0];
      if (prior) { await client.query('COMMIT'); return prior.result; }
      const row = (await client.query<NativeRow>(`SELECT * FROM ${schema}.item WHERE id=$1 FOR UPDATE`, [item.key])).rows[0]!;
      const expected = original ? original.result.afterHead : item.expectedHead;
      const matches = row.head === expected;
      if (!matches && !original) throw new MergeConflict('probe owner stale');
      const before = original?.before as unknown as NativeRow | undefined;
      if (matches) {
        row.target = original ? before!.target : survivor;
        row.head = randomUUID();
        row.value = original ? before!.value : row.value;
        await client.query(`UPDATE ${schema}.item SET target=$2,head=$3,value=$4 WHERE id=$1`,
          [row.id, row.target, row.head, row.value]); effects++;
      }
      const result: ItemOutcome = { outcome: matches ? 'moved' : 'ambiguous', commandKey: key,
        receipt: `urn:g836:${key}`, afterHead: row.head, after: { ...row } };
      await client.query(`INSERT INTO ${schema}.receipt (key,task,result) VALUES ($1,$2,$3)`, [key, task.key, JSON.stringify(result)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const handler: MergeHandler = { owner: 'probe', version: 'v1', references: [`table:${schema}.item.target`],
    cost: { page: 16, callsPerItem: 5, bytesPerItem: 8192 },
    async preview() {
      const rows = (await pool.query(`SELECT id FROM ${schema}.item WHERE target=$1 LIMIT 17`, [source])).rows;
      return { owner: 'probe', count: Math.min(rows.length, 16), complete: rows.length <= 16 };
    },
    async plan(_task, after, limit) {
      const rows = (await pool.query<NativeRow>(`SELECT * FROM ${schema}.item WHERE target=$1
        AND ($2::text IS NULL OR id > $2 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $3`, [source, after, limit + 1])).rows;
      const kept = rows.slice(0, limit);
      return { items: kept.map(row => ({ key: row.id, expectedHead: row.head, before: { ...row } })),
        next: rows.length > limit ? kept.at(-1)!.id : null };
    },
    async apply(wanted, item, key) {
      const result = await nativeItem(wanted, item, key);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('probe killed after native commit'); }
      return result;
    },
    async compensate(wanted, original, key) { return nativeItem(wanted, original, key, original); },
  };
  const runtime: MergeTaskRuntime<unknown> = { dependencies: {}, dataEpoch: 'g836-probe-epoch', checkDeadline() {},
    async begin(wanted) {
      expect((await pool.query('SELECT 1 FROM access.identity_merge_task WHERE task_key=$1', [wanted.key])).rowCount).toBe(1);
    },
    async finish(wanted, key) {
      return await commit(wanted, key, async () => {
        finalizations++;
        return { receipt: `urn:g836:${key}`, commandKey: key, result: { source, survivor } };
      }) as TaskCompletion;
    } };
  try {
    await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,'g836-probe',$2)`, [principal, principal]);
    await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [agent]);
    await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.item (
      id text COLLATE "C" PRIMARY KEY,target text NOT NULL CHECK (target ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
      head text NOT NULL,value text NOT NULL);
      CREATE TABLE ${schema}.receipt (key text PRIMARY KEY,task text NOT NULL,result jsonb NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.item SELECT 'item-' || lpad(n::text,5,'0'),$1,gen_random_uuid()::text,'value-' || n
      FROM generate_series(0,64) n`, [source]);
    const wanted = await makeTask();
    const journal = new AccessMergeJournal(pool);
    await expect(runMergeFixture(wanted, journal, [handler], runtime)).rejects.toThrow('killed after native commit');
    expect(effects).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM access.identity_merge_item_outcome WHERE task_key=$1', [wanted.key])).rows[0].n).toBe(0);
    await expect(pool.query(`INSERT INTO access.identity_merge_page (task_key,owner,page,after_key,next_key,exhausted)
      VALUES ($1,'probe',2,'item-00015',NULL,true)`, [wanted.key])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO access.identity_merge_item_outcome
      (task_key,owner,item_key,outcome,command_key,receipt,after_head,after_state,result_digest)
      VALUES ($1,'probe','item-00000','moved','substituted','urn:wrong','after','{}',$2)`,
      [wanted.key, '0'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    // A fresh runtime/journal models restart; no in-memory delivery state is reused.
    const fresh = new AccessMergeJournal(pool);
    let result = await runMergeFixture(wanted, fresh, [handler], runtime);
    expect(result.state).toBe('pending');
    while (result.state === 'pending') result = await runMergeFixture(wanted, fresh, [handler], runtime);
    expect(effects).toBe(65); expect(finalizations).toBe(1);
    expect((await runMergeFixture(wanted, fresh, [handler], runtime)).completion).toEqual(result.completion);
    expect(effects).toBe(65);
    await expect(pool.query('UPDATE access.identity_merge_item SET before_state=before_state WHERE task_key=$1', [wanted.key]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM access.identity_merge_item_outcome WHERE task_key=$1', [wanted.key]))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE ${schema}.item SET head=gen_random_uuid()::text,value='later edit' WHERE id='item-00001'`);
    await pool.query(`INSERT INTO ${schema}.item VALUES ('new-survivor-item',$1,gen_random_uuid()::text,'never moved')`, [survivor]);
    const undo = await makeTask(wanted);
    let undone = await runMergeFixture(undo, fresh, [handler], runtime);
    while (undone.state === 'pending') undone = await runMergeFixture(undo, fresh, [handler], runtime);
    const rows = (await pool.query<NativeRow>(`SELECT * FROM ${schema}.item ORDER BY id`)).rows;
    expect(rows.filter(row => row.target === source)).toHaveLength(64);
    expect(rows.find(row => row.id === 'item-00001')).toMatchObject({ target: survivor, value: 'later edit' });
    expect(rows.find(row => row.id === 'new-survivor-item')).toMatchObject({ target: survivor, value: 'never moved' });
    expect((await pool.query(`SELECT item_key,outcome FROM access.identity_merge_item_outcome
      WHERE task_key=$1 AND outcome='ambiguous'`, [undo.key])).rows).toEqual([{ item_key: 'item-00001', outcome: 'ambiguous' }]);
    expect(effects).toBe(129);
    await runMergeFixture(undo, fresh, [handler], runtime); expect(effects).toBe(129);

    // Journal lock contention returns pending, rather than dispatching in parallel.
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = journal.locked(wanted.key, async () => { enter(); await gate; });
    try { await entered; await expect(fresh.locked(wanted.key, async () => {})).rejects.toBeInstanceOf(MergePending); }
    finally { release(); await held; }

    const malformed = await makeTask();
    await expect(journal.locked(malformed.key, scope => scope.prepare({ ...malformed, application: wanted.application })))
      .rejects.toMatchObject({ code: '23514' });
    await journal.locked(malformed.key, async scope => {
      await scope.prepare(malformed);
      await expect(scope.finish({ receipt: 'urn:premature', commandKey: itemCommandKey(malformed.key, 'identity-merge', '$finalize'),
        result: {} })).rejects.toMatchObject({ code: '23514' });
    });
    const oneApprovalPolicy = await makeTask(undefined, 1);
    await expect(journal.locked(oneApprovalPolicy.key, scope => scope.prepare(oneApprovalPolicy)))
      .rejects.toMatchObject({ code: '23514' });
    const duplicateUndo = await makeTask(wanted);
    await expect(journal.locked(duplicateUndo.key, scope => scope.prepare(duplicateUndo))).rejects.toMatchObject({ code: '23505' });
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  }
}, 120_000);

test('G836: SQL person-state discovery sees an empty new owner table and rejects missing policy', async () => {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const schema = `g836_coverage_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.item (principal_id uuid,target text)`);
    const reference = `table:${schema}.item.target`;
    expect(await discoverOwnerIdentityReferences(pool)).toContain(reference);
    const handler = { owner: 'probe',version: 'v1',references: ['table:probe.work'],cost: { page: 1,callsPerItem: 1,bytesPerItem: 1 },
      preview: async () => ({ owner: 'probe',count: 0,complete: true }),plan: async () => ({ items: [],next: null }),
      apply: async () => { throw new Error('unused'); },compensate: async () => { throw new Error('unused'); } } satisfies MergeHandler;
    expect(() => assertMergeCoverage([reference],[handler],{})).toThrow('lack merge coverage');
    expect(() => assertMergeCoverage([reference],[handler],{ [reference]: 'Synthetic excluded exact attempt' })).not.toThrow();
  } finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); }
});
