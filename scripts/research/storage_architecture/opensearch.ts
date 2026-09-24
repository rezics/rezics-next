import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AGENT, INDEX_DEFINITION, REALM, TERM, broadQuery, joinedQuery, makeRoot, oracleEligible, oracleEligibleFor, toIndexed, type SearchRoot } from './opensearch-support';

type Tools = {containerRuntime?:string};
const IMAGE='docker.io/opensearchproject/opensearch:3.6.0';
const IMAGE_ID='b1b447d0d021b051fdb1ae6be100e106667bbe302aa8d6855a4f6d726863d766';
const IMAGE_DIGEST='docker.io/opensearchproject/opensearch@sha256:b5dd1512af2a99748c942cfbbd7f32162623336b210667d0fc6333c6321f171d';
const INDEX='rezics-public-joined-probe';
const now=()=>performance.now();
const elapsed=(start:number)=>Math.round((now()-start)*1000)/1000;
async function command(argv:string[], options:{quiet?:boolean}={}) {
  const child=Bun.spawn(argv,{stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw new Error(`${argv.slice(0,3).join(' ')} failed (${code}): ${stderr.slice(-2000)}`);
  if(!options.quiet&&stderr.trim())console.log(stderr.trim().slice(-1000));
  return stdout.trim();
}
async function inspectImage(runtime:string,outRoot:string) {
  let raw:string;
  try {raw=await command([runtime,'image','inspect',IMAGE],{quiet:true});}
  catch {
    console.log(`Pulling pinned research image ${IMAGE}`);
    await command([runtime,'pull',IMAGE]);
    raw=await command([runtime,'image','inspect',IMAGE],{quiet:true});
  }
  const info=JSON.parse(raw)[0];
  const image={tag:IMAGE,id:info.Id as string,digest:(info.RepoDigests?.[0]??info.Digest??null) as string|null,inspectedAt:new Date().toISOString()};
  if(!image.id)throw new Error('Image inspection returned no ID');
  if(image.id!==IMAGE_ID || image.digest!==IMAGE_DIGEST)throw new Error(`OpenSearch image drift: ${JSON.stringify(image)}`);
  await Bun.write(resolve(outRoot,'image.json'),JSON.stringify(image,null,2));
  console.log(`OpenSearch image ${image.id} ${image.digest??'(no manifest digest)'}`);
  return image;
}

function stats(times:number[]) {
  const sorted=[...times].sort((a,b)=>a-b);
  return {rawMs:times,p50Ms:sorted[Math.floor((sorted.length-1)*.5)]!,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]!,maxMs:sorted.at(-1)!};
}
function hits(response:any):string[] { return (response.hits?.hits??[]).map((hit:any)=>hit._id); }
function total(response:any):number {return response.hits?.total?.value??0;}
function equal(a:unknown,b:unknown,message:string) {
  if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
async function startServer(runtime:string,imageId:string,outRoot:string) {
  const container=`rezics-opensearch-probe-${process.pid}`;
  const data=resolve(outRoot,'data');
  await mkdir(data,{recursive:true});
  try {
  await command([runtime,'run','--rm','-d','--name',container,'-p','127.0.0.1::9200',
    '-e','discovery.type=single-node','-e','DISABLE_SECURITY_PLUGIN=true','-e','DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e','OPENSEARCH_JAVA_OPTS=-Xms1024m -Xmx1024m','-v',`${data}:/usr/share/opensearch/data:Z,U`,imageId],{quiet:true});
  const portLine=await command([runtime,'port',container,'9200/tcp'],{quiet:true});
  const match=portLine.match(/127\.0\.0\.1:(\d+)/);
  if(!match)throw new Error(`Unexpected loopback port binding: ${portLine}`);
  const base=`http://127.0.0.1:${match[1]}`;
  for(let i=0;i<120;i++) {
    try {
      const response=await fetch(base,{signal:AbortSignal.timeout(1000)});
      if(response.ok) {
        const info=await response.json() as any;
        if(info.version?.number!=='3.6.0')throw new Error(`Unexpected server version ${info.version?.number}`);
        return {container,base,serverVersion:info.version.number,buildHash:info.version.build_hash};
      }
    } catch(error) {
      if(String(error).includes('Unexpected server version'))throw error;
    }
    const state=await command([runtime,'inspect','--format','{{.State.Running}}',container],{quiet:true}).catch(()=> 'false');
    if(state!=='true')throw new Error(`OpenSearch stopped during startup: ${(await command([runtime,'logs',container],{quiet:true}).catch(String)).slice(-3000)}`);
    await Bun.sleep(1000);
  }
  throw new Error(`OpenSearch startup timed out: ${(await command([runtime,'logs',container],{quiet:true}).catch(String)).slice(-3000)}`);
  } catch(error) {
    await command([runtime,'rm','-f',container],{quiet:true}).catch(()=>{});
    throw error;
  }
}
function client(base:string) {
  let requestCount=0;
  async function request(method:string,path:string,body?:unknown,contentType='application/json') {
    requestCount++;
    const response=await fetch(`${base}${path}`,{method,headers:body===undefined?undefined:{'content-type':contentType},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    const text=await response.text();
    let parsed:any;
    try { parsed=JSON.parse(text); }catch{parsed=text;}
    if(!response.ok)throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(parsed).slice(0,1600)}`);
    if(parsed?.timed_out===true || (parsed?._shards?.failed??0)>0)throw new Error(`Incomplete response ${method} ${path}: ${JSON.stringify(parsed).slice(0,1600)}`);
    return parsed;
  }
  return {request,get count(){return requestCount;}};
}
async function bulk(api:ReturnType<typeof client>,scale:number) {
  const batchSize=500;
  const started=now();
  for(let start=0;start<scale;start+=batchSize) {
    let ndjson='';
    for(let i=start;i<Math.min(scale,start+batchSize);i++) {
      const root=makeRoot(i,scale);
      ndjson+=`${JSON.stringify({index:{_index:INDEX,_id:root.rootId}})}\n${JSON.stringify(toIndexed(root))}\n`;
    }
    const result=await api.request('POST','/_bulk',ndjson,'application/x-ndjson');
    if(result.errors) {
      const failure=result.items?.find((item:any)=>item.index?.error);
      throw new Error(`Bulk error ${JSON.stringify(failure).slice(0,1200)}`);
    }
    if(start%5000===0)console.log(`Indexed ${Math.min(scale,start+batchSize)}/${scale} public roots`);
  }
  const writeAckMs=elapsed(started);
  const refreshStarted=now();
  await api.request('POST',`/${INDEX}/_refresh`);
  return {writeAckMs,refreshMs:elapsed(refreshStarted),bulkRequests:Math.ceil(scale/batchSize)};
}
function makeHotRoot():SearchRoot {
  const root=makeRoot(500,10_000);
  root.rootId='resource:hot';
  const base=root.textUnits[0]!;
  root.textUnits=Array.from({length:200},(_,i)=>({...base,field:`body-chunk-${i}`,body:`第 ${i} 段中文公共正文。`.repeat(80),revisionId:'revision:hot:global'}));
  root.credits=Array.from({length:200},(_,i)=>({agent:i===0?AGENT:`agent:hot:${i}`,role:i===0?'translator':i%2===0?'author':'editor',occurrence:`credit:${i}`}));
  root.fixtureState.creditOccurrences=root.credits;
  root.classifications=Array.from({length:8},(_,i)=>({senseId:i===0?'sense:accepted':`sense:hot:${i}`,globalAccept:true,localAcceptContexts:[],localRejectContexts:[]}));
  root.fixtureState.globalSenseAccepted=true;
  root.ratings=[{contextId:REALM.rating,sum:9,count:1,meanFloorTimes10:90}];
  return root;
}
async function oneRootUpdate(api:ReturnType<typeof client>,root:SearchRoot,query:any) {
  const path=`/${INDEX}/_doc/${encodeURIComponent(root.rootId)}`;
  const before=await api.request('GET',path);
  const witnessPath=`/${INDEX}/_doc/${encodeURIComponent('resource:000006')}`;
  const witnessBefore=await api.request('GET',witnessPath);
  const statsBefore=await api.request('GET',`/${INDEX}/_stats/store,docs`);
  const beforeSearch=await api.request('POST',`/${INDEX}/_search`,query);
  if(!hits(beforeSearch).includes(root.rootId))throw new Error(`Update control was not eligible before update: ${root.rootId}`);
  const changed=structuredClone(root);
  changed.ratings[0]={contextId:REALM.rating,sum:6,count:1,meanFloorTimes10:60};
  changed.fixtureState.ratingSum=6;
  const ackStart=now();
  const ack=await api.request('PUT',`${path}?refresh=false`,toIndexed(changed));
  const writeAckMs=elapsed(ackStart);
  const refreshStart=now();
  await api.request('POST',`/${INDEX}/_refresh`);
  const refreshVisibleMs=elapsed(refreshStart);
  const after=await api.request('GET',path);
  const witnessAfter=await api.request('GET',witnessPath);
  const statsAfter=await api.request('GET',`/${INDEX}/_stats/store,docs`);
  const joined=await api.request('POST',`/${INDEX}/_search`,query);
  equal(after._version,before._version+1,'Only addressed root version should advance');
  equal(witnessAfter._version,witnessBefore._version,'Unrelated root version must remain unchanged');
  if(hits(joined).includes(root.rootId))throw new Error('Updated rating should remove target');
  return {rootId:root.rootId,bytesBefore:Buffer.byteLength(JSON.stringify(toIndexed(root))),bytesAfter:Buffer.byteLength(JSON.stringify(toIndexed(changed))),nestedCount:root.textUnits.length+root.credits.length+root.classifications.length+root.ratings.length,writeAckMs,refreshVisibleMs,versionBefore:before._version,versionAfter:after._version,witnessRootId:'resource:000006',witnessVersionBefore:witnessBefore._version,witnessVersionAfter:witnessAfter._version,storeBytesBefore:statsBefore.indices?.[INDEX]?.total?.store?.size_in_bytes,storeBytesAfter:statsAfter.indices?.[INDEX]?.total?.store?.size_in_bytes,luceneDocsBefore:statsBefore.indices?.[INDEX]?.total?.docs,luceneDocsAfter:statsAfter.indices?.[INDEX]?.total?.docs,indexOperation:ack.result,queryBefore:hits(beforeSearch),queryAfter: hits(joined)};
}
async function scaleProbe(api:ReturnType<typeof client>,scale:number) {
  await api.request('DELETE',`/${INDEX}`).catch(()=>{});
  await api.request('PUT',`/${INDEX}`,INDEX_DEFINITION);
  const ingest=await bulk(api,scale);
  const oracle:string[]=[];
  for(let i=0;i<scale;i++)if(oracleEligible(makeRoot(i,scale)))oracle.push(makeRoot(i,scale).rootId);
  const fullQuery=joinedQuery(1000);
  const full=await api.request('POST',`/${INDEX}/_search`,fullQuery);
  const fullIds=hits(full);
  equal(total(full),oracle.length,'Joined total count');
  equal([...fullIds].sort(),[...oracle].sort(),'Joined eligibility IDs versus typed fixture oracle');
  const top3=await api.request('POST',`/${INDEX}/_search`,joinedQuery(3));
  equal(hits(top3),fullIds.slice(0,3),'TopK order versus all matched hits from the same engine');
  const first100=await api.request('POST',`/${INDEX}/_search`,broadQuery(100));
  const candidateIds=hits(first100);
  const residual=candidateIds.filter(id=>oracle.includes(id));
  equal(residual,[],'Early text top100 should be a false empty after relation filters');
  const broad=await api.request('POST',`/${INDEX}/_search`,broadQuery(20));
  const wideOracle:string[]=[];
  for(let i=0;i<scale;i++)if(oracleEligibleFor(makeRoot(i,scale),'author','common'))wideOracle.push(makeRoot(i,scale).rootId);
  const wideJoinedQuery=joinedQuery(20,'author','common');
  const wideJoined=await api.request('POST',`/${INDEX}/_search`,wideJoinedQuery);
  equal(total(wideJoined),wideOracle.length,'Wide joined total count versus typed fixture oracle');
  if(wideOracle.length<scale*.95)throw new Error('Wide joined fixture is not actually wide');
  const tokens=await api.request('POST',`/${INDEX}/_analyze`,{analyzer:'cjk',text:TERM});
  const count=await api.request('GET',`/${INDEX}/_count`);
  const indexStats=await api.request('GET',`/${INDEX}/_stats/store,docs,indexing,search`);
  const index=indexStats.indices?.[INDEX]?.total;
  const measured:any={};
  for(const [name,query] of [['joinedTop3',joinedQuery(3)],['joinedAll',joinedQuery(1000)],['textCandidateTop20',broadQuery(20)],['wideJoinedTop20',wideJoinedQuery]] as const) {
    for(let i=0;i<3;i++)await api.request('POST',`/${INDEX}/_search`,query);
    const durations:number[]=[];
    for(let i=0;i<15;i++) {const start=now();await api.request('POST',`/${INDEX}/_search`,query);durations.push(elapsed(start));}
    measured[name]=stats(durations);
  }
  let update:any;
  if(scale===10_000) {
    const tiny=makeRoot(scale-1,scale);
    const tinyUpdate=await oneRootUpdate(api,tiny,fullQuery);
    const after=await api.request('POST',`/${INDEX}/_search`,fullQuery);
    equal([...hits(after)].sort(),oracle.filter(id=>id!==tiny.rootId).sort(),'Oracle after one-root update');
    const hot=makeHotRoot();
    const hotAck=await api.request('PUT',`/${INDEX}/_doc/${encodeURIComponent(hot.rootId)}?refresh=false`,toIndexed(hot));
    if(hotAck.result!=='created')throw new Error('Hot root should be newly created');
    await api.request('POST',`/${INDEX}/_refresh`);
    const hotUpdate=await oneRootUpdate(api,hot,fullQuery);
    update={tiny:tinyUpdate,hot:hotUpdate,hotRootChunkCount:200,hotRootCreditCount:200,hotSingleRevisionId:'revision:hot:global'};
  }
  return {size:scale,checks:{typedOracleCount:oracle.length,joinedTotal:total(full),allEligibleIds:oracle,fullRankedIds:fullIds,limitedTop3:hits(top3),firstText100ResidualCount:residual.length,firstText100Ids:candidateIds,broadTotal:total(broad),wideJoinedOracleCount:wideOracle.length,wideJoinedTotal:total(wideJoined),wideJoinedTop20:hits(wideJoined),physicalRootCount:count.count,independentRelevanceOracle:false},ingest,index:{storeBytes:index?.store?.size_in_bytes,physicalLuceneDocs:index?.docs?.count,deletedLuceneDocs:index?.docs?.deleted,rootCount:count.count,raw:indexStats.indices?.[INDEX]},analyzerTokens:tokens.tokens?.map((token:any)=>({token:token.token,type:token.type,position:token.position})),measurements:measured,update,requests:api.count};
}

export async function runOpenSearch(root:string,tools:Tools) {
  const outRoot=resolve(root,'.temp/storage-architecture/opensearch');
  await mkdir(outRoot,{recursive:true});
  const runtime=tools.containerRuntime;
  if(!runtime)throw new Error('tools.json lacks approved containerRuntime');
  const image=await inspectImage(runtime,outRoot);
  if(process.argv.includes('--prepare-only'))return {prepared:true,image};
  if(process.argv.includes('--annotate-results')) {
    const resultPath=resolve(outRoot,'results.json');
    const result=await Bun.file(resultPath).json() as any;
    if(result.error || result.scales?.length!==2)throw new Error('No complete OpenSearch results to annotate');
    for(const scale of result.scales) {
      const membership=(scale.checks.wideJoinedTop20 as string[]).every((id:string)=>{
        const i=Number(id.split(':').at(-1));
        return Number.isInteger(i)&&i>=0&&i<scale.size&&oracleEligibleFor(makeRoot(i,scale.size),'author','common');
      });
      if(!membership)throw new Error(`Wide top20 membership failed for scale ${scale.size}`);
      scale.checks.wideTop20MembershipChecked=true;
    }
    const left=await command([runtime,'ps','-a','--filter','name=rezics-opensearch-probe','--format','{{.Names}}'],{quiet:true});
    if(left.trim())throw new Error(`Probe container cleanup incomplete: ${left}`);
    result.containerCleanupVerifiedAt=new Date().toISOString();
    result.evidenceAnnotatedAt=new Date().toISOString();
    result.limitations=[...new Set([...(result.limitations??[]),
      'Wide joined checks compare exact total and top-20 oracle membership; they do not enumerate every wide matched ID at 50,000.',
      'Unavailable context was tested as a pure oracle readiness error; no production readiness gate or checkpoint protocol was implemented.',
      'One-root rewrite measurements do not qualify the full graph/outbox pipeline or a mixed concurrent load.',
      'Ranked grain is one public Resource root: the score is the maximum eligible text MatchUnit score among its selected revision; ties use stable rootId. No independent relevance oracle is asserted.',
    ])];
    await Bun.write(resultPath,JSON.stringify(result,null,2));
    return {annotated:true,containerCleanupVerifiedAt:result.containerCleanupVerifiedAt,scales:result.scales.map((s:any)=>({size:s.size,wideTop20Membership:s.checks.wideTop20MembershipChecked}))};
  }
  if(await Bun.file(resolve(outRoot,'results.json')).exists() && !await Bun.file(resolve(outRoot,'first-run.json')).exists())await Bun.write(resolve(outRoot,'first-run.json'),Bun.file(resolve(outRoot,'results.json')));
  const runDir=resolve(outRoot,`run-${new Date().toISOString().replace(/[:.]/g,'-')}`);
  await mkdir(runDir,{recursive:true});
  let server:Awaited<ReturnType<typeof startServer>>|undefined;
  const result:any={generatedAt:new Date().toISOString(),environment:{image,serverVersion:null,containerRuntime:runtime,runDir,loopbackOnly:true},mapping:INDEX_DEFINITION,queries:{joined:joinedQuery(3),wideJoined:joinedQuery(20,'author','common'),textCandidate:broadQuery(20)},fixture:{term:TERM,agent:AGENT,typedRealmContexts:REALM,scales:[10_000,50_000],publication:'fixed Global to Realm, absent inherits; accept selects local revision; reject shadows baseline',classification:'named Sense with global accept and sparse Realm accept/reject; separate common Sense for wide conjunction',rating:'exact-context sum/count; indexed floor(10*sum/count), threshold 80; zero count encoded -1',disclosure:'public participating text only',rankingGrain:'one Resource root; max eligible text MatchUnit score among one selected revision; rootId ascending tie break'},scales:[],limitations:['This is a public read-model feasibility probe, not full SEARCH contract qualification.','The CJK analyzer is built in and may not have the same candidate semantics as Jena unigram+bigram.','Same-engine full-hit versus limited topK checks detect pre-truncation loss, not general linguistic relevance.','Only fixed Global-to-Realm typed-context resolution, direct credits, two Senses, one rating criterion, and one public resource root are modeled.','One root document update is atomic in OpenSearch; cross-root coherent graph cut and read-after-write minimum checkpoint require additional activation design.','Warm single-client local timings are not production SLOs.','Wide joined checks compare exact total and top-20 oracle membership; they do not enumerate every wide matched ID at 50,000.','Unavailable context was tested as a pure oracle readiness error; no production readiness gate or checkpoint protocol was implemented.','One-root rewrite measurements do not qualify the full graph/outbox pipeline or a mixed concurrent load.','Ranked grain is one public Resource root: the score is the maximum eligible text MatchUnit score among its selected revision; ties use stable rootId. No independent relevance oracle is asserted.']};
  try {
    server=await startServer(runtime,image.id,runDir);
    result.environment={...result.environment,serverVersion:server.serverVersion,buildHash:server.buildHash,endpoint:server.base};
    const api=client(server.base);
    for(const scale of [10_000,50_000]) {
      console.log(`OpenSearch joined probe scale ${scale}`);
      result.scales.push(await scaleProbe(api,scale));
      await Bun.write(resolve(outRoot,'results.json'),JSON.stringify(result,null,2));
    }
    result.completedAt=new Date().toISOString();
  } catch(error) {
    result.error=String(error);
    result.failedAt=new Date().toISOString();
    throw error;
  } finally {
    if(server) {
      const logs=await command([runtime,'logs',server.container],{quiet:true}).catch(error=>String(error));
      await Bun.write(resolve(runDir,'container.log'),logs);
      await command([runtime,'rm','-f',server.container],{quiet:true}).catch(error=>console.error(error));
    }
    await Bun.write(resolve(outRoot,'results.json'),JSON.stringify(result,null,2));
  }
  return {scales:result.scales.map((s:any)=>({size:s.size,checks:s.checks.typedOracleCount,joinedP50:s.measurements.joinedTop3.p50Ms,joinedP95:s.measurements.joinedTop3.p95Ms,rootCount:s.index.rootCount})),environment:result.environment};
}
