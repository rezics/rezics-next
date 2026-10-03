import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { qaStackEnvironment, qaStackMode, scaleIntegrationFiles, scalePreparationBudgetMs } from '../../../scripts/qa/stack-environment.ts';
import { composeProcessEnvironment, ensureSecrets, stackStorage, type StackOptions } from '../../../scripts/dev/config.ts';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';

test('G1031: scale selects disk storage and larger allocations while ordinary QA retains tmpfs', () => {
  const ordinary = qaStackEnvironment({});
  const scale = qaStackEnvironment({ REZICS_QA_STACK_MODE: 'scale' });
  expect(qaStackMode(ordinary)).toBe('test');
  expect(stackStorage({ profile: 'qa' })).toBe('tmpfs');
  expect(ordinary.REZICS_FUSEKI_MEMORY_LIMIT).toBe('2g');
  expect(ordinary.REZICS_FUSEKI_JVM_ARGS).toContain('-Xmx512m');
  expect(stackStorage({ profile: 'qa', persistent: qaStackMode(scale) === 'scale' })).toBe('persistent');
  expect(scale.REZICS_FUSEKI_MEMORY_LIMIT).toBe('7g');
  expect(scale.REZICS_FUSEKI_JVM_ARGS).toContain('-Xmx1536m');
  expect(scale.REZICS_FUSEKI_JVM_ARGS).toContain('MaxDirectMemorySize=512m');
  expect(() => qaStackMode({ REZICS_QA_STACK_MODE: 'scsale' })).toThrow();
  expect(scaleIntegrationFiles.has('tests/qa/integration/g-1031-catalogue-write.test.ts')).toBe(true);
  expect(scaleIntegrationFiles.has('tests/qa/integration/g-1032-catalogue-preparation.test.ts')).toBe(true);
});

test('G1031: scale recipes never change an ordinary integration shard to disk storage', () => {
  const scale = 'tests/qa/integration/g-1031-catalogue-write.test.ts';
  const ordinary = 'tests/qa/integration/media-upload.test.ts';
  const shards = planIntegrationShards(new Map([[scale, 300000], [ordinary, 1000]]), 1);
  expect(shards).toHaveLength(2);
  expect(shards.map(shard => shard.files)).toEqual([[ordinary], [scale]]);
});

test('G1031: scale preparation charges startup against the complete 600-second ceiling', () => {
  expect(scalePreparationBudgetMs(1_000_000, 1_010_000)).toBe(400_000);
  expect(scalePreparationBudgetMs(1_000_000, 1_430_000)).toBe(110_000);
  expect(() => scalePreparationBudgetMs(1_000_000, 1_540_000)).toThrow('startup exhausted');
  expect(() => scalePreparationBudgetMs(1_000_001, 1_000_000)).toThrow('Invalid');
  expect(() => scalePreparationBudgetMs(NaN)).toThrow('Invalid');
});

test('G1031: Compose persists the selected QA allocation and refuses storage reuse under a different mode', () => {
  const root = mkdtempSync(resolve('.temp/g-1031-stack-'));
  const previous = { memory: process.env.REZICS_FUSEKI_MEMORY_LIMIT, jvm: process.env.REZICS_FUSEKI_JVM_ARGS };
  try {
    const env = qaStackEnvironment({ REZICS_QA_STACK_MODE: 'scale',
      REZICS_QA_FUSEKI_MEMORY_LIMIT: '5g', REZICS_QA_FUSEKI_JVM_ARGS: '-Xmx1g' });
    Object.assign(process.env, { REZICS_FUSEKI_MEMORY_LIMIT: env.REZICS_FUSEKI_MEMORY_LIMIT,
      REZICS_FUSEKI_JVM_ARGS: env.REZICS_FUSEKI_JVM_ARGS });
    const options: StackOptions = { profile: 'qa', runId: 'g-1031-unit', persistent: true };
    const saved = ensureSecrets(root, options);
    expect(saved.REZICS_FUSEKI_MEMORY_LIMIT).toBe('5g');
    expect(saved.REZICS_FUSEKI_JVM_ARGS).toBe('-Xmx1g');
    // Parent QA settings must not replace the stack's own saved settings.
    expect(composeProcessEnvironment(qaStackEnvironment({}), saved).REZICS_FUSEKI_MEMORY_LIMIT).toBe('5g');
    expect(() => ensureSecrets(root, { ...options, persistent: false })).toThrow('storage mode differs');
  } finally {
    for (const [name, value] of [['REZICS_FUSEKI_MEMORY_LIMIT', previous.memory],
      ['REZICS_FUSEKI_JVM_ARGS', previous.jvm]]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
