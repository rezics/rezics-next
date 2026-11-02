import { expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  readVerification,
  requestVerification,
  withdrawVerification,
  readVerificationTitle,
  readVerificationEligibility,
  type AgentVerificationRequest,
  type VerificationInput,
} from '../../src/settings/verification-core';
import { VerificationRecovery } from '../../src/settings/verification-recovery';
import { withVerificationDeadline } from '../../src/settings/verification-request-deadline';

const input: VerificationInput = {
  subject: 'subject-1',
  statement: 'Original statement',
  links: [],
  idempotencyKey: crypto.randomUUID(),
};
const request: AgentVerificationRequest = {
  id: 'request-1',
  accountId: 'alice',
  accountKind: 'actor',
  requestedBy: 'alice',
  catalogueSubjectId: input.subject,
  statement: input.statement,
  links: [],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const never = <T>(): Promise<T> => new Promise(() => {});
async function fast(run: () => Promise<void>) {
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    schedule(callback, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
  try {
    await run();
  } finally {
    timer.mockRestore();
  }
}

test('native review, commands, eligibility and optional titles bound stalled headers and bodies', () =>
  fast(async () => {
    for (const phase of ['headers', 'body']) {
      const calls: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (url, init) => {
          calls.push(new Request(url, init));
          return phase === 'headers'
            ? never<Response>()
            : new Response(new ReadableStream(), {
                headers: { 'content-type': 'application/json' },
              });
        }) as typeof fetch,
      });
      await expect(readVerification(client, 'alice', 'Bearer current')).rejects.toThrow('timed out');
      await expect(requestVerification(client, 'alice', 'Bearer current', input)).rejects.toThrow('timed out');
      await expect(withdrawVerification(client, 'alice', 'Bearer current', input.idempotencyKey)).rejects.toThrow(
        'timed out',
      );
      await expect(readVerificationEligibility(client, 'Bearer current')).rejects.toThrow('timed out');
      expect(await readVerificationTitle(client, input.subject, 'Bearer current', ['en'])).toBeNull();
      expect(calls).toHaveLength(5);
      expect(calls.every((call) => call.signal.aborted && call.headers.get('authorization') === 'Bearer current')).toBe(
        true,
      );
      expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[2]!.headers.get('idempotency-key'));
    }
  }));

test('stalled released eligibility retries a fresh read; title failure cannot change confirmed native review', () =>
  fast(async () => {
    let releaseReads = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (url, init) => {
        const path = new URL(new Request(url, init).url).pathname;
        if (path.endsWith('/verification')) return Response.json({ verificationRequest: request });
        if (path.endsWith('/active')) return Response.json({ digest: 'current' });
        if (path.includes('/releases/'))
          return ++releaseReads === 1
            ? never<Response>()
            : Response.json({ digest: 'current', release: { types: { 'schema:Person': {} }, properties: {} } });
        return never<Response>();
      }) as typeof fetch,
    });
    const confirmed = await readVerification(client, 'alice', 'Bearer current');
    await expect(readVerificationEligibility(client, 'Bearer current')).rejects.toThrow('timed out');
    expect((await readVerificationEligibility(client, 'Bearer current')).types).toHaveProperty('schema:Person');
    expect(await readVerificationTitle(client, input.subject, 'Bearer current', ['en'])).toBeNull();
    expect(confirmed).toEqual(request);
    expect(releaseReads).toBe(2);
  }));

test('review and lost submission recover explicitly with exact input, identity and fresh readback; withdrawal stays uncertain', () =>
  fast(async () => {
    let reads = 0;
    let writes = 0;
    const sent: VerificationInput[] = [];
    const controller = new VerificationRecovery('alice', {
      read: async () => {
        if (++reads === 1 || reads === 4) return never();
        return { accountId: 'alice', verificationRequest: reads === 2 ? null : request, subjectTitle: null };
      },
      request: async (_account, draft) => {
        sent.push(draft);
        return ++writes === 1 ? never() : { ok: true, verificationRequest: request };
      },
      withdraw: never,
    });
    await controller.reload();
    expect(controller.snapshot().phase).toBe('unavailable');
    await controller.reload();
    const draft = { ...input, links: [] };
    await controller.submit(draft);
    const attempt = controller.snapshot().attempt;
    draft.statement = 'Later draft';
    expect(controller.snapshot()).toMatchObject({ phase: 'uncertain', attempt });
    await controller.reload(); // A matching payload alone cannot identify the original command.
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(writes).toBe(1);
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ phase: 'uncertain', readStatus: 'error' });
    expect(sent).toEqual([attempt!.input, attempt!.input]);
    expect(sent[0]!.statement).toBe(input.statement);
    await controller.reload();
    expect(controller.snapshot()).toMatchObject({ phase: 'review', attempt: null });
    await controller.withdraw(true);
    const withdrawal = controller.snapshot().attempt;
    expect(controller.snapshot()).toMatchObject({ phase: 'uncertain', attempt: { requestId: request.id } });
    await controller.reload();
    expect(controller.snapshot().attempt).toBe(withdrawal);
    expect(writes).toBe(2);
  }));

test('caller cancellation releases resources, prevents dispatch and retirement aborts pending review', async () => {
  const caller = new AbortController();
  const remove = spyOn(caller.signal, 'removeEventListener');
  const clear = spyOn(globalThis, 'clearTimeout');
  let signal!: AbortSignal;
  try {
    const pending = withVerificationDeadline((child) => {
      signal = child;
      return never();
    }, caller.signal);
    caller.abort(new Error('retired'));
    await expect(pending).rejects.toThrow('retired');
    expect(signal.aborted).toBe(true);
    let dispatched = false;
    await expect(
      withVerificationDeadline(async () => {
        dispatched = true;
      }, caller.signal),
    ).rejects.toThrow('retired');
    expect(dispatched).toBe(false);
    expect(await withVerificationDeadline(async () => 'ready')).toBe('ready');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledTimes(3);
  } finally {
    remove.mockRestore();
    clear.mockRestore();
  }
  const controller = new VerificationRecovery('alice', {
    read: async (_account, child) => {
      signal = child!;
      return never();
    },
    request: never,
    withdraw: never,
  });
  const pending = controller.reload();
  controller.deactivate();
  await pending;
  expect(signal.aborted).toBe(true);
  expect(controller.snapshot().current).toBeNull();
});
