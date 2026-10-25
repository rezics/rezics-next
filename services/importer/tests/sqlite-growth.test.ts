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
