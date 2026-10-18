import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root=process.cwd(), base=resolve('.temp/frontend-hotkeys');
const source=resolve('scripts/research/frontend-hotkeys');
const copy=join(base,'route-copy');
const out=join(base,'route-captures');mkdirSync(out,{recursive:true});
const result={revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
  sourceRevision:spawnSync('git',['rev-parse','HEAD:apps/web'],{encoding:'utf8'}).stdout.trim(),
  method:'Private copies of both complete apps and their original Vinext/Cloudflare/Tailwind production configurations. The same fixture is appended in the private root layout. Native means the corrected native adapter; current native owners are preserved separately in behavior evidence.',
  buildFlags:{NODE_ENV:'production',CLOUDFLARE_SEND_METRICS:'false',NEXT_TELEMETRY_DISABLED:'1', minify:'repository default'},
  compression:{gzipLevel:9,brotliQuality:11,unit:'per loaded JS/CSS response, no source maps; transfer headers excluded'}, builds:[]};
const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function port(){const s=createServer();await new Promise(done=>s.listen(0,'127.0.0.1',done));const n=s.address().port;await new Promise(done=>s.close(done));return n;}
async function run(command,cwd,env,path){
  const child=spawn(command[0],command.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});const data=[];
  child.stdout.on('data',chunk=>data.push(chunk));child.stderr.on('data',chunk=>data.push(chunk));
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});
  writeFileSync(path,Buffer.concat(data));return code;
}
if(existsSync(copy))rmSync(copy,{recursive:true});mkdirSync(copy,{recursive:true});
// The unchanged Vite config imports production-env, which imports service specs.
for(const directory of ['apps','packages','services'])cpSync(join(root,directory),join(copy,directory),{recursive:true,
  filter:path=>!/(?:^|\/)(?:node_modules|dist|\.vinext|\.wrangler|\.temp)(?:\/|$)/.test(relative(root,path))});
mkdirSync(join(copy,'scripts'),{recursive:true});cpSync(join(root,'scripts/ops'),join(copy,'scripts/ops'),{recursive:true});
cpSync(join(root,'Taskfile.yml'),join(copy,'Taskfile.yml'));
for(const name of ['package.json','yarn.lock','.yarnrc.yml'])cpSync(join(root,name),join(copy,name));
symlinkSync(join(root,'node_modules'),join(copy,'node_modules'));
for(const app of ['web','accounts']){
  const appRoot=join(copy,'apps',app);
  const original=readFileSync(join(appRoot,'vite.config.ts'),'utf8');writeFileSync(join(appRoot,'vite.base.config.ts'),original);
  writeFileSync(join(appRoot,'vite.config.ts'),`import base from './vite.base.config.ts';
import {mergeConfig} from 'vite';
const candidate=process.env.HOTKEY_CANDIDATE ?? 'native';
export default mergeConfig(base,{
 resolve:{dedupe:['react','react-dom'],alias:{
  'virtual:hotkey-adapter':'${source}/adapter-'+candidate+'.tsx',
  'virtual:native-owners':'${source}/native-empty.tsx',
  '@tanstack/react-hotkeys':'${base}/trial/node_modules/@tanstack/react-hotkeys/dist/index.js'}},
 define:{__CANDIDATE__:JSON.stringify(candidate)},
 plugins:[{name:'keyboard-route-module-evidence',generateBundle(_options,bundle){
  this.emitFile({type:'asset',fileName:'keyboard-module-closure.json',source:JSON.stringify(Object.fromEntries(Object.entries(bundle).filter(([,item])=>item.type==='chunk').map(([file,item])=>[file,Object.entries(item.modules).map(([id,info])=>({id,renderedLength:info.renderedLength}))])))})
 }}]
});\n`);
  const layoutPath=join(appRoot,'app/layout.tsx');const layout=readFileSync(layoutPath,'utf8');
  writeFileSync(layoutPath,`import KeyboardFixture from '${source}/fixture.tsx';\n`+layout.replace('{children}','{children}<KeyboardFixture />'));
}
for(const candidate of ['native','ark','tanstack'])for(const app of ['web','accounts']){
  const appRoot=join(copy,'apps',app),id=`${candidate}-${app}`;
  const env={...process.env,HOTKEY_CANDIDATE:candidate,CLOUDFLARE_SEND_METRICS:'false',NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production'};
  const record={candidate,app,route:app==='web'?'/en/discover':'/sign-in',buildCommand:`task ${app==='web'?'web':'accounts'}:build`,buildLog:`${out}/${id}-build.log`};
  result.builds.push(record);
  console.log(`Building private ${id}`);
  // Each whole build obtains host memory/CPU admission; no shared services start.
  record.code=await run(['bun',join(root,'scripts/qa/host-admission.ts'),'--cpu','--gib','4','--','task',`${app==='web'?'web':'accounts'}:build`],copy,env,record.buildLog);
  if(record.code!==0){record.status='build-failed';writeFileSync(join(base,'routes.json'),JSON.stringify(result,null,2));continue;}
  const buildDirectory=join(out,`${id}-dist`);rmSync(buildDirectory,{recursive:true,force:true});cpSync(join(appRoot,'dist'),buildDirectory,{recursive:true});
  const n=await port(),origin=`http://127.0.0.1:${n}`,logs=[];
  const preview=spawn('task',['--taskfile',join(source,'Taskfile.yml'),'route:preview','--','--port',String(n)],
    {cwd:root,env:{...env,KEYBOARD_PREVIEW_CWD:appRoot},detached:true,stdio:['ignore','pipe','pipe']});
  preview.stdout.on('data',chunk=>logs.push(chunk));preview.stderr.on('data',chunk=>logs.push(chunk));
  let browser;
  try{
    let response;
    for(let i=0;i<100;i++){
      try{response=await fetch(origin+record.route,{signal:AbortSignal.timeout(3000)});if(response.ok)break;}catch{}
      if(preview.exitCode!==null)throw new Error(`Preview exited ${preview.exitCode}`);
      await wait(250);
    }
    if(!response?.ok)throw new Error(`No successful production route: ${response?.status}`);
    const html=await response.text();writeFileSync(`${out}/${id}-ssr.html`,html);record.ssrBytes=Buffer.byteLength(html);
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({reducedMotion:'reduce'});
    const page=await context.newPage();const loaded=new Map();const bodyJobs=[];record.errors=[];
    page.on('pageerror',error=>record.errors.push(String(error)));
    page.on('response',response=>{if(['script','stylesheet'].includes(response.request().resourceType()))bodyJobs.push((async()=>{
      const data=await response.body();const url=new URL(response.url());if(url.origin!==origin)return;
      loaded.set(url.pathname,{path:url.pathname,raw:data.length,gzip:gzipSync(data,{level:9}).length,
        brotli:brotliCompressSync(data,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length,sha256:createHash('sha256').update(data).digest('hex')});
    })().catch(error=>record.errors.push(String(error))));});
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin+record.route);await page.locator('#keyboard-fixture').waitFor();
    await page.waitForFunction(()=>window.__fixture&&window.__adapter,undefined,{timeout:45000});
    await page.getByRole('button',{name:'Open trial modal',exact:true}).click();await page.locator('#modal-input').waitFor();
    await page.keyboard.press('Escape');await page.waitForTimeout(300);await Promise.all(bodyJobs);
    record.latency=[];
    for(const count of [5,50]){
      await page.getByLabel('Registration count').selectOption(String(count));await page.waitForTimeout(100);
      const raw=await page.evaluate(()=>Array.from({length:3},()=>Array.from({length:120},()=>{
        window.__fixture.clear();const target=document.querySelector('#page-target');target.focus();
        const start=performance.now();target.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true,cancelable:true}));
        target.dispatchEvent(new KeyboardEvent('keyup',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true}));
        return {ms:window.__fixture.logs.find(row=>row.id==='search')?.at-start,actions:window.__fixture.logs.map(row=>row.id)};
      })));
      const values=raw.flat().filter(row=>Number.isFinite(row.ms)).map(row=>row.ms).sort((a,b)=>a-b);
      record.latency.push({count,registrations:await page.evaluate(()=>window.__adapter.count()),raw,
        validSamples:values.length,p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)]});
    }
    record.chunks=[...loaded.values()].sort((a,b)=>a.path.localeCompare(b.path));
    record.totals=Object.fromEntries(['raw','gzip','brotli'].map(key=>[key,record.chunks.reduce((sum,row)=>sum+row[key],0)]));
    record.status='measured';record.browser=browser.version();
    await page.screenshot({path:`${out}/${id}.png`,fullPage:true});
    await context.close();
  }catch(error){record.status='preview-unavailable';record.error=String(error.stack||error);}
  finally{await browser?.close();try{process.kill(-preview.pid,'SIGTERM')}catch{}await wait(500);try{process.kill(-preview.pid,'SIGKILL')}catch{}
    writeFileSync(`${out}/${id}-preview.log`,Buffer.concat(logs));}
  writeFileSync(join(base,'routes.json'),JSON.stringify(result,null,2)+'\n');
  console.log(id,record.status,record.totals??record.error);
}
writeFileSync(join(base,'routes.json'),JSON.stringify(result,null,2)+'\n');
if(result.builds.some(record=>record.status!=='measured'))process.exitCode=1;
