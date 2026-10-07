import { createHash } from 'node:crypto';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { templates } from '../../../../../generated/query/templates.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { TemplateIndexKey, TemplateTerm } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, readDependencyToken, publicWork, unerased,
  workRead, publicWorkRead, WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadUnavailable, WorkReadMoved,
  readRowsToken, type WorkReadSession, type ReadRow } from '../work/read-session.ts';
import { readAuthorNames, sourceCreditReferences } from '../source/author-name-read.ts';
import { resolveConcepts } from '../concept-page/read.ts';
import { discoveryStorage } from '../discovery/store.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { TEMPLATE_COST, type ReviewedTemplate, type TemplateInput } from './template-schema.ts';
import type { SeekCandidate } from './seek-index.ts';

export const templateRequests=t.Union(templates.map(template=>template.request) as [typeof templates[number]['request'],...typeof templates[number]['request'][]]);
export const templateResponses=t.Union(templates.map(template=>template.response) as [typeof templates[number]['response'],...typeof templates[number]['response'][]]);
const uri=(value:string):TemplateTerm=>({type:'uri',value});
const literal=(value:string):TemplateTerm=>({type:'literal',value});
const bool=(value:boolean):TemplateTerm=>({type:'literal',value:String(value),datatype:'http://www.w3.org/2001/XMLSchema#boolean'});
const integer=(value:number):TemplateTerm=>({type:'literal',value:String(value),datatype:'http://www.w3.org/2001/XMLSchema#integer'});
type Template=ReviewedTemplate & {sparql:string};

async function admit(session:WorkReadSession, rootKind:Template['root'], roots:string[]) {
  if(rootKind==='concept') {
    const resolved=await resolveConcepts(session,roots);
    if(resolved.size!==roots.length) throw new WorkReadMissing('Concept is unavailable');
    const names=await session.summaries(roots);
    if(names.some(name=>name.status!=='available')) throw new WorkReadMissing('Concept is unavailable');
    return {rows:roots.map(root=>({root,main:root})),token:readDependencyToken([Array.from(resolved),names]),concepts:resolved};
  }
  const rows=await session.query(`SELECT ?root ?main ?head ?mainHead ?public WHERE {
    VALUES ?root { ${roots.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?root a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ?root ; rv:head ?mainHead . }
    ${unerased('?root')} BIND(EXISTS { ${publicWork('?root','?main')} } AS ?public)
  } LIMIT ${roots.length+1}`,roots.length);
  if(rows.length!==roots.length || new Set(rows.map(row=>row.root?.value)).size!==roots.length)
    throw new WorkReadMissing('Work is unavailable');
  for(const row of rows) if(row.public?.value!=='true') await session.dependency(`template-admission:${row.root!.value}`,async()=> {
    if(!session.principal || !session.options.actingSubject
      || !await session.deps.access.canReadWork(session.principal,session.options.actingSubject,row.root!.value)) throw new WorkReadMissing('Work is unavailable');
    return true;
  });
  const names=await session.summaries(roots);
  if(names.some(name=>name.status!=='available')) throw new WorkReadMissing('Work is unavailable');
  return {rows:rows.map(row=>({root:row.root!.value,main:row.main!.value})),token:readDependencyToken([rows,names]),concepts:null};
}

/** One executor for every authored template. Definitions declare sources and
 * field projections; query IDs never select handwritten implementations. */
export async function executeTemplate(deps:MainWorkDependencies,request:Request,input:TemplateInput):Promise<Response> {
  const template=templates.find(template=>template.query===input.query && template.revision===input.revision) as Template|undefined;
  if(!template || !Value.Check(template.request,input)) throw new WorkReadInvalid('Unknown or invalid reviewed template');
  const roots=[...input.parameters.roots].sort(),limit=input.limit ?? TEMPLATE_COST.page;
  if(roots.length>TEMPLATE_COST.roots || limit>TEMPLATE_COST.maxPage) throw new WorkReadLimit('Template input exceeds its budget');
  const options={...input.presentation,limit,cursor:input.cursor,localBasis:true,readOnlyTemplate:true};
  const operation=async(session:WorkReadSession)=> {
    const admission=await admit(session,template.root,roots);
    const normalized={query:template.query,revision:template.revision,text:readDependencyToken(template.sparql),roots,
      contentLanguage:input.parameters.contentLanguage?.toLowerCase() ?? '',kind:input.parameters.kind ?? '',
      languages:session.displayLanguages,actor:session.options.actingSubject ?? null,limit};
    const refs=template.sourceCredits ? await sourceCreditReferences(session,roots) : [];
    let membership:unknown, candidateRead:(after:{key:string;id:string}|null)=>Promise<SeekCandidate[]>;
    let extraBasis:()=>Promise<unknown>;
    let physicalMore=true;
    if(template.eligibility.kind==='rdf') {
      const index=deps.templateSeek;
      if(!index) throw new WorkReadUnavailable('Template directory is unavailable');
      const keys:TemplateIndexKey[]=template.eligibility.selectors.flatMap(selector=>admission.rows.map(row=>({
        graph:selector.graph,predicate:selector.predicate,type:selector.type,anchor:selector.root==='main'?row.main:row.root })));
      extraBasis=()=>index.keys(session.position.dataEpoch,keys);
      membership=await extraBasis();
      session.observeDependency('template-membership',membership,extraBasis);
      const budget=TEMPLATE_COST.candidates-admission.rows.length-refs.length;
      if(budget<keys.length) throw new WorkReadLimit('Template root/source bindings exhaust its candidate budget');
      candidateRead=async after=> {
        const window=await index.candidates(session.position.dataEpoch,keys,after,Math.min(budget,Math.max(limit+1,keys.length)),input.parameters,budget);
        physicalMore=window.more;return window.rows;
      };
    } else {
      const projection=deps.discovery,index=deps.templateSeek;
      if(!projection || !index || !admission.concepts) throw new WorkReadUnavailable('Accepted item directory is unavailable');
      const senses=[...new Set([...admission.concepts.values()].flatMap(concept=>concept.interpretations))];
      if(senses.length>4) throw new WorkReadLimit('Concept feed interpretation budget exceeded');
      const scope={scope:'global' as const,realm:null,context:null,owner:null};
      let active=await projection.active(scope,session.position);
      if(active.stale) throw new WorkReadUnavailable('Accepted item directory is refreshing');
      extraBasis=async()=> {
        active=await projection.active(scope,session.position);
        if(active.stale) throw new WorkReadUnavailable('Accepted item directory is refreshing');
        const rows=await index.pool.query(`SELECT term,revision::text FROM access.template_discovery_basis
          WHERE generation=$1 AND term=ANY($2::text[]) ORDER BY term`,[discoveryStorage(active)[0],senses]);
        return [discoveryStorage(active)[0],active.recovery_generation,rows.rows];
      };
      membership=await extraBasis();
      session.observeDependency('template-membership',membership,extraBasis);
      candidateRead=async after=> {
        if(!senses.length) {physicalMore=false;return [];}
        const page=await projection.conditionPage(active,'',{drive:senses,groups:[],excluded:[]},Math.min(limit,20),
          after?{key:after.key,work:after.id}:undefined);
        physicalMore=page.next!==null;
        return page.rows.map(row=>({id:row.work,key:row.order_key,root:roots[0]!,terms:{mainVersion:[row.payload.mainVersion]}}));
      };
    }
    const position={...session.position,dependencyToken:readDependencyToken([admission.token,membership,refs])};
    const cursor=decodeReadCursor(input.cursor,normalized,position);
    const after=cursor?{key:cursor.order,id:cursor.after}:null;
    let candidates=await candidateRead(after);
    const confirmed=refs.length ? await deps.templateSeek!.confirmed(session.position.dataEpoch,refs.map(ref=>ref.work),refs.map(ref=>ref.key)) : new Set<string>();
    const source=refs.map(ref=>({...ref,confirmed:confirmed.has(`${ref.work}\0${ref.key}`)}));
    if(template.sourceCredits) {
      const cutoff=candidates.at(-1)?.key;
      const added=source.map(ref=>({...ref,sort:`${String(ref.ordinal).padStart(3,'0')}:${ref.id}`}))
        .filter(ref=>!ref.confirmed && (!after || ref.sort>after.key) && (!cutoff || ref.sort<=cutoff))
        .map(ref=>({id:ref.id,key:ref.sort,root:ref.work,terms:{}}));
      // Include source-only tails when the graph seek is empty. Both sets are bounded before names.
      candidates=[...candidates,...added].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:a.id<b.id?-1:1);
    }
    if(candidates.length+admission.rows.length+source.length>TEMPLATE_COST.candidates) throw new WorkReadLimit('Template candidate budget exceeded');
    const tables=[{columns:['_work_iri','_main_iri'],rows:admission.rows.map(row=>[uri(row.root),uri(row.main)])},
      {columns:['id','_sort'],rows:candidates.map(row=>[uri(row.id),literal(row.key)])}];
    if(template.sourceCredits) tables.push({columns:['id','key','ordinal','_work_iri','_source_confirmed'],
      rows:source.map(row=>[uri(row.id),literal(row.key),integer(row.ordinal),uri(row.work),bool(row.confirmed)])});
    const bindings:Record<string,TemplateTerm>=template.serverBoundInputs.includes('_contentLanguage') ? {
      _contentLanguage:literal(normalized.contentLanguage),_kind:literal(normalized.kind) } : {};
    const candidateBindings=candidates.map(candidate=> {
      const main=admission.rows.find(row=>row.root===candidate.root)?.main;
      const terms:Record<string,TemplateTerm>={id:uri(candidate.id),_sort:literal(candidate.key),_work_iri:uri(candidate.root),
        ...(main?{_main_iri:uri(main)}:{})};
      for(const [variable,paths] of Object.entries(template.hydrateBindings ?? {})) {
        const value=paths.flatMap(path=>candidate.terms[path] ?? [])[0];
        if(value) terms[variable]=uri(value);
      }
      return terms;
    });
    const envelope={query:template.sparql,bindings,tables,candidates:candidateBindings,limit:Math.max(1,candidates.length)};
    const rows=candidates.length ? (await deps.environment.fuseki.templateQuery(envelope)).results?.bindings ?? [] : [];
    session.observeDependency('template-fields',readRowsToken(rows),async()=>readRowsToken(
      candidates.length ? (await deps.environment.fuseki.templateQuery(envelope)).results?.bindings ?? [] : []));
    const byId=new Map<string,ReadRow>();
    for(const row of rows) {
      const id=row.id?.value;
      if(!id || byId.has(id)) throw new WorkReadUnavailable('Template result identity is ambiguous');
      byId.set(id,row);
    }
    const selected=candidates.filter(candidate=>byId.has(candidate.id));
    const page=selected.slice(0,limit);
    const resourceFields=Object.values(template.fields).flatMap(field=>'summary' in field?[field.summary]:[]);
    const summaryIds=[...new Set(page.flatMap(candidate=>resourceFields.map(name=>byId.get(candidate.id)![name]?.value).filter((id):id is string=>!!id)))];
    const summaries=new Map((await session.summaries(summaryIds)).map(summary=>[summary.reference,summary]));
    const authorFields=Object.values(template.fields).flatMap(field=>'author' in field?[field.author]:[]);
    const names=authorFields.length ? await readAuthorNames(session,page.flatMap(candidate=>authorFields.map(name=>byId.get(candidate.id)![name]?.value).filter((key):key is string=>!!key))) : new Map();
    const items=page.flatMap(candidate=> {
      const row=byId.get(candidate.id)!,item:Record<string,unknown>={};
      for(const [name,field] of Object.entries(template.fields)) {
        if('constant' in field) item[name]=field.constant;
        else if('summary' in field) {
          const summary=summaries.get(row[field.summary]?.value ?? '');
          if(summary?.status!=='available') return [];
          item[name]=summary[field.path];
        } else if('author' in field) {
          const value=names.get(row[field.author]?.value ?? '')?.[field.path];
          if(value===undefined && field.optional) continue;
          item[name]=value ?? null;
        } else {
          const value=row[field.term]?.value;
          if(value===undefined && field.optional) continue;
          if(value===undefined && !field.nullable) throw new WorkReadUnavailable('Template field is unavailable');
          item[name]=value===undefined?null:field.valueType==='boolean'?value==='true':field.valueType==='integer'?Number(value):value;
        }
      }
      return [item];
    });
    const last=page.at(-1) ?? candidates.at(-1);
    const hasMore=selected.length>limit || physicalMore && candidates.length>0;
    const nextCursor=hasMore && last ? encodeReadCursor(normalized,position,last.id,last.key,
      cursor?.expiresAt ?? Date.now()+READ_BASIS_RETENTION_MS):null;
    await admit(session,template.root,roots);
    if(readDependencyToken(await extraBasis())!==readDependencyToken(membership)) throw new WorkReadMoved('Template membership moved');
    const payload={profile:'template-result-v1',query:template.query,revision:template.revision,items,
      complete:!nextCursor,nextCursor,sourcePosition:position,count:{value:items.length,kind:'exact-page',total:null}};
    if(!Value.Check(template.response,payload)) throw new WorkReadUnavailable('Template response differs from its schema');
    const etag=`W/"${createHash('sha256').update(JSON.stringify([normalized,position.dependencyToken,items,last,hasMore])).digest('hex')}"`;
    return {payload,etag};
  };
  const result=template.scope==='public'
    ? await publicWorkRead(deps,request,{limit,cursor:input.cursor,language:input.presentation?.language,localBasis:true,readOnlyTemplate:true},operation)
    : await workRead(deps,request,options,operation);
  const headers={'cache-control':'private, no-store',etag:result.etag};
  return request.headers.get('if-none-match')?.split(',').map(value=>value.trim()).some(value=>value===result.etag || value==='*')
    ? new Response(null,{status:304,headers}) : Response.json({profile:'query-v1',template:template.query,
      selection:{context:'global',scope:{kind:'all'},filter:input.parameters,text:null,
        sort:template.eligibility.kind==='discovery-concept'?'newest':'identity',pageSize:limit,facetRefs:[],semanticRevisions:[]},
      result:result.payload},{headers});
}
