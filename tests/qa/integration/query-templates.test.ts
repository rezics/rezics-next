import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { adoptAuthorCredit } from '../../../services/main/src/modules/work/author-credit.ts';
import { GRAPHS,RV,iri } from '../../../services/main/src/modules/work/activate.ts';
import type { TemplateIndexDelta } from '../../../services/main/src/infrastructure/fuseki.ts';

const native=()=>`https://rezics.com/id/${randomUUID()}`;
interface Page {items:Array<{id:string;key?:string;ordinal?:number;language?:string}>;nextCursor:string|null;complete:boolean;sourcePosition:{dependencyToken:string};}
async function page(response:Response):Promise<Page> {
  const value=await response.json() as {result:Page};
  if(response.status!==200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value.result;
}

test('Reviewed templates: complete credit traversal, local bases, fresh authority and bounded physical work',async()=> {
  const stack=await startMediaStack('query-templates');
  try {
    const a=await stack.member('template-author');
    const work=await stack.publicWork(a.actor,['en','ja'],'Template qualification');
    const other=await stack.publicWork(a.actor,['en'],'Unrelated population');
    const restricted=await stack.privateWork(a.actor,'Private template root');
    await a.grant(`work:edit:${work.work}`,'work.edit');
    await a.grant(`work:read:${restricted.work}`,'work.read');
    const header=await stack.call('GET',`/v1/works/${work.work.slice(-36)}`);
    const head=(await header.json() as {revision:string}).revision;
    const ids:string[]=[];
    const population=300;
    const add=async(index:number)=> {
      const credit=native();ids.push(credit);
      await adoptAuthorCredit(stack.env,{verify:async()=>a.principal},stack.access,
        new Request('http://main.local/v1/source-author-credit-adoptions'),
        {work:work.work,credit,revision:native(),expectedHead:head,sourceKey:`/authors/OL${1000+index}A`,sourceRoleKey:null,nativeOrdinal:index%128,actingSubject:a.actor},native(),`credit-${index}`);
    };
    // These are admitted owner writes, not synthetic rows or raw graph updates.
    for(let index=0;index<population;index++) await add(index);
    // Qualify a populated cold directory, including a >256-row native type
    // continuation. This measured fixture is not a corpus-capacity claim.
    const rebuild=await stack.templateSeek.backfill(stack.env.lineage.dataEpoch,true);
    expect(rebuild.entities).toBeGreaterThanOrEqual(population);
    expect(rebuild.batches).toBeGreaterThan(4);
    expect(rebuild.elapsedMs).toBeLessThan(600_000);
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_entry WHERE epoch=$1 AND anchor=$2 AND type=$3',
      [stack.env.lineage.dataEpoch,work.work,`${RV}AuthorCredit`])).rowCount).toBe(population);
    const shadow=native(),reported=native();
    let references=[{id:shadow,key:'/authors/OL1000A',ordinal:0},{id:reported,key:'/authors/OL900000A',ordinal:1}];
    let race=false;
    const deps={environment:stack.env,access:stack.access,templateSeek:stack.templateSeek,
      sourceAdoptions:{authorReferences:async()=>new Map([[work.work,references]])} as never,
      sourceAuthorNames:{batch:async(keys:string[])=> {
        if(race) {race=false;references=references.filter(ref=>ref.id!==reported);}
        return new Map(keys.map(key=>[key,{displayName:`Author ${key}`} ]));
      }} as never,account:{verify:async()=>a.principal}};
    const app=createMainApp(stack.fuseki,deps);
    const query=(kind:string,root=work.work,cursor?:string,options:{size?:number;language?:string;etag?:string;authenticated?:boolean}={})=>
      app.handle(new Request('http://main.local/v1/query',{method:'POST',headers:{'content-type':'application/json',
        ...(options.etag?{'if-none-match':options.etag}:{}),...(options.authenticated?{authorization:`Bearer ${a.token}`}:{})},
        body:JSON.stringify({profile:'template-query-v1',query:`https://rezics.com/query/work-${kind}`,revision:1,
          parameters:{roots:[root],...(options.language?{contentLanguage:options.language}:{})},
          presentation:options.authenticated?{actingSubject:a.actor}:undefined,page:{size:options.size ?? 64,cursor}})}));
    expect((await stack.call('GET',`/v1/works/${work.work.slice(-36)}/credits`)).status).toBe(404);
    const firstResponse=await query('credits');
    const etag=firstResponse.headers.get('etag')!;
    const first=await page(firstResponse);
    expect(first.items.length).toBe(64);expect(first.nextCursor).toBeString();
    const all=[...first.items];let cursor=first.nextCursor,steps=0;
    while(cursor && steps++<20) {const result=await page(await query('credits',work.work,cursor));all.push(...result.items);cursor=result.nextCursor;}
    expect(cursor).toBeNull();expect(new Set(all.map(item=>item.id)).size).toBe(population+1);
    expect(all.map(item=>item.id)).not.toContain(shadow);expect(all.map(item=>item.id)).toContain(reported);
    expect(all.map(item=>item.ordinal)).toEqual([...all.map(item=>item.ordinal)].sort((a,b)=>a!-b!));
    expect((await query('credits',work.work,undefined,{etag})).status).toBe(304);
    const language=await page(await query('versions',work.work,undefined,{language:'ja'}));
    expect(language.items).toHaveLength(1);expect(language.items[0]?.language).toBe('ja');
    expect((await query('credits',work.work,undefined,{size:65})).status).toBe(400);
    const malformed=await app.handle(new Request('http://main.local/v1/query',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({profile:'template-query-v1',query:'https://rezics.com/query/work-credits',revision:1,parameters:{roots:Array.from({length:65},native)}})}));
    expect(malformed.status).toBe(400);
    expect((await query('credits',restricted.work)).status).toBe(404);
    const privateResponse=await query('credits',restricted.work,undefined,{authenticated:true});
    expect(privateResponse.status).toBe(200);
    const privateTag=privateResponse.headers.get('etag')!;
    await stack.accessPool.query('UPDATE access.permission_grant SET active=false WHERE scope_id=$1 AND recipient_subject=$2',
      [`work:read:${restricted.work}`,a.actor]);
    expect((await query('credits',restricted.work,undefined,{authenticated:true,etag:privateTag})).status).toBe(404);
    // Unrelated native writes keep the cursor's local basis.
    await stack.contribution(other.work,a.actor,'ja','Unrelated insertion');
    expect((await query('credits',work.work,first.nextCursor!)).status).toBe(200);
    const before=await page(await query('credits'));
    await add(population);
    expect((await query('credits',work.work,before.nextCursor!)).status).toBe(409);
    race=true;
    const refreshed=await page(await query('credits',work.work,undefined,{size:64}));
    expect(refreshed.items.map(item=>item.id)).not.toContain(reported);
    const explain=async()=> (await stack.accessPool.query<{ 'QUERY PLAN':unknown }>(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
      SELECT id,key FROM access.template_seek_entry WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5
      AND (key,id)>(''::text COLLATE "C",''::text COLLATE "C") ORDER BY key,id LIMIT 65`,
      [stack.env.lineage.dataEpoch,GRAPHS.current,`${RV}work`,work.work,`${RV}AuthorCredit`])).rows[0]!['QUERY PLAN'];
    const small=await explain();
    // Grow the unrelated physical population without changing the root's facts.
    await stack.accessPool.query(`INSERT INTO access.template_seek_entity(epoch,graph,id,sequence,payload)
      SELECT $1,$2,'urn:population:'||n,0,'{}'::jsonb FROM generate_series(1,20000) n`,[stack.env.lineage.dataEpoch,GRAPHS.current]);
    await stack.accessPool.query(`INSERT INTO access.template_seek_entry(epoch,graph,predicate,anchor,type,key,id)
      SELECT $1,$2,$3,'urn:other-root',$4,'urn:population:'||n,'urn:population:'||n FROM generate_series(1,20000) n`,
      [stack.env.lineage.dataEpoch,GRAPHS.current,`${RV}work`,`${RV}AuthorCredit`]);
    await stack.accessPool.query('ANALYZE access.template_seek_entry');
    const large=await explain();
    for(const plan of [small,large]) {
      const text=JSON.stringify(plan);
      expect(text).toContain('Index');expect(text).not.toContain('Seq Scan');expect(text).not.toContain('Sort');
      const root=(plan as Array<{Plan:{'Actual Rows':number;Plans:Array<{'Actual Rows':number}>}}>)[0]!.Plan;
      expect(root['Actual Rows']).toBe(65);expect(root.Plans[0]!['Actual Rows']).toBe(65);
    }
    const savedCursor=(await page(await query('credits'))).nextCursor;
    expect((await query('credits',work.work,savedCursor!)).status).toBe(200);
    const delayed:TemplateIndexDelta[]=[];
    stack.fuseki.attachTemplateIndexWriter(async delta=>{delayed.push(delta);});
    await add(population+1);await add(population+2);
    expect(delayed).toHaveLength(2);
    await stack.templateSeek.apply(delayed[1]!);
    expect((await query('credits')).status).toBe(503);
    await stack.templateSeek.apply(delayed[0]!);
    expect((await query('credits')).status).toBe(200);
    await stack.templateSeek.apply(delayed[0]!);
    expect((await query('credits')).status).toBe(200);
    stack.fuseki.attachTemplateIndexWriter(delta=>stack.templateSeek.apply(delta));
    const artifact=Bun.env.REZICS_QA_ARTIFACT_DIR;
    if(artifact) writeFileSync(join(artifact,'template-seek-plans.json'),JSON.stringify({degree:population+1,unrelated:20000,small,large,rebuild},null,2));
    await stack.fuseki.update(`INSERT DATA {GRAPH ${iri(GRAPHS.revisions)} {${iri(head)} a <${RV}ErasedRevision>}}`);
    expect((await query('credits',work.work,undefined,{etag})).status).toBe(404);
  } finally {await stack.stop();}
},600_000);
