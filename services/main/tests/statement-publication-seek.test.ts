import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StatementPublicationSeek, STATEMENT_PUBLICATION_SEEK_COST,
  type StatementPublicationBasis, type StatementPublicationCheckpoint, type StatementPublicationReference }
  from '../src/modules/statement/publication-seek.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const basis: StatementPublicationBasis = { dataEpoch: 'epoch', subject: id(1), membershipHead: id(2),
  recoveryBasis: '9', global: 'no-current-facts', sourceStore: 'native-store' };
const order = (n: number) => ({ predicate: 'https://rezics.com/vocab/classifiedAs',
  meaningKey: `urn:rezics:meaning:${n.toString(16).padStart(64, '0')}`, statementId: id(n + 10) });
const reference = (n: number, fields: Partial<StatementPublicationReference> = {}): StatementPublicationReference => ({
  ...order(n), subject: basis.subject, head: id(n + 1000), source: null, hasEvidence: false, frameRefs: [], ...fields,
});
const cursor = (phase: 0 | 1 | 2, n = 1) => ({ storage: basis.sourceStore, phase,
  key: phase === 2 ? '' : n.toString(16).padStart(phase === 0 ? 64 : 48, '0'),seal:'a'.repeat(64) });
const page = (exhausted: boolean, rawExamined = 1, n = 1) => ({
  after: cursor(exhausted ? 2 : 0,n), rawExamined, exhausted,
});
const checkpoint = (fields: Partial<StatementPublicationCheckpoint> = {}): StatementPublicationCheckpoint => ({
  basis, buildId: '00000000-0000-0000-0000-000000000003', stepRevision: '1', phase: 'building',
  physicalAfter: fields.complete ? cursor(2) : null, complete: false, ...fields,
});
type Coverage = { membership_head: string | null; recovery_basis: string; build_id: string; step_revision: string;
  phase: 'clearing' | 'building'; complete: boolean; native_storage: string;
  physical_cursor: StatementPublicationCheckpoint['physicalAfter'] };
const coverage = (value: StatementPublicationCheckpoint): Coverage => ({
  membership_head: value.basis.membershipHead, recovery_basis: value.basis.recoveryBasis,
  build_id: value.buildId, step_revision: value.stepRevision, phase: value.phase, complete: value.complete,
  native_storage: value.basis.sourceStore, physical_cursor: value.physicalAfter,
});
type Candidate = { subject: string; predicate: string; meaning_key: string; statement_id: string; statement_head: string };
const candidate = (ref: StatementPublicationReference): Candidate => ({ subject: ref.subject, predicate: ref.predicate,
  meaning_key: ref.meaningKey, statement_id: ref.statementId, statement_head: ref.head });

/** A small SQL client harness observes the real helper's transactions. Real
 * index membership, executor work and constraints are tested against Postgres. */
function database(initial: Coverage | null = coverage(checkpoint())) {
  const state = { row: initial, writes: [] as unknown[][], candidates: [] as Candidate[],
    clearingIds: [] as string[], open: true, recovery: '9', failCas: false, loseCommitAck: false,
    connections: 0, releases: 0, queries: [] as { sql: string; values: unknown[] }[] };
  let snapshot: { row: Coverage | null; writes: unknown[][] } | null = null;
  const client = { query: async (sql: string, values: unknown[] = []) => {
    state.queries.push({ sql, values });
    if (sql.startsWith('BEGIN')) {
      snapshot = { row: state.row ? { ...state.row } : null, writes: [...state.writes] };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      snapshot = null;
      if (state.loseCommitAck) { state.loseCommitAck = false; throw new Error('commit acknowledgement lost'); }
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (snapshot) { state.row = snapshot.row; state.writes = snapshot.writes; }
      snapshot = null;
      return { rows: [] };
    }
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ generation: state.recovery, open: state.open }] };
    if (sql.includes('FROM access.statement_publication_seek_coverage')) return { rows: state.row ? [{ ...state.row }] : [] };
    if (sql.startsWith('INSERT INTO access.statement_publication_seek_coverage')) {
      state.row = { membership_head: values[2] as string | null, recovery_basis: values[3] as string,
        build_id: values[4] as string, step_revision: '0', phase: 'clearing', complete: false,
        native_storage: values[5] as string, physical_cursor: null };
      return { rows: [{ ...state.row }] };
    }
    if (sql.startsWith('UPDATE access.statement_publication_seek_coverage')) {
      if (state.failCas || !state.row) return { rows: [] };
      state.row = { ...state.row, phase: values[4] as Coverage['phase'],
        physical_cursor: values[5] === null ? null : JSON.parse(values[5] as string),
        complete: values[6] as boolean, step_revision: String(BigInt(state.row.step_revision) + 1n) };
      return { rows: [{ ...state.row }] };
    }
    if (sql.startsWith('INSERT INTO access.statement_seek\n')) { state.writes.push(values); return { rows: [] }; }
    if (sql.startsWith('SELECT statement_id,predicate,meaning_key FROM access.statement_seek'))
      return { rows: state.clearingIds.map((statement_id,n) => ({ statement_id,
        predicate: order(n).predicate,meaning_key: order(n).meaningKey })) };
    if (sql.startsWith('SELECT subject,predicate,meaning_key,statement_id,statement_head')) return { rows: state.candidates };
    return { rows: [] };
  }, release: () => { state.releases++; } };
  const pool = { connect: async () => { state.connections++; return client; } } as unknown as Pool;
  return { state, seek: new StatementPublicationSeek(pool) };
}
const candidateQueries = (run: ReturnType<typeof database>) => run.state.queries.filter(query =>
  query.sql.startsWith('SELECT subject,predicate,meaning_key,statement_id,statement_head'));

test('Publication seek requires actual no-current-facts marker before accessing Access', async () => {
  for (const global of ['absent', 'withdrawn', 'active', null]) {
    const run = database();
    const invalid = { ...basis, global } as unknown as StatementPublicationBasis;
    await expect(run.seek.seek(invalid, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await expect(run.seek.begin(invalid)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.connections).toBe(0);
  }
});

test('Publication seek rejects malformed local bases and raw cursors before SQL', async () => {
  for (const invalid of [{ ...basis, subject: 'urn:wrong' }, { ...basis, recoveryBasis: '-1' },
    { ...basis, recoveryBasis: '09' }, { ...basis, dataEpoch: '' }, { ...basis, membershipHead: 'not an IRI' },
    { ...basis, sourceStore: '' }]) {
    const run = database();
    await expect(run.seek.seek(invalid, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.connections).toBe(0);
  }
  const run = database();
  await expect(run.seek.seek(basis, { ...order(1), meaningKey: 'urn:invalid' })).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(run.state.connections).toBe(0);
});

test('Publication seek refuses missing, incomplete or changed local coverage before candidate access', async () => {
  for (const row of [null, coverage(checkpoint()), coverage(checkpoint({ complete: true,
    basis: { ...basis, membershipHead: id(3) } })), coverage(checkpoint({ complete: true,
    basis: { ...basis, recoveryBasis: '8' } }))]) {
    const run = database(row);
    await expect(run.seek.seek(basis, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(candidateQueries(run)).toHaveLength(0);
    expect(run.state.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(run.state.releases).toBe(1);
  }
});

test('Publication seek and builder refuse held or replaced recovery before local index access', async () => {
  for (const fence of [{ open: false, recovery: '9' }, { open: true, recovery: '10' }]) {
    const run = database(coverage(checkpoint({ complete: true })));
    Object.assign(run.state, fence);
    await expect(run.seek.seek(basis, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await expect(run.seek.begin(basis)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.queries.some(query => query.sql.includes('access.statement_publication_seek_coverage'))).toBe(false);
    expect(candidateQueries(run)).toHaveLength(0);
  }
});

test('Publication begin resumes durable checkpoint and replaces stale coverage without certifying raw replay', async () => {
  const prior = checkpoint({ physicalAfter: cursor(0,8), stepRevision: '4' });
  const run = database(coverage(prior));
  expect(await run.seek.begin(basis)).toEqual(prior);
  const next = await run.seek.begin({ ...basis, membershipHead: id(4) });
  expect(next.buildId).not.toBe(prior.buildId);
  expect(next).toMatchObject({ phase: 'clearing', complete: false, physicalAfter: null, stepRevision: '0' });
  const rawWrite = run.state.queries.find(query => query.sql.startsWith('INSERT INTO access.statement_seek_coverage'));
  expect(rawWrite?.sql).toContain('0,false');
  expect(rawWrite?.sql).toContain('ON CONFLICT DO NOTHING');
  expect(run.state.queries.some(query => query.sql.includes('SET through_sequence'))).toBe(false);
});

test('Publication clearing retains raw rows and stops at a bounded batch before building', async () => {
  const cp = checkpoint({ phase: 'clearing' });
  const run = database(coverage(cp));
  run.state.clearingIds = Array.from({ length: STATEMENT_PUBLICATION_SEEK_COST.buildEntries }, (_, n) => id(n + 10));
  const first = await run.seek.clearBatch(cp);
  expect(first.phase).toBe('clearing');
  expect(first.complete).toBe(false);
  const selection = run.state.queries.find(query => query.sql.startsWith('SELECT statement_id,predicate,meaning_key FROM access.statement_seek'))!;
  expect(selection.sql).toContain('LIMIT 128');
  const clearing = run.state.queries.find(query => query.sql.startsWith('UPDATE access.statement_seek SET'))!;
  expect(clearing.values[2]).toHaveLength(128);
  expect(clearing.sql).toContain('statement_head=NULL');
  expect(clearing.sql).toContain('publication_evidence=false');
  expect(run.state.queries.some(query => query.sql.startsWith('DELETE'))).toBe(false);
  run.state.clearingIds = [];
  const next = await run.seek.clearBatch(first);
  expect(next).toMatchObject({ phase: 'building', complete: false, physicalAfter: null, stepRevision: '3' });
});

test('Publication append validates total physical work, incarnation, EOF and provenance before SQL', async () => {
  const cp = checkpoint();
  const failures = [
    { refs: Array.from({ length: 129 }, (_, n) => reference(n)), step: page(false,128) },
    { refs: Array.from({ length: 128 }, (_, n) => reference(n)), step: page(true,128) },
    { refs: [], step: page(false,0) },
    { refs: [reference(1),reference(1)], step: page(true,2) },
    { refs: [reference(1,{subject:id(9)})], step: page(true) },
    { refs: [reference(1,{head:'urn:invalid'})], step: page(true) },
    { refs: [reference(1,{source:'urn:invalid'})], step: page(true) },
    { refs: [reference(1,{frameRefs:Array.from({length:9},()=>({slot:'structure',iri:id(4)}))})], step: page(true) },
    { refs: [], step: page(false,129) },
    { refs: [reference(1)], step: page(true,0) },
    { refs: [], step: {...page(true),exhausted:false} },
    { refs: [], step: {...page(false),exhausted:true} },
    { refs: [], step: {...page(true),after:{...cursor(2),storage:'reopened'}} },
    { refs: [], step: {...page(true),after:{...cursor(2),key:'wrong'}} },
    { refs: [], step: {...page(false),after:{...cursor(0),key:'bad'}} },
    { refs: [], step: {...page(true),after:{...cursor(2),seal:''}} },
  ];
  for (const {refs,step} of failures) {
    const run=database();
    let verified=false;
    await expect(run.seek.append(cp,refs,step,async()=>{verified=true;return true;}))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.connections).toBe(0);
    expect(verified).toBe(false);
  }
});

test('Publication append indexes legacy evidence and source hints, but ordinary proposals only advance raw cursor', async () => {
  const run = database();
  const refs = [reference(1), reference(2, { hasEvidence: true }),
    reference(3, { source: id(4), frameRefs: [{ slot: 'structure', iri: id(5) }] }), reference(4)];
  let verified = 0;
  const next = await run.seek.append(checkpoint(), refs, page(true,refs.length), async () => { verified++; return true; });
  expect(next).toMatchObject({ physicalAfter: cursor(2), complete: true, stepRevision: '2' });
  expect(verified).toBe(1);
  expect(run.state.writes.map(values => values[4])).toEqual([refs[1]!.statementId, refs[2]!.statementId]);
  expect(run.state.writes[0]?.slice(6)).toEqual([refs[1]!.head, null, true]);
  expect(run.state.writes[1]?.[5]).toBe(JSON.stringify(refs[2]!.frameRefs));
  expect(run.state.writes[1]?.slice(6)).toEqual([refs[2]!.head, id(4), false]);
  const insert = run.state.queries.find(query => query.sql.startsWith('INSERT INTO access.statement_seek\n'))!;
  expect(insert.sql).not.toMatch(/acceptance|disclosure|permission/iu);
});

test('Physical arrival order is independent of C delivery order, including non-BMP terms', async () => {
  const first = reference(1, { predicate: 'https://example.org/',hasEvidence:true });
  const second = reference(2, { predicate: 'https://example.org/😀',hasEvidence:true });
  const run = database();
  const next = await run.seek.append(checkpoint(),[second,first],page(false,3),async()=>true);
  expect(next.physicalAfter).toEqual(cursor(0));
  expect(run.state.writes.map(values=>values[4])).toEqual([second.statementId,first.statementId]);
  expect(Buffer.compare(Buffer.from(first.predicate),Buffer.from(second.predicate))).toBeLessThan(0);
  expect(first.predicate > second.predicate).toBe(true);
  await expect(run.seek.append(next,[],page(false,1),async()=>true)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(run.state.connections).toBe(1);
});

test('Publication append rolls back references and completion on changed source basis or failed CAS', async () => {
  for (const failed of ['source', 'cas'] as const) {
    const run = database();
    run.state.failCas = failed === 'cas';
    await expect(run.seek.append(checkpoint(), [reference(1, { hasEvidence: true })], page(true),
      async () => failed !== 'source')).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.writes).toHaveLength(0);
    expect(run.state.row).toEqual(coverage(checkpoint()));
    expect(run.state.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(run.state.queries.some(query => query.sql === 'COMMIT')).toBe(false);
  }
});

test('Publication stale builder cannot append after local membership changes', async () => {
  const run = database(coverage(checkpoint({ basis: { ...basis, membershipHead: id(7) } })));
  let verified = false;
  await expect(run.seek.append(checkpoint(), [reference(1, { hasEvidence: true })], page(true),
    async () => { verified = true; return true; })).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(run.state.writes).toHaveLength(0);
  expect(verified).toBe(false);
});

test('Publication lost commit acknowledgement resumes durable checkpoint; old replay cannot revive proof', async () => {
  const run = database();
  const cp = checkpoint();
  run.state.loseCommitAck = true;
  await expect(run.seek.append(cp, [reference(1, { hasEvidence: true })], page(true), async () => true))
    .rejects.toThrow('commit acknowledgement lost');
  const recovered = await run.seek.checkpoint(basis);
  expect(recovered).toMatchObject({ stepRevision: '2', complete: true, physicalAfter: cursor(2) });
  expect(run.state.writes).toHaveLength(1);
  await expect(run.seek.append(cp, [reference(2, { source: id(3) })], page(true), async () => true))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(run.state.writes).toHaveLength(1);
  expect(await run.seek.checkpoint({ ...basis, membershipHead: id(8) })).toBeNull();
});

test('Publication locally complete seek uses potential tuple range without global replay or publication authority', async () => {
  const run = database(coverage(checkpoint({ complete: true })));
  const refs = [reference(2, { hasEvidence: true }), reference(3, { source: id(4) })];
  run.state.candidates = refs.map(candidate);
  const page = await run.seek.seek(basis, order(1));
  expect(page).toEqual({ candidates: [order(2), order(3)].map(ref => ({ ...ref, score: 0 })), visitedRows: 2 });
  const query = candidateQueries(run)[0]!;
  expect(query.values).toEqual([basis.dataEpoch, basis.subject, order(1).predicate, order(1).meaningKey, order(1).statementId]);
  expect(query.sql).toContain('(predicate,meaning_key,statement_id)>($3,$4,$5)');
  expect(query.sql).toContain('(publication_source IS NOT NULL OR publication_evidence)');
  expect(query.sql).toContain('LIMIT 20');
  expect(run.state.queries.some(item => item.sql.includes('through_sequence'))).toBe(false);
  expect(query.sql).not.toMatch(/acceptance|disclosure|permission/iu);
});

test('Publication seek refuses corrupt candidate identity instead of treating it as a missing publication', async () => {
  for (const invalid of [{ ...candidate(reference(1)), subject: id(8) },
    { ...candidate(reference(1)), statement_head: 'urn:invalid' },
    { ...candidate(reference(1)), meaning_key: 'urn:invalid' }]) {
    const run = database(coverage(checkpoint({ complete: true })));
    run.state.candidates = [invalid];
    await expect(run.seek.seek(basis, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(run.state.queries.at(-1)?.sql).toBe('ROLLBACK');
  }
});

test('Store replacement refuses old completed proof and starts a fresh bounded build',async()=>{
  const prior=checkpoint({complete:true});
  const run=database(coverage(prior));
  const nextBasis={...basis,sourceStore:'reopened-store'};
  await expect(run.seek.seek(nextBasis,null)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(candidateQueries(run)).toHaveLength(0);
  const next=await run.seek.begin(nextBasis);
  expect(next.buildId).not.toBe(prior.buildId);
  expect(next).toMatchObject({basis:nextBasis,physicalAfter:null,complete:false,phase:'clearing'});
});
test('Empty candidates can progress physically but only native EOF certifies absence',async()=>{
  const run=database();
  const next=await run.seek.append(checkpoint(),[],page(false,128),async()=>true);
  expect(next.complete).toBe(false);
  await expect(run.seek.seek(basis,null)).rejects.toBeInstanceOf(WorkReadUnavailable);
  const done=await run.seek.append(next,[],page(true,0),async()=>true);
  expect(done.complete).toBe(true);
  expect((await run.seek.seek(basis,null)).candidates).toEqual([]);
});
test('Completed row without EOF certificate refuses before candidate SQL',async()=>{
  const run=database(coverage(checkpoint({complete:true,physicalAfter:cursor(0)})));
  await expect(run.seek.seek(basis,null)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(candidateQueries(run)).toHaveLength(0);
});
