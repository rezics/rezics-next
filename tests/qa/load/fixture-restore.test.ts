import { expect, test } from 'bun:test';
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
