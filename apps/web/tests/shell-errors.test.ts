import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { selectShellErrorStory, shellErrorOfferId, shellErrorReads } from '../src/kernel/fake/shell-errors';
import { PlatformClosedError } from '../src/kernel/platform-closed';

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
