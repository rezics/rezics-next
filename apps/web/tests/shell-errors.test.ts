import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { selectShellErrorStory, shellErrorOfferId, shellErrorReads } from '../src/kernel/fake/shell-errors';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { recoveryOwnerIsCurrent } from '../src/shell/dependency-recovery/retry-owner';
import { routeFailure, routeRetry } from '../src/shell/error-state';
import { SessionUnavailableError } from '../src/session/unavailable';

let request: Request;
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));
const client = await import('../src/kernel/client');
const { loadOffer } = await import('../src/checkout/offer.server');

test('the Closed story recording reaches the ordinary offer loader as a registered platform refusal in one read', async () => {
  request = new Request(`https://site.test/en/offers/${shellErrorOfferId}`);
  selectShellErrorStory('closed');
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(createStoryRecordedKernelFetch());
  try {
    const pending = loadOffer(shellErrorOfferId, 'en');
    await expect(pending).rejects.toBeInstanceOf(PlatformClosedError);
    await expect(pending).rejects.toMatchObject({
      status: 403,
      problem: {
        type: 'https://rezics.com/problems/platform_closed',
        title: 'Platform Closed',
        status: 403,
        code: 'platform_closed',
        retryable: false,
        effect_status: 'not_applicable',
      },
    });
    await expect(loadOffer(shellErrorOfferId, 'en')).rejects.toBeInstanceOf(PlatformClosedError);
    expect(shellErrorReads()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
    selectShellErrorStory('unavailable');
  }
});

test('the strict offer loader still rejects malformed native problem bodies', async () => {
  // Feed native client results directly to exercise the loader parser independently of gate recognition.
  const transport = spyOn(client, 'kernelClient').mockImplementation(() => createKernelClient('https://kernel.test'));
  const fetcher = spyOn(globalThis, 'fetch');
  try {
    for (const body of [
      { code: 'platform_closed' },
      { body: { code: 'platform_closed' } },
      { code: 'platform_closed', type: 'https://rezics.com/problems/platform_closed' },
      { code: 'platform_closed', type: 403, title: 'Platform Closed' },
    ]) {
      request = new Request(`https://site.test/en/offers/${shellErrorOfferId}`);
      fetcher.mockImplementation(async () => Response.json(body, { status: 403 }));
      await expect(loadOffer(shellErrorOfferId, 'en')).rejects.toThrow('Kernel offer read failed');
    }
  } finally {
    fetcher.mockRestore();
    transport.mockRestore();
  }
});

test('private dependency failures keep their status and only enable one deliberate retry after a safe delay', () => {
  const failure = {
    status: 503,
    code: 'dependency_unavailable',
    retryable: true,
    headers: { 'retry-after': '3' },
  };
  expect(routeFailure([{ status: 'error', error: failure }])).toMatchObject({
    status: 503,
    unavailable: true,
    retryAfter: '3',
  });
  expect(routeRetry(failure)).toMatchObject({ allowed: true, delay: 3, deferred: false });
  expect(routeRetry({ ...failure, retryable: false })).toMatchObject({ allowed: false });
  expect(routeFailure([{ status: 'error', error: new SessionUnavailableError() }])).toMatchObject({ status: 503 });
});

test('late retries retire when navigation or the shared reader observation changes', () => {
  const readerA = { state: 'signed-in' as const, observation: { subject: 'reader-a', id: 1 } };
  const sameReaderA = { state: 'signed-in' as const, observation: { subject: 'reader-a', id: 1 } };
  const replacedReaderA = { state: 'signed-in' as const, observation: { subject: 'reader-a', id: 2 } };
  const readerB = { state: 'signed-in' as const, observation: { subject: 'reader-b', id: 3 } };
  const request = { visit: 'A-1', reader: readerA };

  expect(recoveryOwnerIsCurrent(request, { visit: 'A-1', reader: sameReaderA }, true)).toBe(true);
  expect(recoveryOwnerIsCurrent(request, { visit: 'B-1', reader: readerA }, true)).toBe(false);
  expect(recoveryOwnerIsCurrent(request, { visit: 'A-2', reader: readerA }, true)).toBe(false);
  expect(recoveryOwnerIsCurrent(request, { visit: 'A-1', reader: replacedReaderA }, true)).toBe(false);
  expect(recoveryOwnerIsCurrent(request, { visit: 'A-1', reader: readerB }, true)).toBe(false);
  expect(recoveryOwnerIsCurrent(request, { visit: 'A-1', reader: readerA }, false)).toBe(false);
});
