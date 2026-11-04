import { expect, test } from 'bun:test';
import {
  classifyPasswordChangeReply,
  createPasswordChangeAttempt,
  passwordChangeRequest,
  passwordLengthValid,
} from '../src/password-change-attempt';

const stageReply = (attempt: ReturnType<typeof createPasswordChangeAttempt>) => ({
  effectRef: 'effect-ref',
  key: attempt.key,
  subjectId: attempt.subjectId,
  purpose: 'set-password',
  digest: 'a'.repeat(64),
});

test('password constraints count Unicode characters and respect Auth storage bounds', () => {
  const limits = { minLength: 8, maxLength: 128 };
  expect(passwordLengthValid('密码字符密码字符', limits)).toBe(true);
  expect(passwordLengthValid('short', limits)).toBe(false);
  expect(passwordLengthValid('😀'.repeat(65), limits)).toBe(false);
  expect(passwordLengthValid('x'.repeat(129), limits)).toBe(false);
  expect(passwordLengthValid('123456789', { minLength: 10, maxLength: 96 })).toBe(false);
  expect(passwordLengthValid('1234567890', { minLength: 10, maxLength: 96 })).toBe(true);
});

test('every explicit phase retry retains the original exact key and phase payload', () => {
  const staged = createPasswordChangeAttempt('account', 'a private password', 'original-key');
  expect(passwordChangeRequest(staged)).toEqual({
    path: '/credential-effects/stage',
    body: {
      key: 'original-key',
      subjectId: 'account',
      credential: { kind: 'password', password: 'a private password' },
    },
  });
  const uncertainStage = classifyPasswordChangeReply(staged, { ok: false, status: 503, code: 'unavailable' });
  expect(uncertainStage.kind).toBe('unknown');
  if (uncertainStage.kind !== 'unknown') throw new Error('expected unknown stage');
  expect(passwordChangeRequest(uncertainStage.attempt)).toEqual(passwordChangeRequest(staged));

  const approved = classifyPasswordChangeReply(uncertainStage.attempt, { ok: true, body: stageReply(staged) });
  expect(approved.kind).toBe('next');
  if (approved.kind !== 'next') throw new Error('expected stage binding');
  expect(approved.attempt.stagePayload).toBeNull();
  const approvalRequest = passwordChangeRequest(approved.attempt);
  expect(approvalRequest.body).toEqual({
    key: 'original-key',
    subjectId: 'account',
    effectRef: 'effect-ref',
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  });
  const uncertainApproval = classifyPasswordChangeReply(approved.attempt, { ok: false, status: 503, code: 'timeout' });
  expect(uncertainApproval.kind).toBe('unknown');
  if (uncertainApproval.kind !== 'unknown') throw new Error('expected unknown approval');
  expect(passwordChangeRequest(uncertainApproval.attempt)).toEqual(approvalRequest);

  const applying = classifyPasswordChangeReply(uncertainApproval.attempt, {
    ok: true,
    body: { reference: 'approval-ref', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  expect(applying.kind).toBe('next');
  if (applying.kind !== 'next') throw new Error('expected approval');
  expect(passwordChangeRequest(applying.attempt).body).toEqual({
    ...approvalRequest.body,
    reference: 'approval-ref',
  });
});

test('malformed replies stay uncertain and later refusal cannot settle an unknown apply', () => {
  const attempt = createPasswordChangeAttempt('account', 'a private password', 'original-key');
  const stage = classifyPasswordChangeReply(attempt, { ok: true, body: { ...stageReply(attempt), digest: 'digest' } });
  expect(stage.kind).toBe('unknown');
  const unknownApply = {
    ...attempt,
    phase: 'apply' as const,
    stagePayload: null,
    binding: { effectRef: 'effect-ref', purpose: 'set-password' as const, digest: 'a'.repeat(64) },
    approval: { reference: 'approval-ref', expiresAt: new Date(Date.now() - 1000).toISOString() },
    uncertain: true,
  };
  expect(
    classifyPasswordChangeReply(unknownApply, {
      ok: false,
      status: 401,
      code: 'credential_effect_denied',
      effectStatus: 'not_applied',
    }).kind,
  ).toBe('unknown');
  expect(classifyPasswordChangeReply(unknownApply, { ok: true, body: { receiptId: '', replayed: true } }).kind).toBe(
    'unknown',
  );
});

test('only the explicit native not-applied marker settles a first refusal', () => {
  const attempt = createPasswordChangeAttempt('account', 'a private password', 'original-key');
  expect(classifyPasswordChangeReply(attempt, { ok: false, status: 409, code: 'credential_effect_denied' }).kind).toBe(
    'unknown',
  );
  expect(
    classifyPasswordChangeReply(attempt, {
      ok: false,
      status: 409,
      code: 'credential_effect_denied',
      effectStatus: 'not_applied',
    }).kind,
  ).toBe('refused');
});
