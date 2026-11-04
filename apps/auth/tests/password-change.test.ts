import { expect, test } from 'bun:test';
import { classifyPasswordChangeReply, createPasswordChangeAttempt } from '../src/password-change-attempt';
import { PasswordChangeReturnController } from '../src/password-change-return';

test.each(['stage', 'approve', 'apply'] as const)('return history stores only an unknown %s phase', (phase) => {
  const history = new PasswordChangeReturnController();
  expect(history.capture({ status: 'sending', attempt: { phase, uncertain: false } })).toBe(true);
  expect(history.snapshot()).toEqual({ unknownPhase: phase, applicationConfirmed: false });
});

test('known unsent work is discarded, while later application acknowledgement keeps earlier uncertainty', () => {
  const history = new PasswordChangeReturnController();
  expect(history.capture({ status: 'paused', attempt: { phase: 'approve', uncertain: false } })).toBe(false);
  expect(history.snapshot()).toBeNull();
  history.capture({ status: 'unknown', attempt: { phase: 'apply', uncertain: true } });
  history.confirmApplication();
  expect(history.snapshot()).toEqual({ unknownPhase: 'apply', applicationConfirmed: true });
});

test('only a first native not-applied refusal is definitive', () => {
  const attempt = createPasswordChangeAttempt('account-secret', 'password-secret', 'old-key');
  const refusal = { ok: false as const, status: 409, code: 'credential_effect_denied', effectStatus: 'not_applied' as const };
  expect(classifyPasswordChangeReply(attempt, refusal).kind).toBe('refused');
  expect(classifyPasswordChangeReply({ ...attempt, uncertain: true }, refusal).kind).toBe('unknown');
});
