import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { adoptAuthorCredit } from '../../../services/main/src/modules/work/author-credit.ts';
import { DATASET,GRAPHS,RV,iri } from '../../../services/main/src/modules/work/activate.ts';
import { fusekiReadBudget,type TemplateIndexDelta } from '../../../services/main/src/infrastructure/fuseki.ts';
import { mainSelectionDigest,selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { publishTextContribution,textPublicationDigest } from '../../../services/main/src/modules/contribution/publish.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';

const native=()=>`https://rezics.com/id/${randomUUID()}`;
interface Page {items:Array<{id:string;key?:string;ordinal?:number;language?:string}>;nextCursor:string|null;complete:boolean;sourcePosition:{dependencyToken:string};}
async function page(response:Response,facade=false):Promise<Page> {
  const value=await response.json() as {result:Page}&Page;
  if(response.status!==200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return facade?value:value.result;
}

test('Reviewed templates: complete credit traversal, local bases, fresh authority and bounded physical work',async()=> {
  const stack=await startMediaStack('query-templates');
  try {
    // Use the same SQL-backed disclosure owner Main composes in production.
    // These requests never capture evidence or issue moderation decisions.
    const governance=new GovernanceStore(stack.accessPool,
      {capture:async()=>{throw new Error('Evidence capture is outside this read fixture');}},
      {current:async()=>{throw new Error('Moderation head admission is outside this read fixture');}},
      {current:async()=>{throw new Error('Moderation rule admission is outside this read fixture');}});
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
    type Phase='hydration'|'final-membership'|'final-names';
    type Probe={phase:Phase;change:()=>Promise<void>;changed:boolean;controls:number;fields:number;bases:number;names:number;
      budget?:NonNullable<ReturnType<typeof fusekiReadBudget.getStore>>};
    let active:Probe|undefined;
    const observations:Array<{surface:string;phase:Phase;status:number;controls:number;fields:number;bases:number;
      committed?:{before:string;after:string;decision:string}}> = [];
    let committed:{before:string;after:string;decision:string}|undefined;
    const trigger=async(phase:Phase)=> {
      if(active?.phase===phase && !active.changed) {
        active.changed=true;
        // The writer has its own transaction/budget, as a concurrent caller
        // would. Await its real native commit before resuming the paused read.
        await fusekiReadBudget.exit(active.change);
      }
    };
    const nativeQuery=stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query=async(...args:Parameters<typeof nativeQuery>)=> {
      const budget=fusekiReadBudget.getStore();
      if(active && budget && /SELECT \?epoch \?sequence WHERE/.test(args[0])) {
        active.budget ??= budget;
        if(budget===active.budget) active.controls++;
      }
      return nativeQuery(...args);
    };
    const nativeFields=stack.fuseki.templateQuery.bind(stack.fuseki);
    stack.fuseki.templateQuery=async(...args:Parameters<typeof nativeFields>)=> {
      if(active?.budget && fusekiReadBudget.getStore()===active.budget) {
        active.fields++;
        const rows=await nativeFields(...args);
        if(active.fields===1) await trigger('hydration');
        return rows;
      }
      return nativeFields(...args);
    };
    const nativeBasis=stack.fuseki.templateIndex.bind(stack.fuseki);
    stack.fuseki.templateIndex=(async(...args:Parameters<typeof nativeBasis>)=> {
      if(active?.budget && fusekiReadBudget.getStore()===active.budget && args[0].operation==='basis') {
        active.bases++;
        // Initial selection, leaf final check, then WorkRead's owner recheck.
        if(active.bases===3) await trigger('final-membership');
      }
      return nativeBasis(...args);
    }) as typeof stack.fuseki.templateIndex;
    const deps={environment:stack.env,access:stack.access,templateSeek:stack.templateSeek,governance:{store:governance},
      sourceAdoptions:{authorReferences:async()=>new Map([[work.work,references]])} as never,
      sourceAuthorNames:{batch:async(keys:string[])=> {
        if(active?.budget && fusekiReadBudget.getStore()===active.budget && ++active.names===2) await trigger('final-names');
        if(race) {race=false;references=references.filter(ref=>ref.id!==reported);}
        return new Map(keys.map(key=>[key,{displayName:`Author ${key}`} ]));
      }} as never,account:{verify:async()=>a.principal}};
    const app=createMainApp(stack.fuseki,deps);
    const query=(kind:string,root=work.work,cursor?:string,options:{size?:number;language?:string;etag?:string;authenticated?:boolean}={})=>
      app.handle(new Request('http://main.local/v1/query',{method:'POST',headers:{'content-type':'application/json',
        ...(options.etag?{'if-none-match':options.etag}:{}),...(options.authenticated?{authorization:`Bearer ${a.token}`}:{})},
        body:JSON.stringify({profile:'template-query-v1',query:`https://rezics.com/query/work-${kind}`,revision:1,
          parameters:{roots:[root],...(options.language?{contentLanguage:options.language}:{})},
          presentation:options.authenticated?{actingSubject:a.actor}:undefined,limit:options.size ?? 64,cursor})}));
    const facade=(root=work.work,cursor?:string,options:{size?:number;etag?:string}={})=>
      app.handle(new Request(`http://main.local/v1/works/${root.slice(-36)}/credits?${new URLSearchParams({
        limit:String(options.size ?? 20),...(cursor?{cursor}:{})})}`,{headers:options.etag?{'if-none-match':options.etag}:{}}));
    const facadeBaseline=await page(await facade(),true);
    const postBaseline=await page(await query('credits',work.work,undefined,{size:20}));
    expect(facadeBaseline.items).toHaveLength(20);
    expect(facadeBaseline.items).toEqual(postBaseline.items);
    expect(facadeBaseline.sourcePosition.dependencyToken).toBe(postBaseline.sourcePosition.dependencyToken);
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
    const sequence=async()=> (await nativeQuery(`PREFIX rv:<${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} {${iri(DATASET)} rv:sequence ?sequence} } LIMIT 2`)).results!.bindings[0]!.sequence!.value;
    const unrelated=async()=> {
      const before=await sequence();
      const result=await stack.contribution(other.work,a.actor,'ja',`Concurrent unrelated ${randomUUID()}`);
      const after=await sequence();
      expect(BigInt(after)).toBeGreaterThan(BigInt(before));
      expect((await nativeQuery(`PREFIX rv:<${RV}> ASK {GRAPH ${iri(GRAPHS.current)} {
        ${iri(result.contribution)} rv:publicationHead ${iri(result.decision)}}}`)).boolean).toBe(true);
      committed={before,after,decision:result.decision};
    };
    const observe=async(surface:string,phase:Phase,request:()=>Promise<Response>,change=unrelated)=> {
      active={phase,change,changed:false,controls:0,fields:0,bases:0,names:0};committed=undefined;
      try {
        const response=await request();
        expect(active.changed).toBe(true);
        observations.push({surface,phase,status:response.status,controls:active.controls,fields:active.fields,bases:active.bases,
          ...(committed?{committed}:{})});
        const artifact=Bun.env.REZICS_QA_ARTIFACT_DIR;
        if(artifact) writeFileSync(join(artifact,'credits-concurrency-observations.json'),JSON.stringify(observations,null,2));
        return {response,probe:{...active}};
      } finally {active=undefined;}
    };
    // Real commits cross both the initial/final global position and the final
    // local owner fences. Neither route may restart or truncate its result.
    for(const surface of ['POST','GET'] as const) {
      const request=(cursor?:string,etag?:string)=>surface==='POST'
        ? query('credits',work.work,cursor,{size:20,...(etag?{etag}:{})}) : facade(work.work,cursor,{etag});
      const baselineResponse=await request();const tag=baselineResponse.headers.get('etag')!;
      const baseline=await page(baselineResponse,surface==='GET');
      expect(baseline.items).toHaveLength(20);expect(baseline.nextCursor).toBeString();
      for(const phase of ['hydration','final-membership'] as const) {
        const {response,probe}=await observe(surface,phase,()=>request());
        const result=await page(response,surface==='GET');
        expect(result.items).toEqual(baseline.items);
        expect(result.complete).toBe(baseline.complete);
        expect(result.sourcePosition.dependencyToken).toBe(baseline.sourcePosition.dependencyToken);
        expect(probe.controls).toBe(2);expect(probe.fields).toBe(2);expect(probe.bases).toBe(3);
      }
      const continuation=await page(await request(baseline.nextCursor!),surface==='GET');
      expect(continuation.items).toHaveLength(20);
      const {response:continued,probe:continuationProbe}=await observe(surface,'final-membership',()=>request(baseline.nextCursor!));
      expect((await page(continued,surface==='GET')).items).toEqual(continuation.items);
      expect(continuationProbe.controls).toBe(2);expect(continuationProbe.fields).toBe(2);
      const {response:notModified,probe:conditionalProbe}=await observe(surface,'hydration',()=>request(undefined,tag));
      expect(notModified.status).toBe(304);expect(await notModified.text()).toBe('');
      expect(notModified.headers.get('etag')).toBe(tag);expect(notModified.headers.get('cache-control')).toBe('private, no-store');
      expect(conditionalProbe.controls).toBe(2);expect(conditionalProbe.fields).toBe(2);
    }
    // Relevant membership still invalidates a continuation during the last
    // owner fence; no retry is permitted to silently advance that cursor.
    const localCursor=(await page(await query('credits',work.work,undefined,{size:20}))).nextCursor!;
    const moved=await observe('POST','final-membership',()=>query('credits',work.work,localCursor,{size:20}),()=>add(population+100));
    expect(moved.response.status).toBe(409);expect(moved.probe.controls).toBe(2);
    expect((await facade(work.work,localCursor)).status).toBe(409);
    expect((await page(await query('credits',work.work,undefined,{size:20}))).items).toHaveLength(20);
    // Current read rights are an actual Access gate, independent of RDF basis.
    await a.grant(`work:read:${work.work}`,'work.read');
    const rightsTag=(await query('credits',work.work,undefined,{size:20})).headers.get('etag')!;
    try {
      const denied=await observe('GET','final-names',()=>facade(work.work,undefined,{etag:rightsTag}),async()=> {
        const changed=await stack.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1 RETURNING open',[`work:read:${work.work}`]);
        expect(changed.rows).toEqual([{open:false}]);
      });
      expect(denied.response.status).toBe(404);
      expect((await query('credits',work.work,undefined,{size:20,etag:rightsTag})).status).toBe(404);
    } finally {await stack.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1',[`work:read:${work.work}`]);}
    // Restoration admission cannot be converted to a local empty/304 result.
    try {
      const held=await observe('POST','hydration',()=>query('credits',work.work,undefined,{size:20,etag:rightsTag}),async()=> {
        await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
      });
      expect(held.response.status).toBe(503);expect((await facade(work.work,undefined,{etag:rightsTag})).status).toBe(503);
    } finally {await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id=true');}
    const epoch=stack.env.lineage.dataEpoch;
    try {
      const movedEpoch=await observe('GET','hydration',()=>facade(),async()=>{stack.env.lineage.dataEpoch=randomUUID();});
      expect(movedEpoch.response.status).toBe(503);expect((await query('credits')).status).toBe(503);
    } finally {stack.env.lineage.dataEpoch=epoch;}
    // A private-root publication is the real public admission basis, unlike
    // catalogue visibility. Replace its selected decision during hydration.
    const published=await stack.contribution(restricted.work,a.actor,'en','Publication fence qualification');
    const selection={context:{kind:'main-version-default' as const,id:restricted.mainVersion},work:restricted.work,
      contribution:published.contribution,publicationDecision:published.decision,expectedSelectionHead:null,
      selectionBasis:'main-maintainer' as const,actingSubject:a.actor};
    expect((await selectMainDefault(stack.env,stack.admission(a.actor,`publication:select:${restricted.mainVersion}`,
      'publication.select',mainSelectionDigest(selection)),selection)).outcome).toBe('succeeded');
    const privateHead=(await nativeQuery(`PREFIX rv:<${RV}> SELECT ?head WHERE {GRAPH ${iri(GRAPHS.current)} {
      ${iri(restricted.work)} rv:head ?head}} LIMIT 2`)).results!.bindings[0]!.head!.value;
    const privateCredit=native();
    await a.grant(`work:edit:${restricted.work}`,'work.edit');
    await adoptAuthorCredit(stack.env,{verify:async()=>a.principal},stack.access,
      new Request('http://main.local/v1/source-author-credit-adoptions'),{work:restricted.work,credit:privateCredit,
        revision:native(),expectedHead:privateHead,sourceKey:'/authors/OL990001A',sourceRoleKey:null,nativeOrdinal:0,
        actingSubject:a.actor},native(),'publication-credit');
    const publicResponse=await facade(restricted.work);const publicationTag=publicResponse.headers.get('etag')!;
    expect((await page(publicResponse,true)).items.map(item=>item.id)).toEqual([privateCredit]);
    const draft=(await nativeQuery(`PREFIX rv:<${RV}> SELECT ?head WHERE {GRAPH ${iri(GRAPHS.current)} {
      ${iri(published.contribution)} rv:draftHead ?head}} LIMIT 2`)).results!.bindings[0]!.head!.value;
    const hidden=await observe('POST','hydration',()=>query('credits',restricted.work,undefined,{size:20,etag:publicationTag}),async()=> {
      const input={contribution:published.contribution,expectedDraftHead:draft,expectedPublicationHead:published.decision,
        rightsBasis:'original-contribution' as const,disclosure:'public' as const,actingSubject:a.actor};
      expect((await publishTextContribution(stack.env,stack.admission(a.actor,`contribution:publish:${published.contribution}`,
        'contribution.publish',textPublicationDigest(input)),input)).outcome).toBe('succeeded');
    });
    expect(hidden.response.status).toBe(404);
    expect((await facade(restricted.work,undefined,{etag:publicationTag})).status).toBe(404);
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
    if(artifact) writeFileSync(join(artifact,'template-seek-plans.json'),JSON.stringify({degree:ids.length+1,unrelated:20000,small,large,rebuild,observations},null,2));
    await stack.fuseki.update(`INSERT DATA {GRAPH ${iri(GRAPHS.revisions)} {${iri(head)} a <${RV}ErasedRevision>}}`);
    expect((await query('credits',work.work,undefined,{etag})).status).toBe(404);
  } finally {await stack.stop();}
},600_000);
