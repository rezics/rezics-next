import { expect, test } from 'bun:test';
import { runCliBindingInspectionJourney } from './cli-binding-inspection.ts';

test('operator inspects one exact binding locally then resumes the original uncertain request', async () => {
  const r = await runCliBindingInspectionJourney();
  try {
    expect(r.inspectBound.code).toBe(0);
    expect(r.inspectBound.openHandles).toBe(0);
    expect(r.inspectPending.code).toBe(0);
    expect(r.inspectPending.openHandles).toBe(0);
    expect(r.resumed.code).toBe(0);
    expect(r.acknowledgedSubject).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.resumedSubject).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.resumedSubject).not.toBe(r.acknowledgedSubject);
  } finally {
    await r.close();
  }
}, 1_800_000);
