import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { composeProcessEnvironment, readEnv } from '../../../scripts/dev/config.ts';
import { qaMemoryNeed, type QaMemoryService } from '../../../scripts/qa/memory-admission.ts';
import { dockerEnvironment } from '../../../scripts/fixture/stack.ts';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { phaseDFixture } from './fixture-phase-d.ts';

const root = resolve(import.meta.dir, '../../..');

test('fixture: restored medium copy retained owner samples and graph readiness', () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated load tier');
  const fixture = phaseDFixture('SEARCH18');
  const record = JSON.parse(readFileSync(join(root, '.artifacts', 'fixture-restore',
    fixture.runId, 'run.json'), 'utf8')) as {
    samples?: number; ready?: string[]; graph?: { sequence: string; generation: string };
    phases?: Record<string, number>;
  };
  expect(record.samples).toBe(fixture.manifest.samples.length);
  expect(record.ready).toEqual(['account', 'access', 'content', 'relay', 'fuseki', 'lucene', 'rustfs']);
  expect(record.graph?.sequence).toBe(fixture.manifest.importSequence);
  expect(record.graph?.generation).toBe(fixture.manifest.build.textIndexGeneration);
  expect(record.phases?.copy).toBeGreaterThan(0);
  expect(record.phases?.smoke).toBeGreaterThan(0);
});


test('fixture: every restored container enforces the cap charged by startup admission', () => {
  const { runId } = phaseDFixture('SEARCH18');
  const env = composeProcessEnvironment(dockerEnvironment(), readEnv(join(root, '.temp', 'stack',
    `rezics-qa-${runId}`, 'compose.env')));
  const ids = execFileSync('docker', ['ps', '-q', '--filter',
    `label=com.docker.compose.project=rezics-qa-${runId}`], { env, encoding: 'utf8' }).trim().split(/\s+/);
  const containers = JSON.parse(execFileSync('docker', ['inspect', ...ids], { env, encoding: 'utf8' })) as
    { Config: { Labels: Record<string, string> }; HostConfig: { Memory: number } }[];
  const services: QaMemoryService[] = ['postgres', 'fuseki', 'rustfs', 'toxiproxy', 'mailpit'];
  expect(containers).toHaveLength(services.length);
  for (const service of services) {
    const container = containers.find(item => item.Config.Labels['com.docker.compose.service'] === service);
    expect(container?.HostConfig.Memory).toBe(qaMemoryNeed(root, 'other', 'catalogue-disk', env, [service]).vm);
  }
});
