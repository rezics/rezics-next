import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StatementSeek, STATEMENT_SEEK_COST, statementFrameChannels, statementFrameKeys }
  from '../src/modules/statement/seek.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
test('Statement seek refuses missing and stale coverage before touching candidates or the graph', async () => {
  for (const coverage of [[],[{complete: false,through_sequence: '9'}],[{complete: true,through_sequence: '8'}]]) {
    const queries: string[] = [];
    const client = {query: async (sql: string) => {queries.push(sql);return {rows: sql.includes('through_sequence') ? coverage : []};},release: () => {}};
    const pool = {connect: async () => client} as unknown as Pool;
    const env = {lineage: {dataEpoch: 'epoch'},fuseki: {query: () => {throw new Error('graph fallback');}}} as unknown as WorkActivationEnvironment;
    await expect(new StatementSeek(pool,env).seek({dataEpoch: 'epoch',sequence: '9'},id(1),null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(queries.some(query => query.includes('FROM access.statement_seek WHERE'))).toBe(false);
  }
});
test('Statement seek pages every same-meaning speaker separately with a fixed visited-row batch', async () => {
  const rows = Array.from({length: 237},(_,index) => ({subject: id(1),predicate: 'https://rezics.com/vocab/classifiedAs',
    meaning_key: `urn:rezics:meaning:${'a'.repeat(64)}`,statement_id: id(index+10),frame_refs: []}));
  let visits = 0;
  const client = {query: async (sql: string,values: string[] = []) => {
    if (sql.includes('through_sequence')) return {rows: [{complete: true,through_sequence: '9'}]};
    if (!sql.includes('FROM access.statement_seek WHERE')) return {rows: []};
    expect(sql).toContain('data_epoch=$1 AND subject=$2 AND frame_key=$3');
    if (values.length > 3) expect(sql).toContain('(predicate,meaning_key,statement_id)>($4,$5,$6)');
    const selected = rows.filter(row => values.length === 3 || row.statement_id > values[5]!).slice(0,STATEMENT_SEEK_COST.candidates);
    visits += selected.length;
    return {rows: selected};
  },release: () => {}};
  const seek = new StatementSeek({connect: async () => client} as unknown as Pool,
    {lineage: {dataEpoch: 'epoch'}} as WorkActivationEnvironment);
  const seen: string[] = [];
  let after = null as Parameters<StatementSeek['seek']>[2];
  for (;;) {
    const page = await seek.seek({dataEpoch: 'epoch',sequence: '9'},id(1),after);
    expect(page.visitedRows).toBeLessThanOrEqual(STATEMENT_SEEK_COST.candidates);
    seen.push(...page.candidates.map(row => row.statementId));
    if (page.candidates.length < STATEMENT_SEEK_COST.candidates) break;
    after = page.candidates.at(-1)!;
  }
  expect(seen).toEqual(rows.map(row => row.statement_id));
  expect(visits).toBe(rows.length);
});
test('Statement frame postings preserve dimension AND, alternative OR and exact specificity', () => {
  const work = id(1),position = id(2),continuity = id(3);
  const keys = statementFrameKeys([{slot: 'structure',iri: work},{slot: 'structure',iri: position},
    {slot: 'continuity',iri: continuity}]);
  expect(keys).toHaveLength(2);
  expect(statementFrameKeys([])).toEqual(['[]']);
  expect(statementFrameKeys(null)).toEqual([]);
  const channels = statementFrameChannels([{iri: position,dimension: 'position',work,continuities: [continuity]}]).channels;
  expect(channels.find(channel => keys[1] === channel.key)?.score).toBe(33);
  expect(channels.find(channel => keys[0] === channel.key)?.score).toBe(32);
  expect(channels.find(channel => channel.key === '[]')?.score).toBe(0);
});
test('Statement seek keeps PostgreSQL byte order across non-BMP predicate pagination', async () => {
  const predicates = ['https://example.org/\uE000','https://example.org/😀'];
  const rows = predicates.map((predicate,index) => ({subject: id(1),predicate,
    meaning_key: `urn:rezics:meaning:${'a'.repeat(64)}`,statement_id: id(index+10),frame_refs: []}));
  const client = {query: async (sql: string,values: string[] = []) => {
    if (sql.includes('through_sequence')) return {rows: [{complete: true,through_sequence: '9'}]};
    if (!sql.includes('FROM access.statement_seek WHERE')) return {rows: []};
    // The database has already applied C collation; the merge must preserve it.
    return {rows: values.length === 3 ? rows : rows.slice(predicates.indexOf(values[3]!)+1)};
  },release: () => {}};
  const seek = new StatementSeek({connect: async () => client} as unknown as Pool,
    {lineage: {dataEpoch: 'epoch'}} as WorkActivationEnvironment);
  const first = await seek.seek({dataEpoch: 'epoch',sequence: '9'},id(1),null);
  expect(first.candidates.map(row => row.predicate)).toEqual(predicates);
  const next = await seek.seek({dataEpoch: 'epoch',sequence: '9'},id(1),first.candidates[0]!);
  expect(next.candidates.map(row => row.predicate)).toEqual([predicates[1]!]);
});
test('Statement frame seek fails explicitly when reference-channel expansion exceeds the bound', () => {
  expect(() => statementFrameChannels([{iri: id(1),dimension: 'position',work: id(2),
    ancestors: Array.from({length: 64},(_,i) => id(i+10)),continuities: Array.from({length: 64},(_,i) => id(i+100))}]))
    .toThrow('channel bound');
});
test('Statement rebuild leaves coverage unavailable when an active record is missing its references', async () => {
  const queries: string[] = [];
  const client = {query: async (sql: string) => {queries.push(sql);return {rows: []};},release: () => {}};
  const env = {lineage: {dataEpoch: 'epoch'},fuseki: {query: async (sparql: string) => {
    if (sparql.includes('SELECT ?sequence')) return {results: {bindings: [{sequence: {value: '9'}}]}};
    if (sparql.includes('SELECT ?statement WHERE')) return {results: {bindings: [{statement: {value: id(1)}}]}};
    return {results: {bindings: [{statement: {value: id(1)}}]}};
  }}} as unknown as WorkActivationEnvironment;
  await expect(new StatementSeek({connect: async () => client} as unknown as Pool,env).rebuild())
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(queries).toContain('ROLLBACK');
  expect(queries.some(sql => sql.includes('SET complete=true'))).toBe(false);
});
