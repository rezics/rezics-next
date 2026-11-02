import { afterAll, expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  performOperation,
  readAccount,
  readOperations,
  readPending,
  type Operation,
} from '../src/account-verification/transport';
import { withVerificationDeadline } from '../src/account-verification/deadline';
import { request } from '../src/stories/pages/accounts-verification/fixtures';

const schedule = globalThis.setTimeout;
const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
  schedule(fn, ms === 10_000 ? 10 : ms, ...args)) as typeof setTimeout);
afterAll(() => timer.mockRestore());
const stalled = (body: boolean) =>
  body
    ? Promise.resolve(new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }))
    : new Promise<Response>(() => {});
const clientFor = (reply: (incoming: Request) => Response | Promise<Response>) =>
  createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => reply(new Request(input, init))) as typeof fetch,
  });

for (const body of [false, true]) {
  test(`primary reads and discovery recover stalled ${body ? 'bodies' : 'headers'} without an empty queue`, async () => {
    const calls: Request[] = [];
    const client = clientFor((incoming) => {
      calls.push(incoming);
      return stalled(body);
    });
    expect(await readPending(client, 'Bearer current', 'signed/+cursor==')).toEqual({ state: 'unavailable' });
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('signed/+cursor==');
    expect(await readOperations(client, 'Bearer current')).toEqual({ state: 'unavailable' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
  });

  test(`optional stalled ${body ? 'bodies' : 'headers'} retain the queue and independent subject results`, async () => {
    const otherSubject = crypto.randomUUID();
    const client = clientFor((incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path.endsWith('/verification-requests'))
        return Response.json({
          verificationRequests: [request, { ...request, id: crypto.randomUUID(), catalogueSubjectId: otherSubject }],
          next: 'signed-next',
        });
      if (path.endsWith(otherSubject)) return Response.json({ subject: { labels: { en: 'Readable subject' } } });
      return stalled(body);
    });
    const page = await readPending(client, 'Bearer current');
    expect(page).toMatchObject({
      state: 'ready',
      value: {
        next: 'signed-next',
        requests: [
          { account: null, subject: null },
          { account: null, subject: { id: otherSubject, name: 'Readable subject' } },
        ],
      },
    });
  });

  for (const phase of ['latest', 'identity', 'discovery', 'publication', 'authority'] as const)
    test(`account ${phase} readback recovers stalled ${body ? 'body' : 'headers'} conservatively`, async () => {
      const client = clientFor((incoming) => {
        const url = new URL(incoming.url);
        const current = url.pathname.endsWith('/verification')
          ? 'latest'
          : url.pathname.endsWith('/openapi.json')
            ? 'discovery'
            : url.pathname.endsWith('/verification-requests')
              ? 'authority'
              : url.searchParams.has('handle')
                ? 'publication'
                : 'identity';
        if (current === phase) return stalled(body);
        if (current === 'latest') return Response.json({ verificationRequest: request });
        if (current === 'discovery')
          return Response.json({ paths: { '/account': { post: { operationId: 'account.revoke_verification' } } } });
        if (current === 'authority') return Response.json({ verificationRequests: [], next: null });
        return Response.json({
          accounts: [{ id: request.accountId, handle: 'mira', state: 'active', verified: false }],
        });
      });
      const page = await readAccount(client, 'Bearer current', request.accountId);
      expect(page.latest.state).toBe(phase === 'latest' ? 'unavailable' : 'ready');
      expect(page.publication.state).toBe(['identity', 'publication'].includes(phase) ? 'unavailable' : 'unverified');
      expect(page.reviewer).toBe(!['discovery', 'authority'].includes(phase));
    });

  for (const action of ['approve', 'reject', 'release', 'revoke'] as const)
    test(`${action} stalled ${body ? 'body' : 'headers'} stays uncertain and reuses its original command only on explicit retry`, async () => {
      const calls: Request[] = [];
      const operation: Operation = {
        action,
        targetId: action === 'approve' || action === 'reject' ? request.id : request.accountId,
        reason: action === 'release' ? '' : 'Independent evidence checked.',
        key: crypto.randomUUID(),
      };
      let recovered = false;
      const client = clientFor((incoming) => {
        calls.push(incoming);
        return recovered ? Response.json({ verificationRequest: request }) : stalled(body);
      });
      expect(await performOperation(client, 'Bearer current', operation)).toEqual({ state: 'uncertain' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.signal.aborted).toBe(true);
      recovered = true;
      expect((await performOperation(client, 'Bearer renewed', operation)).state).toBe('accepted');
      expect(calls[1]!.url).toBe(calls[0]!.url);
      expect(await calls[1]!.json()).toEqual(await calls[0]!.json());
      expect(calls.every((call) => call.headers.get('idempotency-key') === operation.key)).toBe(true);
    });
}

test('caller cancellation composes with the deadline, releases listeners and avoids pre-cancelled dispatch', async () => {
  const caller = new AbortController();
  const removed = spyOn(caller.signal, 'removeEventListener');
  let native: AbortSignal | undefined;
  const pending = withVerificationDeadline((signal) => {
    native = signal;
    return new Promise(() => {});
  }, caller.signal);
  caller.abort(new Error('Viewer retired'));
  await expect(pending).rejects.toThrow('Viewer retired');
  expect(native?.aborted).toBe(true);
  expect(removed).toHaveBeenCalledTimes(1);
  await expect(
    withVerificationDeadline(() => {
      throw new Error('Unexpected dispatch');
    }, caller.signal),
  ).rejects.toThrow('Viewer retired');
  removed.mockRestore();
  const cleared = spyOn(globalThis, 'clearTimeout');
  expect(await withVerificationDeadline(async () => 'ready')).toBe('ready');
  expect(cleared).toHaveBeenCalledTimes(1);
  cleared.mockRestore();
});
