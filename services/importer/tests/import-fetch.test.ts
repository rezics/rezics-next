import { expect, test } from 'bun:test';
import { createImportFetch } from '../src/import-fetch.ts';
const origin='https://api.example.test';
const body=JSON.stringify({commands:[{op:'create',key:'stable-command-1',source:{source:'bangumi',external_id:'1'}}]});
const request=()=>new Request(origin+'/v1/subjects:batchWrite',{method:'POST',headers:{'content-type':'application/json','rezics-session-token':'opaque-session'},body});

test('429 waits for Retry-After and retries the exact idempotent request',async()=>{
  const sent:{url:string;method:string;body:string;token:string|null;session:string|null;redirect:string}[]=[];
  const waits:number[]=[];
  const upstream=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init);
    sent.push({url:req.url,method:req.method,body:await req.text(),token:req.headers.get('authorization'),session:req.headers.get('rezics-session-token'),redirect:req.redirect});
    return sent.length===1?Response.json({code:'rate_limited'},{status:429,headers:{'retry-after':'2'}}):Response.json({results:[{key:'stable-command-1',status:201,value:{revision:1}}]});
  };
  const client=createImportFetch({origin,token:async()=>'ordinary-actor-token',fetch:upstream as typeof fetch,sleep:async ms=>{waits.push(ms)}});
  expect((await client(request())).status).toBe(200);
  expect(waits).toEqual([2000]);expect(sent).toHaveLength(2);expect(sent[0]).toEqual(sent[1]);
  expect(sent[0]).toEqual({url:origin+'/v1/subjects:batchWrite',method:'POST',body,token:'Bearer ordinary-actor-token',session:'opaque-session',redirect:'manual'});
});

test('denials and unsafe origins are never retried or sent credentials',async()=>{
  for(const status of [401,403,404,409,422]) {
    let calls=0;const client=createImportFetch({origin,token:async()=>'token',fetch:(async()=>{calls++;return new Response('',{status})}) as typeof fetch,sleep:async()=>{throw new Error('denial retried')}});
    expect((await client(request())).status).toBe(status);expect(calls).toBe(1);
  }
  let sent=0,credentials=0;
  const client=createImportFetch({origin,token:async()=>{credentials++;return 'secret'},fetch:(async()=>{sent++;return new Response()}) as typeof fetch});
  await expect(client('https://evil.example.test/v1/subjects')).rejects.toThrow();
  await expect(client(origin+'/outside-api')).rejects.toThrow();
  expect(sent).toBe(0);expect(credentials).toBe(0);
});

test('uncertain keyed writes retry while unkeyed writes do not',async()=>{
  const seen:string[]=[];
  const client=createImportFetch({origin,token:async()=>'token',fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>{
    seen.push(await new Request(input,init).text());if(seen.length===1)throw new TypeError('connection reset');return Response.json({results:[]});
  }) as typeof fetch,sleep:async()=>{}});
  expect((await client(request())).status).toBe(200);expect(seen).toEqual([body,body]);
  let calls=0;
  const noKey=createImportFetch({origin,token:async()=>'token',fetch:(async()=>{calls++;throw new TypeError('connection reset')}) as typeof fetch,sleep:async()=>{}});
  await expect(noKey(new Request(origin+'/v1/media:importFromUrl',{method:'POST',body:'{}'}))).rejects.toThrow('connection reset');
  expect(calls).toBe(1);
});
