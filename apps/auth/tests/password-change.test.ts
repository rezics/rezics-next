import { expect, test } from 'bun:test';
import {
  credentialEffectNotAppliedStatuses,
  credentialEffectResponseByteBudgets,
  credentialEffectResponseLimits,
} from '@rezics/auth-contract';
import { dispatchPasswordChangePhase } from '../src/security';
import {
  classifyPasswordChangeReply,
  createPasswordChangeAttempt,
  type PasswordChangeAttempt,
  type PasswordChangePhase,
} from '../src/password-change-attempt';
import { PasswordChangeReturnController } from '../src/password-change-return';

const effectRef = '00000000-0000-4000-8000-000000000001';
const approvalReference = `${'A'.repeat(48)}.${'A'.repeat(43)}`;

function attemptAt(phase: PasswordChangePhase): PasswordChangeAttempt {
  const staged = createPasswordChangeAttempt('00000000-0000-7000-8000-000000000001', 'password secret', effectRef);
  if (phase === 'stage') return staged;
  const approval = classifyPasswordChangeReply(staged, {
    ok: true,
    body: {
      effectRef,
      key: staged.key,
      subjectId: staged.subjectId,
      purpose: 'set-password',
      digest: 'a'.repeat(64),
    },
  });
  if (approval.kind !== 'next') throw new Error('expected an admitted stage');
  if (phase === 'approve') return approval.attempt;
  const applying = classifyPasswordChangeReply(approval.attempt, {
    ok: true,
    body: { reference: approvalReference, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  if (applying.kind !== 'next') throw new Error('expected an admitted approval');
  return applying.attempt;
}

async function withFetch(fetcher: typeof fetch, work: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

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
  const refusal = {
    ok: false as const,
    status: 409,
    code: 'credential_effect_denied',
    effectStatus: 'not_applied' as const,
  };
  expect(classifyPasswordChangeReply(attempt, refusal).kind).toBe('refused');
  expect(classifyPasswordChangeReply({ ...attempt, uncertain: true }, refusal).kind).toBe('unknown');
});

test('the admitted maximum stage DTO survives bounded byte receiving', async () => {
  const escaped = '\u0001'.repeat(credentialEffectResponseLimits.textUnits);
  const attempt = createPasswordChangeAttempt(escaped, 'password secret', escaped);
  const body = JSON.stringify({
    effectRef,
    key: attempt.key,
    subjectId: attempt.subjectId,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  });
  expect(new TextEncoder().encode(body).byteLength).toBe(credentialEffectResponseByteBudgets.stage.success);
  await withFetch(
    (async (input, init) => {
      expect(input).toBe('/credential-effects/stage');
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': '1' },
      });
    }) as typeof fetch,
    async () => {
      const result = await dispatchPasswordChangePhase(attempt);
      expect(result.kind).toBe('next');
      if (result.kind === 'next') expect(result.attempt.phase).toBe('approve');
    },
  );
});

test('the maximum password approval and replay receipt fit their phase budgets', async () => {
  const reference = `${'A'.repeat(credentialEffectResponseLimits.passwordApprovalReferenceUnits - 44)}.${'A'.repeat(43)}`;
  const approvalBody = JSON.stringify({ reference, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expect(new TextEncoder().encode(approvalBody).byteLength).toBe(credentialEffectResponseByteBudgets.approve.success);
  let applying: PasswordChangeAttempt | undefined;
  await withFetch((async () => new Response(approvalBody, { status: 200 })) as typeof fetch, async () => {
    const result = await dispatchPasswordChangePhase(attemptAt('approve'));
    expect(result.kind).toBe('next');
    if (result.kind === 'next') applying = result.attempt;
  });
  if (!applying) throw new Error('expected admitted approval');

  const receiptBody = JSON.stringify({ receiptId: effectRef, replayed: false });
  expect(new TextEncoder().encode(receiptBody).byteLength).toBe(credentialEffectResponseByteBudgets.apply.success);
  await withFetch((async () => new Response(receiptBody, { status: 200 })) as typeof fetch, async () =>
    expect((await dispatchPasswordChangePhase(applying!)).kind).toBe('complete'),
  );
});

test.each([
  ['stage', undefined],
  ['stage', '1'],
  ['approve', undefined],
  ['approve', '1'],
  ['apply', undefined],
  ['apply', '1'],
] as const)('actual streamed %s overflow is unknown with Content-Length %s', async (phase, length) => {
  const attempt = attemptAt(phase);
  const bytes = new Uint8Array(credentialEffectResponseByteBudgets[phase].success + 1).fill(0x20);
  const headers = length === undefined ? {} : { 'Content-Length': length };
  await withFetch((async () => new Response(bytes, { status: 200, headers })) as typeof fetch, async () => {
    expect(await dispatchPasswordChangePhase(attempt)).toMatchObject({
      kind: 'unknown',
      attempt: { phase, uncertain: true },
    });
  });
});

test('split UTF-8 and a lying short length still admit the exact stage binding', async () => {
  const attempt = createPasswordChangeAttempt('person😀', 'password secret', 'original-key');
  const body = JSON.stringify({
    effectRef,
    key: attempt.key,
    subjectId: attempt.subjectId,
    purpose: 'set-password',
    digest: 'a'.repeat(64),
  });
  const bytes = new TextEncoder().encode(body);
  await withFetch(
    (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Length': '1' } },
      )) as typeof fetch,
    async () => {
      expect(await dispatchPasswordChangePhase(attempt)).toMatchObject({ kind: 'next', attempt: { phase: 'approve' } });
    },
  );
});

test.each(['stage', 'approve', 'apply'] as const)(
  'retirement settles an abort-ignoring %s body as unknown',
  async (phase) => {
    const attempt = attemptAt(phase);
    const caller = new AbortController();
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {});
            },
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      async () => {
        const pending = dispatchPasswordChangePhase(attempt, caller.signal);
        await Promise.resolve();
        await Promise.resolve();
        caller.abort();
        expect(await pending).toMatchObject({ kind: 'unknown', attempt: { phase, uncertain: true } });
        expect(calls).toBe(1);
      },
    );
  },
);

test('each phase has one five-second lifetime through an abort-ignoring body', async () => {
  const attempt = attemptAt('approve');
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let expire!: () => void;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    expect(delay).toBe(5000);
    expire = callback as () => void;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            return new Promise<void>(() => {});
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const pending = dispatchPasswordChangePhase(attempt);
    await Promise.resolve();
    await Promise.resolve();
    expire();
    expect(await pending).toMatchObject({ kind: 'unknown', attempt: { phase: 'approve', uncertain: true } });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

test('only the exact admitted refusal DTO and status can settle a phase', async () => {
  for (const phase of ['stage', 'approve', 'apply'] as const) {
    const attempt = attemptAt(phase);
    const refusal = { error: 'credential_effect_denied', effect_status: 'not_applied' };
    await withFetch(
      (async () => Response.json({ ...refusal, extra: true }, { status: 409 })) as typeof fetch,
      async () => expect((await dispatchPasswordChangePhase(attempt)).kind).toBe('unknown'),
    );
    await withFetch((async () => Response.json(refusal, { status: 500 })) as typeof fetch, async () =>
      expect((await dispatchPasswordChangePhase(attempt)).kind).toBe('unknown'),
    );
    for (const status of credentialEffectNotAppliedStatuses)
      await withFetch((async () => Response.json(refusal, { status })) as typeof fetch, async () =>
        expect((await dispatchPasswordChangePhase(attempt)).kind).toBe('refused'),
      );
    await withFetch(
      (async () =>
        Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401 })) as typeof fetch,
      async () => expect((await dispatchPasswordChangePhase(attempt)).kind).toBe('refused'),
    );
  }
  expect(credentialEffectNotAppliedStatuses).toEqual([400, 401, 403, 409, 413, 415, 503]);
  await withFetch(
    (async () =>
      new Response('{"error":"credential_effect_denied","effect_status":"applied","effect_status":"not_applied"}', {
        status: 409,
      })) as typeof fetch,
    async () => expect((await dispatchPasswordChangePhase(attemptAt('stage'))).kind).toBe('unknown'),
  );
});

test.each(['stage', 'approve', 'apply'] as const)('invalid %s success never advances its phase', async (phase) => {
  const attempt = attemptAt(phase);
  const body =
    phase === 'stage'
      ? {
          effectRef,
          key: `${attempt.key}-different`,
          subjectId: attempt.subjectId,
          purpose: 'set-password',
          digest: 'a'.repeat(64),
        }
      : phase === 'approve'
        ? { reference: 'approval-ref', expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { receiptId: 'not-a-native-receipt', replayed: true };
  await withFetch((async () => Response.json(body, { status: 200 })) as typeof fetch, async () => {
    expect(await dispatchPasswordChangePhase(attempt)).toMatchObject({
      kind: 'unknown',
      attempt: { phase, uncertain: true },
    });
  });
});
