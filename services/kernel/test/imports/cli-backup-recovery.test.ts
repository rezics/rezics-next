import { expect, test } from 'bun:test';
import { runCliBackupRecoveryJourney } from './cli-backup-recovery-fixture.ts';

test('Stopped importer backup restores exact pending native requests to ordinary resume', async () => {
  const r = await runCliBackupRecoveryJourney();
  try {
    expect([1, 130]).toContain(r.interrupted.code);
    expect(r.backup.code).toBe(0);
    expect(r.validated.code).toBe(0);
    expect(r.restore.code).toBe(0);
    expect(r.restore.openHandles).toBe(0);
    expect(r.resumed.code).toBe(0);
    expect(r.replayedBytes).toEqual([r.pendingBytes]);
    expect(r.replayedKeys).toEqual(r.pendingKeys);
    expect(r.subjectId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(r.selectedCandidate).toMatch(/^[0-9a-f-]{36}$/i);
    expect(r.vanished.code).toBe(3);
  } finally {
    await r.close();
  }
}, 1_800_000);
