import { expect, test } from 'bun:test';
import { runCliRunRetentionJourney } from './cli-run-retention-fixture.ts';

test('operator retires a superseded complete capture and resumes the recoverable native generation', async () => {
  const r = await runCliRunRetentionJourney();
  try {
    expect(r.listed.code).toBe(0);
    expect(r.applied.code).toBe(0);
    expect(JSON.parse(r.applied.stdout).status).toBe('complete');
    expect(JSON.parse(r.inspect.stdout).generation.status).toBe('retired');
    expect(JSON.parse(r.diagnostics.stdout).coverage).toBe('unavailable');
    expect([1, 130]).toContain(r.interrupted.code);
    expect(r.resumed.code).toBe(0);
    expect(r.network).toBe(0);
    expect(r.subjectId).toMatch(/^[0-9a-f-]{36}$/i);
  } finally {
    await r.close();
  }
}, 1_800_000);
