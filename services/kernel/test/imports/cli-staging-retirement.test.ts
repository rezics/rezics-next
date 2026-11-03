import { expect, test } from 'bun:test';
import { runCliStagingRetirementJourney } from './cli-staging-retirement.ts';

test('operator retires one unpublished staging capture and later imports through ordinary authority', async () => {
  const r = await runCliStagingRetirementJourney();
  try {
    expect(r.reviewed.code).toBe(0);
    expect(r.applied.code).toBe(0);
    expect(JSON.parse(r.applied.stdout).status).toBe('complete');
    expect(JSON.parse(r.inspect.stdout).generation.status).toBe('retired');
    expect(r.resumeOld.code).toBe(2);
    expect(r.corrected.code).toBe(0);
    expect(r.network).toBe(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
