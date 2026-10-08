import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { StatementPublicationSeek } from '../../../services/main/src/modules/statement/publication-seek.ts';

type Basis = Parameters<StatementPublicationSeek['begin']>[0];
type Reference = Parameters<StatementPublicationSeek['append']>[1][number];

type CapturedStatement = { sql: string; values: unknown[]; rows: number };
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
};

const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const executorRows = (plan: Plan) => (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
  + (plan['Rows Removed by Index Recheck'] ?? 0)) * plan['Actual Loops'];

/** Observe the owner's actual SQL, preserving its real pool, transactions and
 * bound values. No alternate query or planner configuration is substituted. */
function observe(pool: Pool) {
  const statements: CapturedStatement[] = [];
  let calls = 0;
  const query = async (connection: Pool | PoolClient,
    sql: string, values: unknown[] = []) => {
    calls++;
    const result = await connection.query(sql, values);
    if (/^\s*SELECT\b/iu.test(sql) && /FROM\s+access\.statement_seek\b/iu.test(sql))
      statements.push({ sql, values, rows: result.rows.length });
    return result;
  };
  const observed = new Proxy(pool, { get(target, member) {
    if (member === 'query') return (sql: string, values: unknown[] = []) => query(target, sql, values);
    if (member === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === 'query') return (sql: string, values: unknown[] = []) => query(connection, sql, values);
        const value = Reflect.get(connection, property);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, member);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  return { pool: observed, statements, get calls() { return calls; } };
}

async function explain(pool: Pool, statement: CapturedStatement) {
  const result = await pool.query<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${statement.sql}`, statement.values,
  );
  const plan = result.rows[0]!['QUERY PLAN'][0]!.Plan;
  const scans = nodes(plan).filter(node => node['Relation Name'] === 'statement_seek');
  expect(scans.length).toBeGreaterThan(0);
  return { plan, scans,
    returnedRows: statement.rows,
    executorRows: scans.reduce((count, scan) => count + executorRows(scan), 0),
    removedRows: scans.reduce((count, scan) => count + ((scan['Rows Removed by Filter'] ?? 0)
      + (scan['Rows Removed by Index Recheck'] ?? 0)) * scan['Actual Loops'], 0),
    sharedBlocks: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0) };
}

const native = () => `https://rezics.com/id/${randomUUID()}`;
const predicate = 'https://rezics.com/vocab/wikiFact';

function references(subject: string, count: number): Reference[] {
  return Array.from({ length: count }, (_, index) => ({ subject, predicate,
    meaningKey: `urn:rezics:meaning:${(index + 1).toString(16).padStart(64, '0')}`,
    statementId: native(), head: native(), source: null, hasEvidence: false, frameRefs: [] }));
}

/** This suite uses only the selected isolated QA Access database. Source basis
 * callbacks model captured authoritative heads; graph hooks and reader/Wiki
 * disclosure integration are intentionally outside this SQL qualification. */
async function sqlFixture() {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL)
    throw new Error('Run publication seek SQL checks through the isolated integration QA slot');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  const epochs = new Set<string>();
  try {
    const installed = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('access.statement_publication_seek_coverage')::text AS relation",
    );
    if (!installed.rows[0]?.relation) await pool.query(readFileSync(new URL(
      '../../../services/main/migrations/access/1773_statement_publication_seek.sql', import.meta.url,
    ), 'utf8'));
    const recovery = (await pool.query<{ open: boolean; generation: string }>(
      'SELECT open,generation::text FROM access.recovery_fence WHERE id=true',
    )).rows[0];
    if (!recovery?.open) throw new Error('Publication seek SQL fixture requires open Access recovery');
    return { pool, recovery,
      async basis(subject = native()): Promise<Basis> {
        const dataEpoch = randomUUID();
        epochs.add(dataEpoch);
        // Global raw replay is deliberately incomplete and at sequence zero.
        // The potential channel must use its exact local completion instead.
        await pool.query(`INSERT INTO access.statement_seek_coverage
          (data_epoch,through_sequence,complete) VALUES ($1,0,false)`, [dataEpoch]);
        return { dataEpoch, subject, membershipHead: native(), recoveryBasis: recovery.generation,
          global: 'no-current-facts', sourceStore: randomUUID() };
      },
      async close() {
        try {
          for (const epoch of epochs) {
            await pool.query('DELETE FROM access.statement_publication_seek_coverage WHERE data_epoch=$1', [epoch]);
            await pool.query('DELETE FROM access.statement_seek_coverage WHERE data_epoch=$1', [epoch]);
          }
        } finally { await pool.end(); }
      } };
  } catch (error) { await pool.end(); throw error; }
}

async function clearing(owner: StatementPublicationSeek, basis: Basis) {
  let checkpoint = await owner.begin(basis);
  let steps = 0;
  while (checkpoint.phase === 'clearing') {
    checkpoint = await owner.clearBatch(checkpoint);
    if (++steps > 40) throw new Error('Publication fixture clearing failed to progress');
  }
  return checkpoint;
}

function physicalPage(basis: Basis, count: number, offset: number, exhausted: boolean) {
  return {after:{storage:basis.sourceStore,phase:exhausted ? 2 as const : 0 as const,
    key:exhausted ? '' : offset.toString(16).padStart(64,'0'),seal:'a'.repeat(64)},
    rawExamined:count+(exhausted ? 0 : 1),exhausted};
}
async function build(owner: StatementPublicationSeek, basis: Basis, rows: Reference[]) {
  let checkpoint = await clearing(owner, basis);
  let steps = 0;
  for (let at = 0; ; at += 127) {
    const page = rows.slice(at, at + 127);
    const exhausted = page.length < 127;
    checkpoint = await owner.append(checkpoint, page, physicalPage(basis,page.length,at+page.length,exhausted), async () => true);
    steps++;
    if (exhausted) return { checkpoint, steps };
  }
}

async function rawRows(pool: Pool, basis: Basis, rows: Reference[]) {
  if (!rows.length) return;
  await pool.query(`INSERT INTO access.statement_seek
    (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,
      statement_head,publication_source,publication_evidence)
    SELECT $1,$2,predicate,meaning_key,statement_id,'*','[]'::jsonb,head,source,has_evidence
    FROM jsonb_to_recordset($3::jsonb) AS input_row(predicate text,meaning_key text,
      statement_id text,head text,source text,has_evidence boolean)`,
  [basis.dataEpoch, basis.subject, JSON.stringify(rows.map(row => ({ predicate: row.predicate,
    meaning_key: row.meaningKey, statement_id: row.statementId, head: row.head,
    source: row.source, has_evidence: row.hasEvidence })))]);
}

async function distantRows(pool: Pool, basis: Basis) {
  await pool.query(`INSERT INTO access.statement_seek
    (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,
      statement_head,publication_source,publication_evidence)
    SELECT $1,'https://rezics.com/id/' || md5($2 || ':subject:' || (n/32)::text)::uuid::text,
      $3,'urn:rezics:meaning:' || md5(n::text) || md5('meaning:' || n::text),
      'https://rezics.com/id/' || md5($2 || ':statement:' || n::text)::uuid::text,'*','[]'::jsonb,
      $4,$5,true FROM generate_series(1,4096) n`,
  [basis.dataEpoch, randomUUID(), predicate, native(), native()]);
}

test('Statement potential publication SQL visits remain local with 0, 320 and 4096 ordinary proposals and distant subjects', async () => {
  const fixture = await sqlFixture();
  const measured: Array<{ proposals: number; sqlCalls: number; returnedRows: number;
    executorRows: number; removedRows: number; sharedBlocks: number; buildSteps: number }> = [];
  try {
    for (const proposals of [0, 320, 4096]) {
      const basis = await fixture.basis();
      const rows = references(basis.subject, proposals + 2);
      const potential = [rows[0]!, rows.at(-1)!];
      potential[0]!.source = native();
      potential[0]!.hasEvidence = true;
      potential[1]!.hasEvidence = true;
      await rawRows(fixture.pool, basis, rows);
      await distantRows(fixture.pool, basis);
      const owner = new StatementPublicationSeek(fixture.pool);
      const prepared = await build(owner, basis, rows);
      expect(prepared.steps).toBe(Math.floor(rows.length / 127) + 1);
      await fixture.pool.query('ANALYZE access.statement_seek');
      const captured = observe(fixture.pool);
      const result = await new StatementPublicationSeek(captured.pool).seek(basis, null);
      expect(result.candidates.map(row => row.statementId)).toEqual(potential.map(row => row.statementId));
      expect(result.visitedRows).toBe(2);
      expect(captured.statements).toHaveLength(1);
      const physical = await explain(fixture.pool, captured.statements[0]!);
      expect(physical.returnedRows).toBe(2);
      expect(physical.executorRows).toBe(2);
      expect(physical.removedRows).toBe(0);
      expect(physical.sharedBlocks).toBeLessThanOrEqual(32);
      for (const scan of physical.scans) {
        expect(scan['Node Type']).toMatch(/^Index(?: Only)? Scan$/u);
        expect(scan['Index Name']).toBe('statement_publication_subject_seek');
        expect(scan['Index Cond']).toContain('data_epoch');
        expect(scan['Index Cond']).toContain('subject');
      }
      expect(nodes(physical.plan).some(node => node['Node Type'] === 'Sort')).toBe(false);
      const second = await owner.seek(basis, result.candidates[0]!);
      expect(second.candidates.map(row => row.statementId)).toEqual([potential[1]!.statementId]);
      const rawCoverage = (await fixture.pool.query<{ complete: boolean; sequence: string }>(
        'SELECT complete,through_sequence::text AS sequence FROM access.statement_seek_coverage WHERE data_epoch=$1',
        [basis.dataEpoch],
      )).rows[0];
      expect(rawCoverage).toEqual({ complete: false, sequence: '0' });
      measured.push({ proposals, sqlCalls: captured.calls, returnedRows: physical.returnedRows,
        executorRows: physical.executorRows, removedRows: physical.removedRows,
        sharedBlocks: physical.sharedBlocks, buildSteps: prepared.steps });
    }
    const baseline = measured[0]!;
    for (const result of measured.slice(1)) {
      expect(result.sqlCalls).toBe(baseline.sqlCalls);
      expect(result.sharedBlocks).toBeLessThanOrEqual(baseline.sharedBlocks + 8);
    }
    console.log(JSON.stringify({ statementPublicationSeekPhysical: measured }));
  } finally { await fixture.close(); }
}, 60_000);

test('Statement potential publication SQL includes evidence-only and source hints without accepting ordinary proposals', async () => {
  const fixture = await sqlFixture();
  try {
    const basis = await fixture.basis();
    const rows = references(basis.subject, 3);
    rows[1]!.source = native();
    rows[2]!.hasEvidence = true;
    await rawRows(fixture.pool, basis, rows);
    const owner = new StatementPublicationSeek(fixture.pool);
    await build(owner, basis, rows);
    expect((await owner.seek(basis, null)).candidates.map(row => row.statementId))
      .toEqual(rows.slice(1).map(row => row.statementId));
    const persisted = (await fixture.pool.query<{ source: string | null; evidence: boolean }>(
      `SELECT publication_source AS source,publication_evidence AS evidence FROM access.statement_seek
       WHERE data_epoch=$1 AND subject=$2 AND frame_key='*' ORDER BY predicate,meaning_key,statement_id`,
      [basis.dataEpoch, basis.subject],
    )).rows;
    expect(persisted).toEqual([{ source: null, evidence: false },
      { source: rows[1]!.source, evidence: false }, { source: null, evidence: true }]);
  } finally { await fixture.close(); }
});

test('Statement publication cold clear/build steps touch at most 128 local entries and preserve ordinary/distant rows', async () => {
  const fixture = await sqlFixture();
  try {
    const basis = await fixture.basis();
    const old = references(basis.subject, 300);
    old.forEach(row => { row.hasEvidence = true; });
    const ordinary = references(basis.subject, 300).map((row, index) => ({ ...row,
      meaningKey: `urn:rezics:meaning:${(index + 1001).toString(16).padStart(64, '0')}` }));
    await rawRows(fixture.pool, basis, [...old, ...ordinary]);
    await distantRows(fixture.pool, basis);
    const owner = new StatementPublicationSeek(fixture.pool);
    let checkpoint = await owner.begin(basis);
    const remaining = async () => Number((await fixture.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access.statement_seek WHERE data_epoch=$1 AND subject=$2
        AND frame_key='*' AND statement_head IS NOT NULL
        AND (publication_source IS NOT NULL OR publication_evidence)`, [basis.dataEpoch, basis.subject],
    )).rows[0]!.n);
    const removed: number[] = [];
    while (checkpoint.phase === 'clearing') {
      const before = await remaining();
      checkpoint = await owner.clearBatch(checkpoint);
      removed.push(before - await remaining());
    }
    expect(removed).toEqual([128, 128, 44]);
    expect(await remaining()).toBe(0);
    await expect(owner.seek(basis, null)).rejects.toThrow();
    const fresh = references(basis.subject, 257);
    fresh.forEach(row => { row.hasEvidence = true; });
    const sizes: number[] = [];
    for (let at = 0; at < fresh.length; at += 127) {
      const page = fresh.slice(at, at + 127);
      sizes.push(page.length);
      checkpoint = await owner.append(checkpoint, page, physicalPage(basis,page.length,at+page.length,page.length<127), async () => true);
      if (page.length === 127) await expect(owner.seek(basis, null)).rejects.toThrow();
    }
    expect(sizes).toEqual([127, 127, 3]);
    expect((await owner.seek(basis, null)).candidates.map(row => row.statementId))
      .toEqual(fresh.slice(0, 20).map(row => row.statementId));
    const preserved = Number((await fixture.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access.statement_seek WHERE data_epoch=$1
       AND (subject<>$2 OR NOT publication_evidence AND publication_source IS NULL)`,
      [basis.dataEpoch, basis.subject],
    )).rows[0]!.n);
    expect(preserved).toBe(4096 + 600);
  } finally { await fixture.close(); }
}, 60_000);

test('Statement publication checkpoint CAS rejects obsolete/lost-ack steps and stale captured source heads', async () => {
  const fixture = await sqlFixture();
  try {
    const basis = await fixture.basis();
    const rows = references(basis.subject, 2);
    rows.forEach(row => { row.hasEvidence = true; });
    const owner = new StatementPublicationSeek(fixture.pool);
    const checkpoint = await clearing(owner, basis);
    const racing = await Promise.allSettled([
      owner.append(checkpoint, rows, physicalPage(basis,rows.length,rows.length,true), async () => true),
      new StatementPublicationSeek(fixture.pool).append(checkpoint, rows, physicalPage(basis,rows.length,rows.length,true), async () => true),
    ]);
    expect(racing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(racing.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(owner.append(checkpoint, rows, physicalPage(basis,rows.length,rows.length,true), async () => true)).rejects.toThrow();
    expect((await owner.seek(basis, null)).candidates.map(row => row.statementId))
      .toEqual(rows.map(row => row.statementId));
    const changed = { ...basis, membershipHead: native() };
    const observed = observe(fixture.pool);
    await expect(new StatementPublicationSeek(observed.pool).seek(changed, null)).rejects.toThrow();
    expect(observed.statements).toEqual([]);
    // A relevant source commit has occurred, but Access has not installed its
    // refs yet. Unchanged older Statement heads do not prove completeness.
    const replacement = await clearing(owner, changed);
    await expect(owner.append(checkpoint, rows, physicalPage(basis,rows.length,rows.length,true), async () => true)).rejects.toThrow();
    await expect(owner.append(replacement, rows, physicalPage(basis,rows.length,rows.length,true), async () => false)).rejects.toThrow();
    await expect(owner.seek(changed, null)).rejects.toThrow();
  } finally { await fixture.close(); }
});

test('Statement publication coverage refuses held recovery and restored generations until local reconstruction', async () => {
  const fixture = await sqlFixture();
  try {
    const basis = await fixture.basis();
    const rows = references(basis.subject, 1);
    rows[0]!.hasEvidence = true;
    const owner = new StatementPublicationSeek(fixture.pool);
    await build(owner, basis, rows);
    await fixture.pool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
    await expect(owner.seek(basis, null)).rejects.toThrow();
    await fixture.pool.query('UPDATE access.recovery_fence SET open=true,generation=generation+1 WHERE id=true');
    const restored = { ...basis, recoveryBasis: (BigInt(basis.recoveryBasis) + 1n).toString() };
    await expect(owner.seek(basis, null)).rejects.toThrow();
    await expect(owner.seek(restored, null)).rejects.toThrow();
    await build(owner, restored, rows);
    expect((await owner.seek(restored, null)).candidates.map(row => row.statementId))
      .toEqual([rows[0]!.statementId]);
    // A source restore hold is represented by its authoritative final basis
    // verifier returning false; no actual Fuseki release is exercised here.
    const heldBasis = { ...await fixture.basis(basis.subject), recoveryBasis: restored.recoveryBasis };
    const heldBuild = await clearing(owner, heldBasis);
    let sourceVerified = false;
    await expect(owner.append(heldBuild, rows, physicalPage(heldBasis,rows.length,rows.length,true), async () => {
      sourceVerified = true;
      return false;
    })).rejects.toThrow('Publication build source basis moved');
    expect(sourceVerified).toBe(true);
    await expect(owner.seek(heldBasis, null)).rejects.toThrow();
  } finally {
    try { await fixture.pool.query('UPDATE access.recovery_fence SET open=$1,generation=$2 WHERE id=true',
      [fixture.recovery.open, fixture.recovery.generation]); }
    finally { await fixture.close(); }
  }
});

test('Statement publication absence completion cannot survive a new local source membership or epoch', async () => {
  const fixture = await sqlFixture();
  try {
    const basis = { ...await fixture.basis(), membershipHead: null };
    const owner = new StatementPublicationSeek(fixture.pool);
    await build(owner, basis, []);
    expect((await owner.seek(basis, null)).candidates).toEqual([]);
    await expect(owner.seek({ ...basis, membershipHead: native() }, null)).rejects.toThrow();
    await expect(owner.seek({ ...basis, dataEpoch: randomUUID() }, null)).rejects.toThrow();
  } finally { await fixture.close(); }
});

test('Statement publication physical checkpoint refuses a replaced store and SQL orders non-BMP potentials',async()=>{
  const fixture=await sqlFixture();
  try {
    const basis=await fixture.basis();
    const rows=references(basis.subject,2);
    rows[0]!.predicate='https://example.org/😀';
    rows[1]!.predicate='https://example.org/';
    rows.forEach(ref=>{ref.hasEvidence=true;});
    const owner=new StatementPublicationSeek(fixture.pool);
    await build(owner,basis,rows);
    expect((await owner.seek(basis,null)).candidates.map(ref=>ref.statementId))
      .toEqual([rows[1]!.statementId,rows[0]!.statementId]);
    const old=await owner.checkpoint(basis);
    expect(old?.physicalAfter).toEqual({storage:basis.sourceStore,phase:2,key:'',seal:'a'.repeat(64)});
    const replaced={...basis,sourceStore:randomUUID()};
    const captured=observe(fixture.pool);
    await expect(new StatementPublicationSeek(captured.pool).seek(replaced,null)).rejects.toThrow();
    expect(captured.statements).toEqual([]);
    const next=await owner.begin(replaced);
    expect(next.buildId).not.toBe(old!.buildId);
    expect(next).toMatchObject({physicalAfter:null,complete:false,phase:'clearing'});
    await build(owner,replaced,rows);
    expect((await owner.seek(replaced,null)).visitedRows).toBe(2);
  } finally {await fixture.close();}
});
