import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { softwareFacts, SOFTWARE_FACTS_COST, type SoftwareFacts } from '../src/modules/software-facts/contract.ts';
import { RevisionedFactsStore } from '../src/modules/game-facts/store.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const observedAt = '2026-09-28T00:00:00.000Z';
const sample = { profile: 'software-facts-v1', pitch: 'An app.', project: 'https://example.org/download',
  source: 'https://example.org/source', maintainer: 'Example contributors', license: null,
  observedAt, screenshots: [], releases: [{ platform: 'Linux', architecture: null,
    version: null, changes: null, destination: 'https://example.org/download',
    source: 'https://example.org/download', observedAt }],
  alternatives: [{ work, reason: 'Another way to do this task.', attributedTo: work }] } as const;

test('an app handoff keeps untracked version and architecture unknown and attributes alternatives', () => {
  expect(Value.Check(softwareFacts, sample)).toBe(true);
  expect(Value.Check(softwareFacts, { ...sample, alternatives: [{ work, reason: 'Another way.' }] })).toBe(false);
  expect(Value.Check(softwareFacts, { ...sample, releases: Array(SOFTWARE_FACTS_COST.releaseItems + 1)
    .fill(sample.releases[0]) })).toBe(false);
  expect(Value.Check(softwareFacts, { ...sample, releases: [{ ...sample.releases[0], destination: '/install' }] }))
    .toBe(false);
});

test('software facts read one indexed record, independent of release count', async () => {
  const statements: string[] = [];
  const pool = { query: async (sql: string) => {
    statements.push(sql); return { rows: [{ work, revision: 1, facts: sample }] };
  } } as unknown as Pool;
  const store = new RevisionedFactsStore<SoftwareFacts>(pool, 'software');
  expect((await store.read(work))?.facts.releases[0]?.version).toBeNull();
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('access.software_facts');
});
