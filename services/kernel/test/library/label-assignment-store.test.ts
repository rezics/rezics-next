import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { insertPersonalLabel, deletePersonalLabel, restorePersonalLabel } from '../../src/library/label-store.ts';
import { setLabelAssignment } from '../../src/library/label-assignment-store.ts';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name migrated native database');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
afterAll(()=>pool.end());
const route=0x6c75, id=(n:number)=>'00000000-0000-7000-8000-6c75'+n.toString(16).padStart(8,'0');
const at='2026-10-28T00:00:00.000Z', later='2026-10-29T00:00:00.000Z';
test('native same-row assignment admission reserves at most32 slots preserves duplicate identity and reclaims only one deleted-parent claim at its original deadline',async()=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const accountId=id(1),subjectId=id(2),context=(n:number,time=at)=>({transactionId:id(n),time});
    for(let n=0;n<34;n++) await insertPersonalLabel(c,route,{accountId,id:id(100+n),name:'Label '+n},context(1000+n));
    const input=(n:number)=>({route,accountId,subjectId,labelId:id(100+n)});
    const assigned=[];
    for(let n=0;n<32;n++){
      const r=await setLabelAssignment(c,input(n),context(2000+n));
      expect(r.kind).toBe('applied');
      if(r.kind!=='applied') throw new Error('native admission failed');
      expect(r.assignment.revision).toBe(1);
      assigned.push(r.assignment);
    }
    expect(new Set(assigned.map(x=>x.slotNo)).size).toBe(32);
    expect(new Set(assigned.map(x=>x.id)).size).toBe(32);
    const before=(await c.query('SELECT * FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY label_id',[route,accountId,subjectId])).rows;
    const duplicate=await setLabelAssignment(c,input(0),context(3000,later));
    expect(duplicate.kind).toBe('existing');
    if(duplicate.kind!=='existing') throw new Error('duplicate changed domain');
    expect(duplicate.assignment).toEqual(assigned[0]!);
    expect((await c.query('SELECT * FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY label_id',[route,accountId,subjectId])).rows).toEqual(before);
    expect((await setLabelAssignment(c,input(32),context(3001,later))).kind).toBe('capacity');
    const deleted=await deletePersonalLabel(c,route,accountId,id(100),1,context(3002));
    expect(deleted).not.toBeNull();
    const admitted=await setLabelAssignment(c,input(32),context(3003,later));
    expect(admitted.kind).toBe('applied');
    const old=(await c.query('SELECT assignment_id,slot_no,revision,deleted_at,purge_after FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',[route,accountId,subjectId,id(100)])).rows[0]!;
    expect(old.assignment_id).toBe(assigned[0]!.id);
    expect(old.slot_no).toBeNull();
    expect(old.revision).toBe(2);
    expect(new Date(old.deleted_at).toISOString()).toBe(deleted!.deletedAt!);
    expect(new Date(old.purge_after).toISOString()).toBe(deleted!.purgeAfter!);
    expect((await c.query('SELECT assignment_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL',[route,accountId,subjectId])).rowCount).toBe(32);
    expect(await restorePersonalLabel(c,route,accountId,id(100),deleted!.revision,context(3004,later))).not.toBeNull();
    expect((await setLabelAssignment(c,input(0),context(3005,later))).kind).toBe('capacity');
    const still=(await c.query('SELECT assignment_id,slot_no,revision,deleted_at,purge_after FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',[route,accountId,subjectId,id(100)])).rows[0]!;
    expect(still).toEqual(old);
  }finally{await c.query('ROLLBACK');c.release();}
});
