import { expect, test } from 'bun:test';
import { LoginAttempt } from '../src/login-attempt';

test('an explicit prompt owns all methods and reads until retirement, including same-turn events', () => {
  const attempt = new LoginAttempt();
  const prompt = attempt.begin('passkey')!;
  for (const phase of ['options', 'prompt', 'dispatched'] as const) {
    prompt.observe(phase);
    expect(attempt.begin('password')).toBeNull();
    expect(attempt.begin('passkey')).toBeNull();
    expect(attempt.beginPageRead()).toBeNull();
    expect(attempt.choose()).toBe(false);
  }
  prompt.observe('cancelled');
  expect(prompt.finish()).toBe(true);
  expect(attempt.begin('password')).not.toBeNull();
});

test('conditional mediation is replaceable only before authentication dispatch, and late observations are inert', () => {
  const attempt = new LoginAttempt();
  const autofill = attempt.begin('autofill')!;
  autofill.observe('prompt');
  const password = attempt.begin('password')!;
  expect(autofill.isCurrent()).toBe(false);
  autofill.observe('acknowledged');
  expect(attempt.snapshot()).toEqual({ method: 'password', phase: 'dispatched' });
  password.finish();
  const next = attempt.begin('autofill')!;
  next.observe('dispatched');
  expect(attempt.begin('password')).toBeNull();
  attempt.retire();
  next.observe('acknowledged');
  expect(next.finish()).toBe(false);
  expect(attempt.snapshot()).toEqual({ method: 'autofill', phase: 'dispatched' });
});
