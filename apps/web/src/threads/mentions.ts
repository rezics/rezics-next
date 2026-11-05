import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import { lookupAccountMention } from '../kernel/mentions';

const readMention = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input) ? input : '',
  )
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return lookupAccountMention(kernelClient(), data, getRequest().signal);
  });

export function lookupPostMention(handle: string, signal: AbortSignal) {
  return readMention({ data: handle, signal });
}
