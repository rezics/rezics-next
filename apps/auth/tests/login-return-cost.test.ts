import { expect, spyOn, test } from 'bun:test';
import { signIn } from '../src/sign-in';
import { retainLoginHistory, type LoginReturnHistory } from '../src/login-return';

test('password phase observation adds no Auth calls and bounded history cannot become a command', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
  const phases: string[] = [];
  try {
    expect(await signIn('private@example.test', 'private-password', (phase) => phases.push(phase))).toEqual({
      ok: true,
    });
    expect(phases).toEqual(['dispatched', 'acknowledged']);
    let history: LoginReturnHistory = [{ method: 'password', phase: 'unknown' }];
    for (let i = 0; i < 1000; i++) history = retainLoginHistory(history, { method: 'passkey', phase: 'refused' });
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ method: 'password', phase: 'unknown' });
    expect(JSON.stringify(history)).not.toContain('private');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
