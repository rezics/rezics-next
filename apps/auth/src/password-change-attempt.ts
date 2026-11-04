export type PasswordChangeLimits = { minLength: number; maxLength: number };

export type PasswordChangePhase = 'stage' | 'approve' | 'apply';
export type PasswordStagePayload = {
  key: string;
  subjectId: string;
  credential: { kind: 'password'; password: string };
};
export type PasswordStageBinding = {
  effectRef: string;
  purpose: 'set-password';
  digest: string;
};
export type PasswordApproval = { reference: string; expiresAt: string };
export type PasswordChangeAttempt = {
  key: string;
  subjectId: string;
  phase: PasswordChangePhase;
  stagePayload: PasswordStagePayload | null;
  binding: PasswordStageBinding | null;
  approval: PasswordApproval | null;
  uncertain: boolean;
};

export type PasswordChangeReply =
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: string; effectStatus?: 'not_applied' };

export type PasswordChangeReplyResult =
  | { kind: 'next'; attempt: PasswordChangeAttempt }
  | { kind: 'complete'; receiptId: string; replayed: boolean }
  | { kind: 'refused'; phase: PasswordChangePhase; status: number; code: string }
  | { kind: 'unknown'; attempt: PasswordChangeAttempt }
  | { kind: 'cancelled'; attempt: PasswordChangeAttempt };

export function passwordLengthValid(value: string, limits: PasswordChangeLimits): boolean {
  const length = Array.from(value).length;
  // Auth enforces its configured maximum in UTF-16 code units. Keep the local
  // user-facing count Unicode-aware while preventing a value Auth must reject.
  return length >= limits.minLength && length <= limits.maxLength && value.length <= limits.maxLength;
}

export function createPasswordChangeAttempt(
  subjectId: string,
  password: string,
  key = crypto.randomUUID(),
): PasswordChangeAttempt {
  return {
    key,
    subjectId,
    phase: 'stage',
    stagePayload: { key, subjectId, credential: { kind: 'password', password } },
    binding: null,
    approval: null,
    uncertain: false,
  };
}

export function passwordChangeRequest(attempt: PasswordChangeAttempt): {
  path: string;
  body: Record<string, unknown>;
} {
  const exact = { key: attempt.key, subjectId: attempt.subjectId };
  if (attempt.phase === 'stage') {
    if (!attempt.stagePayload) throw new Error('Missing password stage payload');
    return { path: '/credential-effects/stage', body: attempt.stagePayload };
  }
  if (!attempt.binding) throw new Error('Missing password stage binding');
  const binding = {
    ...exact,
    effectRef: attempt.binding.effectRef,
    purpose: attempt.binding.purpose,
    digest: attempt.binding.digest,
  };
  if (attempt.phase === 'approve') return { path: '/credential-effects/approve', body: binding };
  if (!attempt.approval) throw new Error('Missing password approval');
  return { path: '/credential-effects/apply', body: { ...binding, reference: attempt.approval.reference } };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function unknown(attempt: PasswordChangeAttempt): PasswordChangeReplyResult {
  return { kind: 'unknown', attempt: { ...attempt, uncertain: true } };
}

export function classifyPasswordChangeReply(
  attempt: PasswordChangeAttempt,
  reply: PasswordChangeReply,
  now = Date.now(),
): PasswordChangeReplyResult {
  if (!reply.ok) {
    const refusal =
      reply.effectStatus === 'not_applied' &&
      ((reply.code === 'credential_effect_denied' && [400, 401, 403, 409, 413, 415, 503].includes(reply.status)) ||
        (reply.code === 'step_up_required' && reply.status === 401));
    if (refusal && !attempt.uncertain)
      return { kind: 'refused', phase: attempt.phase, status: reply.status, code: reply.code };
    return unknown(attempt);
  }

  if (!record(reply.body)) return unknown(attempt);
  if (attempt.phase === 'stage') {
    if (
      !exactKeys(reply.body, ['effectRef', 'key', 'subjectId', 'purpose', 'digest']) ||
      typeof reply.body.effectRef !== 'string' ||
      !reply.body.effectRef ||
      reply.body.key !== attempt.key ||
      reply.body.subjectId !== attempt.subjectId ||
      reply.body.purpose !== 'set-password' ||
      typeof reply.body.digest !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(reply.body.digest)
    )
      return unknown(attempt);
    return {
      kind: 'next',
      attempt: {
        ...attempt,
        phase: 'approve',
        stagePayload: null,
        binding: {
          effectRef: reply.body.effectRef,
          purpose: 'set-password',
          digest: reply.body.digest,
        },
        uncertain: false,
      },
    };
  }
  if (attempt.phase === 'approve') {
    const expiresAt = record(reply.body) && typeof reply.body.expiresAt === 'string' ? reply.body.expiresAt : '';
    const expiry = Date.parse(expiresAt);
    if (
      !exactKeys(reply.body, ['reference', 'expiresAt']) ||
      typeof reply.body.reference !== 'string' ||
      !reply.body.reference ||
      !Number.isFinite(expiry) ||
      expiry <= now
    )
      return unknown(attempt);
    return {
      kind: 'next',
      attempt: {
        ...attempt,
        phase: 'apply',
        approval: { reference: reply.body.reference, expiresAt },
        uncertain: false,
      },
    };
  }
  if (
    !exactKeys(reply.body, ['receiptId', 'replayed']) ||
    typeof reply.body.receiptId !== 'string' ||
    !reply.body.receiptId ||
    typeof reply.body.replayed !== 'boolean'
  )
    return unknown(attempt);
  return { kind: 'complete', receiptId: reply.body.receiptId, replayed: reply.body.replayed };
}
