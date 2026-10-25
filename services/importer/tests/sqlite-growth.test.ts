import { Database } from 'bun:sqlite';
import { expect,test } from 'bun:test';
import { assertGrowth } from '../../kernel/test/support/growth-bound';
import { RecordStore } from '../src/record-store';
import { createSqliteProbe } from './support/sqlite-growth';

test('SQLite probe counts executed rows and statements and rejects growing scans',()=>{
 const db=new Database(':memory:');
 db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, source TEXT NOT NULL)');
 for(let i=0;i<64;i++) db.run('INSERT INTO records VALUES(?,?)',[i,'source']);
 db.exec('ANALYZE');
 const p=createSqliteProbe(db,{growingTables:['records']});
 try{
  const sample=p.measure(()=>db.query('SELECT id FROM records WHERE id=?').get(2));
  expect(sample.cost).toEqual({rows:1,blocks:0,statements:1});
  p.verifyPlans();
  p.measure(()=>db.query('SELECT id FROM records WHERE source=?').all('source'));
  expect(()=>p.verifyPlans()).toThrow();
 }finally{p.restore();db.close();}
});

test('actual record store uses indexed keys at three analyzed scales',()=>{
 const store=new RecordStore(':memory:');
 let previous=0;
 const samples=[];
 try{
  for(const scale of [32,128,512]){
   for(;previous<scale;previous++) store.put({source:'wikidata',recordKey:`Q${previous}`,recordRevision:'unversioned',digest:'a'.repeat(64),converter_revision:'test@1',state:'present'});
   store.database.exec('ANALYZE');
   // Install the real probe BEFORE RecordStore prepares its statements using the
   // optional factory seam if native methods cannot intercept cached statements.
   const p=createSqliteProbe(store.database,{growingTables:['acknowledged_records','record_source_counts']});
   try{
    const result=p.measure(()=>{store.get('wikidata','Q1');store.count('wikidata');store.page('wikidata',{after:'Q1',limit:3});});
    expect(result.cost.rows).toBe(5); expect(result.cost.statements).toBe(3);
    p.verifyPlans(); samples.push({scale,cost:result.cost});
   }finally{p.restore();}
  }
  assertGrowth(samples,{rows:'constant',blocks:'constant',statements:'constant'});
 }finally{store.close();}
});

// These cases exercise native SQLite executions, including hostile plans that
// small result counts alone cannot detect.
function fixture() {
 const db=new Database(':memory:');
 db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, source TEXT NOT NULL); CREATE INDEX by_source ON records(source); CREATE TABLE other(id INTEGER PRIMARY KEY, source TEXT NOT NULL)');
 for(let i=0;i<64;i++){db.run('INSERT INTO records VALUES(?,?)',[i,`s${i%4}`]);db.run('INSERT INTO other VALUES(?,?)',[i,`s${i%4}`]);}
 db.exec('ANALYZE');
 return db;
}

test('probe counts execution rather than preparation, preserves bindings and raw plans',()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records']});
 try{
  const statement=db.prepare('SELECT id FROM records WHERE id=?', [2]);
  const result=p.measure(()=>{statement.get();statement.get(99);statement.values(3);db.run('UPDATE records SET source=? WHERE id=?',['changed',2]);});
  expect(result.cost).toEqual({rows:2,blocks:0,statements:4});
  expect(result.statements.map(s=>s.parameters)).toEqual([[2],[99],[3],['changed',2]]);
  expect(result.statements.map(s=>s.rows)).toEqual([1,0,1,0]);
  expect(p.verifyPlans().every(e=>e.plan.length>0)).toBe(true);
  expect(p.measure(()=>statement.get()).statements[0]!.parameters).toEqual([3]);
 }finally{p.restore();db.close();}
});

test('partial and unused iterators count only actual execution and consumed rows',()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records']});
 try{
  const statement=db.query('SELECT id FROM records WHERE id>=?');
  const result=p.measure(()=>{
   statement.iterate(0);
   for(const row of statement.iterate(0)){expect(row).toEqual({id:0});break;}
   const iterator=statement.iterate(1);iterator.next();iterator.next();iterator.return();
  });
  expect(result.cost).toEqual({rows:3,blocks:0,statements:2});p.verifyPlans();
 }finally{p.restore();db.close();}
});

test('query cache, exec, transactions and returning writes count once',()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records']});
 try{
  const statement=db.query('SELECT id FROM records WHERE id=?');
  expect(db.query('SELECT id FROM records WHERE id=?')).toBe(statement);
  const transaction=db.transaction(()=>{statement.get(1);db.run('UPDATE records SET source=? WHERE id=?',['x',1]);});
  const result=p.measure(()=>{transaction();db.exec('BEGIN; UPDATE records SET source=\'x\' WHERE id=2; COMMIT');db.query('INSERT INTO records VALUES(?,?) RETURNING id').get(100,'new');});
  expect(result.cost).toEqual({rows:2,blocks:0,statements:8});
  expect(result.statements.filter(s=>s.kind==='control')).toHaveLength(4);
  expect(p.verifyPlans().some(e=>e.kind==='insert')).toBe(true);
 }finally{p.restore();db.close();}
});

for(const sql of [
 'SELECT r.id FROM records AS r NOT INDEXED WHERE r.source=?',
 'SELECT r.id FROM records AS r INDEXED BY by_source',
 'SELECT id FROM records WHERE id>? ORDER BY source || id',
 'SELECT a.id FROM records AS a JOIN other AS b ON a.source=b.source WHERE a.id>?',
 'WITH hidden AS (SELECT * FROM records) SELECT id FROM hidden WHERE source || id=?',
 'UPDATE records SET source=?',
 'DELETE FROM records WHERE source || id=?',
 'INSERT INTO records SELECT id+100,source FROM records',
])test(`probe rejects unsafe native plan: ${sql}`,()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records','other']});
 try{p.measure(()=>db.query(sql).all('s1'));expect(()=>p.verifyPlans()).toThrow();}
 finally{p.restore();db.close();}
});

test('automatic indexes and temporary sorts retain raw engine evidence',()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records','other']});
 try{
  const result=p.measure(()=>db.query('SELECT a.id FROM records a CROSS JOIN other b ON a.source=b.source WHERE a.id>?').all(0));
  expect(result.statements[0]!.plan.some(row=>/AUTOMATIC/.test(row.detail))).toBe(true);
  expect(()=>p.verifyPlans()).toThrow();
 }finally{p.restore();db.close();}
});

test('throws restore measurement state and explicit restore preserves original methods',()=>{
 const db=fixture();const query=db.query;const run=db.run;const p=createSqliteProbe(db,{growingTables:['records']});
 const statement=db.query('SELECT id FROM records WHERE id=?');
 expect(()=>p.measure(()=>{statement.get(1);throw new Error('operation failed');})).toThrow('operation failed');
 expect(p.measure(()=>statement.get(2)).cost.statements).toBe(1);
 expect(()=>p.measure(()=>db.query('INSERT INTO records VALUES(?,?)').run(1,'private body'))).toThrow();
 p.restore();p.restore();expect(db.query).toBe(query);expect(db.run).toBe(run);
 expect(statement.get(2)).toEqual({id:2});db.close();
});

test('evidence is bounded and unsupported plans fail without leaking parameters',()=>{
 const db=fixture();const p=createSqliteProbe(db,{growingTables:['records']});
 try{
  p.measure(()=>db.query('PRAGMA table_info(records)').all());
  expect(()=>p.verifyPlans()).toThrow('Unsupported');
  expect(()=>p.measure(()=>{for(let i=0;i<10000;i++)db.query('SELECT id FROM records WHERE id=?').get(1);})).toThrow('evidence limit');
 }finally{p.restore();db.close();}
});

test('closing the database restores instrumentation even inside a failed operation',()=>{
 const db=fixture();const query=db.query;const p=createSqliteProbe(db,{growingTables:['records']});
 expect(()=>p.measure(()=>{db.close();throw new Error('closed');})).toThrow('closed');
 expect(db.query).toBe(query);p.restore();
});
