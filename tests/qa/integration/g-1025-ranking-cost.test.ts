import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('G1025: ranked reads seek one admitted page behind 4/16/64 privately read Books',async()=>{
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const child = Bun.spawn([process.execPath,'services/main/tests/g-1025-ranking-child.ts'],{
    env: { ...process.env },stdout: 'pipe',stderr: 'pipe' });
  const [code,output,errors] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Ranking cost failed (${code}): ${errors}\n${output.slice(-2000)}`);
  const evidence = JSON.parse(readFileSync('.temp/work-profiles/g-1025-ranking.json','utf8')) as { rejected: number; newSeeks: number }[];
  expect(evidence).toHaveLength(6); expect(evidence.every(row=>row.newSeeks===1)).toBe(true);
},420_000);
