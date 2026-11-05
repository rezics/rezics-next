import { expect, test } from 'bun:test';
import { runBangumiStagingJourney } from './bangumi-staging-fixture.ts';

test('checkpointed Bangumi staging resumes the same generation and finishes ordinary native catalogue readback', async () => {
  const r = await runBangumiStagingJourney();
  try {
    expect(r.interrupted.code).toBe(130);
    expect(r.interrupted.stderr).toContain('--resume-staging');
    expect(r.interrupted.stderr).toContain('generation');
    expect(r.prefixConversions).toBeGreaterThan(0);
    expect(r.resumeConversions).toBeLessThan(r.totalRecords);
    expect(r.preSealNative).toBe(0);
    expect(r.resumed.code).toBe(0);
    expect(r.subjects).toHaveLength(5);
    expect(r.subjects.every((subject) => subject.sourceRecords)).toBe(true);
    expect(r.bodies.join('\n')).not.toContain('"score"');
    expect(r.bodies.join('\n')).not.toContain('score_details');
    expect(r.reopen.code).toBe(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
