import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareExpectedReader } from '../../session/expected-reader';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from '../entry-restore-credential';
import { consolidationClient, consolidationError, type ConsolidationTransport } from './client';

type Owner = { viewer: string; sourceLabelId: string; csrfToken: string; sender?: string };
type Call<K extends keyof ConsolidationTransport> = Owner & { args: Parameters<ConsolidationTransport[K]> };

async function owner(data: Owner) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  if (
    !(await prepareExpectedReader(request, env as Partial<SessionEnv>, {
      expectedReader: data.viewer,
      expectedCredential: data.csrfToken,
    })) ||
    !/^[0-9a-f-]{36}$/i.test(data.sourceLabelId)
  )
    throw new Error('Consolidation owner is no longer current');
  const authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, data.sender);
  if (!authorization) throw new Error('Consolidation sender is no longer current');
  return consolidationClient(kernelClient(), data.sourceLabelId, { authorization });
}
const captureSender = createServerFn({ method: 'POST' })
  .validator((data: Owner) => data)
  .handler(async ({ data }) => {
    await owner(data);
    return captureEntryRestoreCredential(getRequest(), env as Partial<SessionEnv>);
  });
const review = createServerFn({ method: 'POST' })
  .validator((data: Call<'review'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).review(...data.args);
    return { data: value, error: consolidationError(error) };
  });
const confirm = createServerFn({ method: 'POST' })
  .validator((data: Call<'confirm'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).confirm(...data.args);
    return { data: value, error: consolidationError(error) };
  });
const apply = createServerFn({ method: 'POST' })
  .validator((data: Call<'apply'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).apply(...data.args);
    return { data: value, error: consolidationError(error) };
  });
const retry = createServerFn({ method: 'POST' })
  .validator((data: Call<'retry'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).retry(...data.args);
    return { data: value, error: consolidationError(error) };
  });
const cancel = createServerFn({ method: 'POST' })
  .validator((data: Call<'cancel'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).cancel(...data.args);
    return { data: value, error: consolidationError(error) };
  });
const result = createServerFn({ method: 'POST' })
  .validator((data: Call<'result'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).result(...data.args);
    return { data: value, error: consolidationError(error) };
  });

/** Native DTOs and errors pass through unchanged; no client publisher or assignment writer. */
export function consolidationTransport(
  viewer: string,
  sourceLabelId: string,
  headers: Record<string, string>,
): ConsolidationTransport {
  const captured = { viewer, sourceLabelId, csrfToken: headers['x-csrf-token'] ?? '' };
  // The visit retains this transport for an uncertain command. Capture before its first dispatch.
  const sender = captureSender({ data: captured, headers });
  const original = async () => {
    const token = await sender;
    return { ...captured, ...(token === undefined ? {} : { sender: token }) };
  };
  return {
    review: async (...args) => review({ data: { ...(await original()), args }, headers }),
    confirm: async (...args) => confirm({ data: { ...(await original()), args }, headers }),
    apply: async (...args) => apply({ data: { ...(await original()), args }, headers }),
    retry: async (...args) => retry({ data: { ...(await original()), args }, headers }),
    cancel: async (...args) => cancel({ data: { ...(await original()), args }, headers }),
    result: async (...args) => result({ data: { ...(await original()), args }, headers }),
  };
}
