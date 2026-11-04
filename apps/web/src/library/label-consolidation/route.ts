import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import { consolidationClient, type ConsolidationTransport } from './client';

type Owner = { viewer: string; sourceLabelId: string; csrfToken: string };
type Call<K extends keyof ConsolidationTransport> = Owner & { args: Parameters<ConsolidationTransport[K]> };

async function owner(data: Owner) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const identity = await readSubjectSlotSession(request, env as Partial<SessionEnv>);
  if (
    identity.state !== 'signed-in' || identity.subject !== data.viewer ||
    !identity.csrfToken || identity.csrfToken !== data.csrfToken ||
    !/^[0-9a-f-]{36}$/i.test(data.sourceLabelId)
  ) throw new Error('Consolidation owner is no longer current');
  return consolidationClient(kernelClient(), data.sourceLabelId, { authorization: identity.authorization });
}
const review = createServerFn({ method: 'POST' }).validator((data: Call<'review'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).review(...data.args);
    return { data: value, error };
  });
const confirm = createServerFn({ method: 'POST' }).validator((data: Call<'confirm'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).confirm(...data.args);
    return { data: value, error };
  });
const apply = createServerFn({ method: 'POST' }).validator((data: Call<'apply'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).apply(...data.args);
    return { data: value, error };
  });
const retry = createServerFn({ method: 'POST' }).validator((data: Call<'retry'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).retry(...data.args);
    return { data: value, error };
  });
const cancel = createServerFn({ method: 'POST' }).validator((data: Call<'cancel'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).cancel(...data.args);
    return { data: value, error };
  });
const result = createServerFn({ method: 'POST' }).validator((data: Call<'result'>) => data)
  .handler(async ({ data }) => {
    const { data: value, error } = await (await owner(data)).result(...data.args);
    return { data: value, error };
  });

/** Native DTOs and errors pass through unchanged; no client publisher or assignment writer. */
export function consolidationTransport(viewer: string, sourceLabelId: string, headers: Record<string, string>): ConsolidationTransport {
  const captured = { viewer, sourceLabelId, csrfToken: headers['x-csrf-token'] ?? '' };
  return {
    review: (...args) => review({ data: { ...captured, args } }),
    confirm: (...args) => confirm({ data: { ...captured, args } }),
    apply: (...args) => apply({ data: { ...captured, args } }),
    retry: (...args) => retry({ data: { ...captured, args } }),
    cancel: (...args) => cancel({ data: { ...captured, args } }),
    result: (...args) => result({ data: { ...captured, args } }),
  };
}
