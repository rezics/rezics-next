import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const temp = resolve(root, '.temp/storage-architecture');
await mkdir(temp, { recursive: true });
async function run(cmd: string[], options: { cwd?: string; env?: Record<string,string|undefined> } = {}) {
  const child = Bun.spawn(cmd, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed: ${cmd.join(' ')}`);
}
async function capture(cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function download(url: string, path: string) {
  if (await Bun.file(path).exists()) return;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  await Bun.write(path, response);
}
const command = process.argv[2];
if (command === 'inspect') {
  const report: Record<string, unknown> = { time: new Date().toISOString(), platform: process.platform, arch: process.arch };
  for (const [name, cmd] of Object.entries({ bun: ['bun','--version'], java:['java','--version'], postgres:['postgres','--version'], rust:['rustc','--version'], cargo:['cargo','--version'], docker:['docker','--version'], image:['docker','image','inspect','rezics-postgres:18.6-pgroonga-4.0.8'], host:['lscpu'], disk:['df','-T',temp] })) {
    try { report[name] = await capture(cmd); } catch (error) { report[name] = String(error); }
  }
  report.alternativeDockerHosts = {};
  if(Bun.which('podman')) {
    report.podman=await capture(['podman','--version']);
    report.podmanImage=await capture(['podman','image','inspect','rezics-postgres:18.6-pgroonga-4.0.8']);
    const inspected=report.podmanImage as {code:number;stdout:string};
    if(inspected.code===0) {
      const image=JSON.parse(inspected.stdout)[0];
      report.podmanImage={id:image.Id,digest:image.Digest,tags:image.RepoTags};
      if(image.Id==='df9394ae660618227f519eeb0c2a4d9721c0b590ffaf4c49652747a601c1bf91' && await Bun.file(resolve(temp,'tools.json')).exists()) {
        const manifest=await Bun.file(resolve(temp,'tools.json')).json();
        Object.assign(manifest,{containerRuntime:Bun.which('podman'),pgroongaImage:image.Id,pgroongaDigest:image.Digest});
        await Bun.write(resolve(temp,'tools.json'),JSON.stringify(manifest,null,2));
      }
    }
  }
  for(const socket of ['/var/run/docker.sock',`/run/user/${process.getuid?.()}/podman/podman.sock`]) {
    if(await Bun.file(socket).exists()) (report.alternativeDockerHosts as Record<string,unknown>)[socket]=await capture(['docker','--host',`unix://${socket}`,'image','inspect','rezics-postgres:18.6-pgroonga-4.0.8']);
  }
  await Bun.write(resolve(temp,'inventory.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} else if (command === 'prepare') {
  const downloads = resolve(temp,'downloads');
  await mkdir(downloads,{recursive:true});
  const commit='82dbcec3e435d6ed1d45bc0ed929432323b6b201';
  const archive=resolve(downloads,'fluree-linux-x86_64.tar.xz');
  const releaseResponse=await fetch('https://api.github.com/repos/fluree/db/releases/tags/v4.2.1');
  if (!releaseResponse.ok) throw new Error(`Release API: ${releaseResponse.status}`);
  const release=await releaseResponse.json() as {assets:{name:string;browser_download_url:string}[]};
  console.log('Release assets:',release.assets.map(a=>a.name));
  const asset=release.assets.find(a=>/linux/.test(a.name)&&/x86_64|amd64/.test(a.name)&&/\.tar\.xz$/.test(a.name));
  if (!asset) throw new Error('No pinned Linux x86_64 asset');
  await download(asset.browser_download_url,archive);
  const sha=new Bun.CryptoHasher('sha256').update(await Bun.file(archive).arrayBuffer()).digest('hex');
  if(sha!=='01ca654e354db61caf28f362eef2a5868ddf9173c2bb1261d988007c4aaa5a5c') throw new Error(`Unexpected Fluree checksum: ${sha}`);
  const engineDir=resolve(temp,'fluree'); await mkdir(engineDir,{recursive:true});
  await run(['tar','-xJf',archive,'-C',engineDir]);
  const candidates=Array.from(new Bun.Glob('**/fluree').scanSync({cwd:engineDir,absolute:true}));
  if(candidates.length!==1)throw new Error(`Ambiguous binary: ${candidates}`);
  const fluree=candidates[0]!;
  const oldJenaJar=resolve(root,'scripts/research/jena_text_cjk/lab/jena-fuseki-server-6.2.0.jar');
  const jenaJar=await Bun.file(oldJenaJar).exists()?oldJenaJar:resolve(downloads,'jena-fuseki-server-6.2.0.jar');
  await download('https://repo.maven.apache.org/maven2/org/apache/jena/jena-fuseki-server/6.2.0/jena-fuseki-server-6.2.0.jar',jenaJar);
  const jenaSha=new Bun.CryptoHasher('sha1').update(await Bun.file(jenaJar).arrayBuffer()).digest('hex');
  if(jenaSha!=='d3490295a2b95677c1227d25bca8564d40f993a7')throw new Error(`Jena checksum ${jenaSha}`);
  const prior=await Bun.file(resolve(temp,'tools.json')).exists()?await Bun.file(resolve(temp,'tools.json')).json():{};
  const manifest: Record<string,unknown> = {...prior,fluree,java:Bun.which('java'),javac:Bun.which('javac'),jenaJar,postgres:Bun.which('postgres'),initdb:Bun.which('initdb'),pg_ctl:Bun.which('pg_ctl'),psql:Bun.which('psql'),flureeSha256:sha,jenaSha1:jenaSha,sourceCommit:commit,createdAt:new Date().toISOString()};
  await Bun.write(resolve(temp,'tools.json'),JSON.stringify(manifest,null,2));
  await run([fluree,'--version']);
  if(process.argv.includes('--skip-bridge')) process.exit(0);
  const sourceArchive=resolve(downloads,`fluree-${commit}.tar.gz`);
  await download(`https://codeload.github.com/fluree/db/tar.gz/${commit}`,sourceArchive);
  manifest.sourceArchiveSha256=new Bun.CryptoHasher('sha256').update(await Bun.file(sourceArchive).arrayBuffer()).digest('hex');
  await run(['tar','-xzf',sourceArchive,'-C',downloads]);
  const source=resolve(downloads,`db-${commit}`);
  const target=resolve(temp,'cargo-target');
  await run(['cargo','build','--release','--locked','--manifest-path',resolve(source,'fluree-sql-bridge/Cargo.toml')],{env:{...process.env,CARGO_TARGET_DIR:target}});
  manifest.bridge=resolve(target,'release/fluree-sql-bridge');
  manifest.source=source;
  await Bun.write(resolve(temp,'tools.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(manifest,null,2));
} else if(command==='report') {
  for(const [probe,file] of [['graph','results.json'],['search','results.json'],['opensearch','results.json'],['bridge','result.json'],['dgraph','results.json'],['virtuoso','results.json']]) {
    const path=resolve(temp,probe!,file!);
    if(!await Bun.file(path).exists())continue;
    const result=await Bun.file(path).json();
    if(probe==='graph')console.log(JSON.stringify({probe,time:result.generatedAt,scales:result.scales.map((s:any)=>({size:s.size,checks:s.checks.length,error:s.error,engines:Object.fromEntries(Object.entries(s.engines).map(([k,v]:any)=>[k,{error:v.error,ingestion:v.ingestion,cas:v.cas,publication:v.publication,bytesOnDisk:v.bytesOnDisk,reads:Object.fromEntries(Object.entries(v.reads??{}).map(([q,m]:any)=>[q,{p50:m.p50,p95:m.p95,p99:m.p99}]))}]))}))},null,2));
    else if(probe==='search')console.log(JSON.stringify({probe,environment:result.environment,error:result.error,blocker:result.blocker,jenaCases:result.jenaSemantics?.passed,pgroongaCases:result.pgroongaSemantics?.passed,workloads:result.workloads?.map((w:any)=>({rows:w.rows,paths:Object.fromEntries(['batchedExchange','pgExact','jenaGraphFirst','jenaGraphFirstContains','pgGraphFirstContains'].map(k=>[k,w[k]]))})),recommendation:result.recommendation},null,2));
    else if(probe==='opensearch')console.log(JSON.stringify({probe,environment:result.environment,scales:result.scales?.map((s:any)=>({size:s.size,eligible:s.checks?.typedOracleCount,wideEligible:s.checks?.wideJoinedTotal,top100Residual:s.checks?.firstText100ResidualCount,rootCount:s.index?.rootCount,storeBytes:s.index?.storeBytes,luceneDocs:s.index?.physicalLuceneDocs,requests:s.requests,ingest:s.ingest,latencies:s.measurements,update:s.update?{tiny:s.update.tiny&&{bytes:s.update.tiny.bytesBefore,nested:s.update.tiny.nestedCount,writeAckMs:s.update.tiny.writeAckMs,refreshVisibleMs:s.update.tiny.refreshVisibleMs},hot:s.update.hot&&{bytes:s.update.hot.bytesBefore,nested:s.update.hot.nestedCount,writeAckMs:s.update.hot.writeAckMs,refreshVisibleMs:s.update.hot.refreshVisibleMs}}:undefined})),limitations:result.limitations,error:result.error},null,2));
    else if(probe==='dgraph')console.log(JSON.stringify({probe,version:result.environment?.version,size:result.checks?.ingest?.size,edges:result.checks?.relations?.directedEdges,sameOccurrence:result.checks?.occurrences?.sameOccurrenceIds,variablePredicate:result.checks?.occurrences?.variablePredicateIds,casWinners:result.checks?.cas?.committedAttemptCount,requests:result.requests,cleanup:result.containerCleanupVerified,error:result.error},null,2));
    else if(probe==='virtuoso')console.log(JSON.stringify({probe,version:result.version,scale:result.workload?.scale,cjkPassed:result.cjkCases?.filter((c:any)=>c.matchesOracle).length,joinedIds:result.ranking?.joinedIds,textTop100FullResidual:result.ranking?.broadTop100FullResidualIds,occurrence:result.occurrenceControl,visibility:result.indexVisibility,sqlSessions:result.sqlSessions,httpRequests:result.httpRequests,cleanup:result.containerCleanupVerified,error:result.error},null,2));
    else console.log(JSON.stringify({probe,status:result.status,error:result.error,versions:result.versions,directBridge:result.directBridge,outerBindings:Object.fromEntries(Object.entries(result.outerBindings??{}).map(([k,rows]:any)=>[k,rows.map((r:any)=>({count:r.count,observedRows:r.observedRows,correct:r.correct,elapsedMs:r.elapsedMs,trackedPushdownCount:r.trackedPushdownCount,bridgeStatementLogCount:r.bridgeStatementLogCount}))])),directArray:result.directArray,snapshot:result.snapshot},null,2));
    if(process.argv.includes('--retain')) {
      const out=resolve(root,'scripts/research/storage_architecture/evidence/2026-09-24');
      await mkdir(out,{recursive:true});
      await Bun.write(resolve(out,`${probe}.json`),Bun.file(path));
      if(probe==='virtuoso'&&await Bun.file(resolve(temp,'virtuoso/joined-plan.out.txt')).exists())await Bun.write(resolve(out,'virtuoso-plan.txt'),Bun.file(resolve(temp,'virtuoso/joined-plan.out.txt')));
      for(const meta of ['inventory.json','tools.json'])if(await Bun.file(resolve(temp,meta)).exists())await Bun.write(resolve(out,meta),Bun.file(resolve(temp,meta)));
      for(const [from,to] of [['graph/post-index-50000.json','graph-post-index.json'],['bridge/measurement-baseline.json','bridge-measurement-baseline.json']]) {
        if(await Bun.file(resolve(temp,from!)).exists())await Bun.write(resolve(out,to!),Bun.file(resolve(temp,from!)));
      }
      const hashes:Record<string,string>={};
      for(const file of await readdir(import.meta.dir))if(/\.(ts|java|json)$/.test(file))hashes[file]=new Bun.CryptoHasher('sha256').update(await Bun.file(resolve(import.meta.dir,file)).arrayBuffer()).digest('hex');
      await Bun.write(resolve(out,'probe-sources.json'),JSON.stringify(hashes,null,2));
    }
  }
} else if(['graph','search','opensearch','bridge','dgraph','virtuoso'].includes(command ?? '')) {
  const manifest=await Bun.file(resolve(temp,'tools.json')).json();
  const module=await import(`./${command}.ts`);
  const entry={graph:'runGraph',search:'runSearch',opensearch:'runOpenSearch',bridge:'runBridge',dgraph:'runDgraph',virtuoso:'runVirtuoso'}[command as 'graph'|'search'|'opensearch'|'bridge'|'dgraph'|'virtuoso'];
  const result=await module[entry](root,manifest);
  if(result!==undefined)console.log(JSON.stringify(result,null,2));
} else {
  throw new Error('Usage: yarn research:architecture inspect|prepare [--skip-bridge]|graph|search|opensearch|bridge|dgraph|virtuoso|report [--retain]');
}
