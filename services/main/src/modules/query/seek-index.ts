import type { Pool, PoolClient } from 'pg';
import { fusekiReadBudget, type FusekiClient, type TemplateIndexDelta, type TemplateIndexKey } from '../../infrastructure/fuseki.ts';
import { WorkReadUnavailable, WorkReadMoved, WorkReadLimit, readDependencyToken } from '../work/read-session.ts';
import { controlRead, controlTransaction } from '../access/topology-control.ts';

export interface SeekSelector { graph: string; predicate: string; type: string; root: 'work' | 'main'; }
export interface SeekCandidate { id: string; key: string; root: string; terms: Record<string,string[]> }
const RV = 'https://rezics.com/vocab/';
export const TEMPLATE_DIRECTORY_COST = { reconciliation:128, rebuildMs:600_000, recoveryPollMs:500 } as const;
const anchorKey=(basis:TemplateIndexKey)=>readDependencyToken([basis.graph,basis.predicate,basis.anchor,basis.type]);
interface Pending {id:string;sequence:string;delta:TemplateIndexDelta}
type PendingPosition={sequence:string;id:string};

/** PG keys are only physical candidates. A native per-anchor basis proves that
 * no insertion was omitted; disclosure and all delivered fields still use RDF.
 * Equality prefixes + (key,id) seek: O(log N + P), at most 256 examined keys. */
export class TemplateSeekIndex {
  private recoveryTimer:ReturnType<typeof setInterval>|undefined;
  private recoveryRun:Promise<unknown>|undefined;
  private recoveryAfter:PendingPosition={sequence:'0',id:''};
  constructor(readonly pool: Pool, readonly fuseki: FusekiClient) {
    fuseki.attachTemplateIndexWriter(delta => this.apply(delta));
  }
  async apply(delta: TemplateIndexDelta, deadline?:number) {
    const id=readDependencyToken(delta),epoch=delta.position.dataEpoch,sequence=delta.position.sequence;
    const anchors=[...new Set(delta.bases.map(anchorKey))].sort();
    await controlTransaction(this.pool,async client=> {
      await this.deadline(client,deadline);
      await client.query(`INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`,[epoch,sequence,id,delta]);
      for(const key of anchors) {
        await this.deadline(client,deadline);
        await client.query(`INSERT INTO access.template_seek_pending_anchor(epoch,anchor_key,sequence,id)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[epoch,key,sequence,id]);
      }
    });
    // Claim the caller's own row. An independent anchor never waits on an
    // epoch-wide pending prefix before it reaches its natural basis locks.
    await this.consume(epoch,{sequence,id},undefined,deadline);
    let left:number=TEMPLATE_DIRECTORY_COST.reconciliation;
    for(const key of anchors) {
      let after:PendingPosition={sequence:'0',id:''};
      while(left-->0) {
        const result=await this.consume(epoch,after,key,deadline);
        if(!result) break;
        after=result;
      }
      if(left<=0) break;
    }
  }
  private async deadline(client:PoolClient,deadline?:number) {
    if(deadline===undefined) return;
    const remaining=deadline-Date.now();
    if(remaining<=0) throw new WorkReadUnavailable('Template directory preparation exceeds 600 seconds');
    // PG 18 transaction_timeout closes the complete batch at the remaining
    // wall deadline; per-statement timeouts alone would restart its allowance.
    await client.query("SELECT set_config('transaction_timeout',$1,true)",[`${remaining}ms`]);
  }
  private async consume(epoch:string,position:PendingPosition,anchor?:string,deadline?:number,sweep=false):Promise<PendingPosition|null> {
    return controlTransaction(this.pool,async client=> {
      await this.deadline(client,deadline);
      const item=(await client.query<Pending>(anchor ? `SELECT p.id,p.sequence::text,p.delta FROM access.template_seek_pending p
        JOIN access.template_seek_pending_anchor a ON (a.epoch,a.sequence,a.id)=(p.epoch,p.sequence,p.id)
        WHERE a.epoch=$1 AND a.anchor_key=$4 AND (a.sequence,a.id)>($2::numeric,$3::text)
        ORDER BY a.sequence,a.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`
        :sweep ? `SELECT id,sequence::text,delta FROM access.template_seek_pending
        WHERE epoch=$1 AND (sequence,id)>($2::numeric,$3::text) ORDER BY sequence,id LIMIT 1 FOR UPDATE SKIP LOCKED`
        :`SELECT id,sequence::text,delta FROM access.template_seek_pending
        WHERE epoch=$1 AND sequence=$2 AND id=$3 FOR UPDATE SKIP LOCKED`,
      anchor?[epoch,position.sequence,position.id,anchor]:[epoch,position.sequence,position.id])).rows[0];
      if(!item) return null;
      const delta=item.delta;
      const ordered=[...delta.bases].sort((a,b)=>JSON.stringify([a.graph,a.predicate,a.anchor,a.type]).localeCompare(JSON.stringify([b.graph,b.predicate,b.anchor,b.type])));
      let gap=false;
      for(const basis of ordered) {
        await this.deadline(client,deadline);
        await client.query(`INSERT INTO access.template_seek_basis(epoch,graph,predicate,anchor,type,sequence)
          VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING`,[epoch,basis.graph,basis.predicate,basis.anchor,basis.type]);
        const current=(await client.query<{sequence:string}>(`SELECT sequence::text FROM access.template_seek_basis
          WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5 FOR UPDATE`,[epoch,basis.graph,basis.predicate,basis.anchor,basis.type])).rows[0]!;
        if(basis.previous!==undefined && BigInt(current.sequence)<BigInt(basis.previous)) gap=true;
      }
      // SKIP LOCKED is a consumption hint, never evidence that predecessors
      // exist. A gap retains both the durable row and its anchor index.
      if(gap) return {sequence:item.sequence,id:item.id};
      const sequence = delta.position.sequence;
      for (const entity of delta.entities ?? []) {
        await this.deadline(client,deadline);
        const prior = (await client.query<{ sequence:string }>(`SELECT sequence::text FROM access.template_seek_entity
          WHERE epoch=$1 AND graph=$2 AND id=$3 FOR UPDATE`,[epoch,entity.graph,entity.id])).rows[0];
        if (prior && BigInt(prior.sequence)>BigInt(sequence)) continue;
        const stored=await client.query(`INSERT INTO access.template_seek_entity(epoch,graph,id,sequence,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(epoch,graph,id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload
          WHERE access.template_seek_entity.sequence<=EXCLUDED.sequence RETURNING id`,
        [epoch,entity.graph,entity.id,sequence,entity.terms]);
        if(!stored.rowCount) continue;
        await client.query('DELETE FROM access.template_seek_entry WHERE epoch=$1 AND graph=$2 AND id=$3',[epoch,entity.graph,entity.id]);
        for (const property of ['work','mainVersion']) for (const anchor of entity.terms[property] ?? []) {
          for (const type of entity.terms.type ?? []) {
            if(type===`${RV}AuthorCredit` && entity.terms.retiredBy?.length) continue;
            const key = type===`${RV}RealmPublicationSlot` ? entity.terms.realm?.[0]
              :type===`${RV}AuthorCredit`?`${String(entity.terms.ordinal?.[0] ?? '').padStart(3,'0')}:${entity.id}`:entity.id;
            if (!key) throw new WorkReadUnavailable('Physical slot lacks its Realm');
            await client.query(`INSERT INTO access.template_seek_entry(epoch,graph,predicate,anchor,type,key,id,external_key)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [epoch,entity.graph,`${RV}${property}`,anchor,type,key,entity.id,entity.terms.externalKey?.[0] ?? null]);
          }
        }
      }
      for (const basis of delta.bases) await client.query(`INSERT INTO access.template_seek_basis(epoch,graph,predicate,anchor,type,sequence)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(epoch,graph,predicate,anchor,type) DO UPDATE SET sequence=EXCLUDED.sequence
        WHERE access.template_seek_basis.sequence<=EXCLUDED.sequence`,
      [epoch,basis.graph,basis.predicate,basis.anchor,basis.type,basis.sequence]);
      await client.query('DELETE FROM access.template_seek_pending WHERE epoch=$1 AND sequence=$2 AND id=$3',[epoch,item.sequence,item.id]);
      await this.deadline(client,deadline);
      return {sequence:item.sequence,id:item.id};
    });
  }
  /** One row/transaction, no claimed batch of unrelated rows. A bounded seek
   * continues past gaps and wraps, so skipped rows get another recovery turn. */
  async recover(epoch:string,deadline?:number) {
    for(let count=0;count<TEMPLATE_DIRECTORY_COST.reconciliation;count++) {
      const item=await this.consume(epoch,this.recoveryAfter,undefined,deadline,true);
      if(!item) {this.recoveryAfter={sequence:'0',id:''};return;}
      this.recoveryAfter=item;
    }
  }
  startRecovery(epoch:string) {
    if(this.recoveryTimer) return;
    this.recoveryTimer=setInterval(()=> {
      if(this.recoveryRun) return;
      this.recoveryRun=this.recover(epoch).catch(error=>{console.error('Template pending recovery deferred',error);})
        .finally(()=>{this.recoveryRun=undefined;});
    },TEMPLATE_DIRECTORY_COST.recoveryPollMs);
  }
  async stopRecovery() {
    if(this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer=undefined;await this.recoveryRun;
  }
  /** Native GPOS B+tree continuation; no OFFSET or repeated ORDER BY corpus sort.
   * A persisted checkpoint resumes within this JVM. A restart/compaction starts
   * a fresh directory build, so changed native NodeIds cannot skip old facts. */
  async backfill(epoch: string, force=false,budgetMs=TEMPLATE_DIRECTORY_COST.rebuildMs) {
    if(!Number.isSafeInteger(budgetMs) || budgetMs<1 || budgetMs>TEMPLATE_DIRECTORY_COST.rebuildMs) throw new WorkReadLimit('Invalid directory preparation budget');
    const started=Date.now(),deadline=started+budgetMs;
    const signal=AbortSignal.timeout(budgetMs);
    return fusekiReadBudget.run({signal,callsLeft:Number.MAX_SAFE_INTEGER,bytesLeft:Number.MAX_SAFE_INTEGER},async()=> {
    let batches=0,entities=0;
    const instance = (await this.fuseki.commandHealth()).instanceId;
    await controlTransaction(this.pool, async client => {
      await this.deadline(client,deadline);
      const previous = (await client.query<{ epoch:string; instance:string }>('SELECT epoch,instance FROM access.template_seek_checkpoint WHERE epoch=$1 FOR UPDATE',[epoch])).rows[0];
      if (!force && previous?.epoch===epoch && previous.instance===instance) return;
      await client.query('DELETE FROM access.template_seek_entry');
      await client.query('DELETE FROM access.template_seek_entity');
      await client.query('DELETE FROM access.template_seek_basis');
      await client.query('DELETE FROM access.template_seek_pending');
      await client.query(`INSERT INTO access.template_seek_checkpoint(epoch,instance,cursor) VALUES($1,$2,'{"phase":0,"after":""}')
        ON CONFLICT(epoch) DO UPDATE SET instance=EXCLUDED.instance,cursor=EXCLUDED.cursor,complete=false`,[epoch,instance]);
    });
    while (Date.now()<deadline) {
      const state = (await this.pool.query<{ complete:boolean; cursor:{ phase:number; after:string } }>('SELECT complete,cursor FROM access.template_seek_checkpoint WHERE epoch=$1',[epoch])).rows[0]!;
      if (state.complete) {await this.recover(epoch,deadline);return {batches,entities,elapsedMs:Date.now()-started,budgetMs};}
      const delta = await this.fuseki.templateIndex({ operation:'backfill',...state.cursor });
      if (delta.position.dataEpoch!==epoch) throw new WorkReadUnavailable('Template directory epoch moved');
      await this.apply(delta,deadline);
      batches++;entities+=delta.entities?.length ?? 0;
      const phase = delta.next ? state.cursor.phase : state.cursor.phase+1;
      await controlTransaction(this.pool,async client=> {
        await this.deadline(client,deadline);
        await client.query('UPDATE access.template_seek_checkpoint SET cursor=$1,complete=$2 WHERE epoch=$3 AND instance=$4',
          [{ phase,after:delta.next ?? '' },phase===4,epoch,instance]);
      });
    }
    throw new WorkReadUnavailable('Template directory preparation exceeds 600 seconds');
    });
  }
  async keys(epoch: string, keys: TemplateIndexKey[]) {
    const native = await this.fuseki.templateIndex({ operation:'basis',keys });
    if (native.position.dataEpoch!==epoch) throw new WorkReadMoved('Template directory epoch changed');
    await controlRead(this.pool, async client => {
      const ready = (await client.query<{ complete:boolean; epoch:string }>('SELECT epoch,complete FROM access.template_seek_checkpoint WHERE epoch=$1',[epoch])).rows[0];
      if (!ready?.complete || ready.epoch!==epoch) throw new WorkReadUnavailable('Template directory is preparing');
      for (const key of native.bases) {
        const row = (await client.query<{ sequence:string }>(`SELECT sequence::text FROM access.template_seek_basis
          WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5`,[epoch,key.graph,key.predicate,key.anchor,key.type])).rows[0];
        if ((row?.sequence ?? '0')!==key.sequence) throw new WorkReadUnavailable('Template directory is behind its native anchor');
      }
    });
    return native.bases;
  }
  async candidates(epoch: string, keys: TemplateIndexKey[], after: { key:string; id:string } | null, limit:number,
    filter: { language?:string; kind?:string } = {},budget=256): Promise<{rows:SeekCandidate[];more:boolean}> {
    if(limit<1 || limit>256 || keys.length>128) throw new WorkReadUnavailable('Template seek exceeds its bound');
    // Each disjoint branch seeks at most P keys. Their merge sorts only that
    // bounded window; it never sorts the anchor inventory. Hydration is later.
    const found: SeekCandidate[]=[];
    const selected=keys.filter(key=>!filter.kind || (key.type.endsWith('FixedRelease') ? 'release' : 'text-variant')===filter.kind);
    if(selected.length*2>budget) throw new WorkReadLimit('Template root fanout exceeds its lookahead budget');
    const ask=Math.max(1,Math.floor(Math.min(limit+selected.length,budget)/Math.max(1,selected.length))-1);
    const boundaries: {key:string; id:string}[]=[];
    for (const key of selected) {
      if (filter.kind && (key.type.endsWith('FixedRelease') ? 'release' : 'text-variant')!==filter.kind) continue;
      const rows = await this.pool.query<{ id:string; key:string; payload: Record<string,string[]> }>(`WITH candidates AS MATERIALIZED (
        SELECT id,key FROM access.template_seek_entry WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5
        AND (key,id)>($6::text COLLATE "C",$7::text COLLATE "C") ORDER BY key,id LIMIT $8)
        SELECT c.id,c.key,e.payload FROM candidates c JOIN access.template_seek_entity e ON e.epoch=$1 AND e.graph=$2 AND e.id=c.id
        ORDER BY c.key,c.id`,[epoch,key.graph,key.predicate,key.anchor,key.type,after?.key ?? '',after?.id ?? '',ask+1]);
      const page=rows.rows.slice(0,ask);
      found.push(...page.map(row=>({ id:row.id,key:row.key,root:key.anchor,terms:row.payload })));
      if(rows.rows.length>ask) boundaries.push(page.at(-1)!);
    }
    const compare=(a:{key:string;id:string},b:{key:string;id:string})=>a.key<b.key?-1:a.key>b.key?1:a.id<b.id?-1:a.id>b.id?1:0;
    const boundary=boundaries.sort(compare)[0];
    return {rows:found.sort(compare).filter(row=>!boundary || compare(row,boundary)<=0),more:boundaries.length>0};
  }
  async confirmed(epoch:string, roots:string[], keys:string[]): Promise<Set<string>> {
    if(keys.length>128) throw new WorkReadUnavailable('Source key batch exceeds its bound');
    const rows=await this.pool.query<{ anchor:string; external_key:string }>(`SELECT wanted.anchor,wanted.external_key FROM
      unnest($3::text[],$4::text[]) wanted(anchor,external_key) CROSS JOIN LATERAL (
        SELECT 1 FROM access.template_seek_entry WHERE epoch=$1 AND type=$2
          AND anchor=wanted.anchor AND external_key=wanted.external_key LIMIT 1) present`,[epoch,`${RV}AuthorCredit`,roots,keys]);
    return new Set(rows.rows.map(row=>`${row.anchor}\0${row.external_key}`));
  }
}
