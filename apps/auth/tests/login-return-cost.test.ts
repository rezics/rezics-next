import { expect, spyOn, test } from 'bun:test';
import { signIn } from '../src/sign-in';
import { retainLoginHistory, type LoginReturnHistory } from '../src/login-return';
import { nativeSignInProof } from './sign-in-fixture';

test('password phase observation adds no Auth calls and bounded history cannot become a command', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
    Promise.resolve(Response.json(nativeSignInProof(JSON.parse(String(init?.body))))),
  );
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

test('native suspension records a known refusal in the original password attempt', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }, { status: 403 }),
  );
  const phases: string[] = [];
  try {
    expect(await signIn('private@example.test', 'private-password', (phase) => phases.push(phase))).toEqual({
      ok: false,
      reason: 'suspended',
    });
    expect(phases).toEqual(['dispatched', 'refused']);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }
});
