import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI interruption releases its real source even when upstream return never settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imports-input-cancel-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let parentTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key = join(dir, 'account.jwk');
    await writeFile(
      key,
      JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'ES256', kid: 'fixture' }),
      { mode: 0o600 },
    );
    const state = join(dir, 'state.sqlite');
    const args = [
      '--source',
      'bangumi',
      '--dump',
      '-',
      '--state',
      state,
      '--api',
      'https://api.rezics.test',
      '--account-key',
      key,
      '--account',
      '00000000-0000-4000-8000-000000000001',
      '--client',
      'rezics-importer',
      '--auth',
      'https://auth.rezics.test',
    ];
    const module = new URL('../src/cli.ts', import.meta.url).href;
    const script = `
      import { Database } from 'bun:sqlite';
      const { runImportCli } = await import(${JSON.stringify(module)});
      const controller=new AbortController(); let ready; const held=new Promise(resolve=>ready=resolve);
      let reads=0, returns=0, requests=0;
      const stdin={ [Symbol.asyncIterator](){return this;}, async next(){ if(++reads===1)return {done:false,value:new TextEncoder().encode('{"id":1,"type":1,"name":"Book"}\\n')};ready();return new Promise(()=>{}); },async return(){returns++;return new Promise(()=>{});} };
      const run=runImportCli(${JSON.stringify(args)},{stdin,signal:controller.signal,fetch:async()=>{requests++;throw new Error('HTTP forbidden');}});
      await held; controller.abort(new DOMException('Operator stop','AbortError'));
      let timer; const result=await Promise.race([run,new Promise(resolve=>timer=setTimeout(()=>resolve(null),2000))]);
      clearTimeout(timer);
      if(!result){console.log(JSON.stringify({completed:false,returns,requests}));process.exit(2);}
      const db=new Database(${JSON.stringify(state)},{readonly:true});
      const owners=db.query('SELECT count(*) AS n FROM import_owners').get().n;
      const baseline=db.query('SELECT count(*) AS n FROM run_members WHERE active=1').get().n;
      db.close(); console.log(JSON.stringify({completed:true,result,returns,requests,owners,baseline}));process.exit(0);
    `;
    child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
    const ended = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        parentTimer = setTimeout(() => resolve(false), 8000);
      }),
    ]);
    if (!ended) {
      child.kill('SIGKILL');
      await child.exited;
    }
    expect(ended).toBe(true);
    const observation = JSON.parse(await new Response(child.stdout).text());
    expect(observation.completed).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(observation.result.code).toBe(130);
    expect(observation.result.openHandles).toBe(0);
    expect(observation.returns).toBeGreaterThan(0);
    expect(observation.requests).toBe(0);
    expect(observation.owners).toBe(0);
    expect(observation.baseline).toBe(0);
  } finally {
    if (parentTimer) clearTimeout(parentTimer);
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
