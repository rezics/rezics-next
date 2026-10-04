import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';

test('G1025: ranked reads seek one admitted page behind 4/16/64 privately read Books', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const started = performance.now();
  await integrationOrderPrelude('g-1025-ranking');
  const { resultPath } = await runWorkProfileChild('services/main/tests/g-1025-ranking-child.ts', {
    timeoutMs: Math.max(1, 410_000 - (performance.now() - started)),
  });
  const evidence = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    rejected: number;
    newSeeks: number;
  }[];
  expect(evidence).toHaveLength(6);
  expect(evidence.every((row) => row.newSeeks === 1)).toBe(true);
}, 420_000);
