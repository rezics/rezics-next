import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';

/** G336 design experiment: one page may pin authority inputs, but the retained
 * authority view cannot be its own final revocation check. Use real Access rows
 * and the real activePrincipalId boundary for that counterexample. */
test('G336 repeatable authority reads survive a concurrent revoke; only a fresh final check observes it', async () => {
  const stack = await startMediaStack('read-snapshot-access');
  const snapshot = await stack.accessPool.connect();
  try {
    const member = await stack.member('reader');
    await stack.accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [member.actor]);
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await snapshot.query("SET LOCAL statement_timeout = '5s'");
    await snapshot.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const active = async () => (await snapshot.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [member.principalId])).rows[0]!.active;
    const subject = async () => (await snapshot.query<{ active: boolean }>(
      'SELECT active FROM access.authority_subject WHERE id = $1', [member.actor])).rows[0]!.active;
    expect(await active()).toBe(true);
    // Both committed states deny principal AND subject. Reading them in separate
    // snapshots could combine the old active principal with the new active actor.
    const writer = await stack.accessPool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE access.principal SET active = false WHERE id = $1', [member.principalId]);
      await writer.query('UPDATE access.authority_subject SET active = true WHERE id = $1', [member.actor]);
      await writer.query('COMMIT');
    } finally { await writer.query('ROLLBACK'); writer.release(); }
    expect(await active()).toBe(true);
    expect(await subject()).toBe(false);
    await snapshot.query('ROLLBACK');
    expect(await stack.access.activePrincipalId(member.principal)).toBeNull();
    expect((await stack.accessPool.query<{ active: boolean }>(
      'SELECT active FROM access.authority_subject WHERE id = $1', [member.actor])).rows[0]!.active).toBe(true);
  } finally {
    await snapshot.query('ROLLBACK');
    snapshot.release();
    await stack.stop();
  }
}, 60_000);
