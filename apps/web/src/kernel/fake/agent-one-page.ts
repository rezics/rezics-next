import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

const SUBJECT = '0192f3a0-6c1e-7b2a-e001-000000000001';
const OPERATOR = '0192f3a0-6c1e-7b2a-f001-000000000009';
const HANDLE = 'helper';

function recording(source: KernelRecording | undefined): KernelRecording | undefined {
  if (!source || !source.reads || typeof source.reads !== 'object') return;
  const page = structuredClone(source);
  for (const read of Object.values(page.reads as Record<string, { body?: { accounts?: Record<string, unknown>[] } }>)) {
    const profile = read.body?.accounts?.[0];
    if (!profile) continue;
    profile.handle = HANDLE;
    profile.displayName = 'Helpful Software';
    profile.automated = true;
    profile.operatorId = OPERATOR;
  }
  page.handle = HANDLE;
  return page;
}

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function redirect(request: Request, target: Record<string, unknown>): KernelRecording {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.searchParams);
  params.set('target', JSON.stringify(target));
  return {
    status: 308,
    headers: { location: `${url.pathname}?${params.toString()}` },
    redirect: { from: SUBJECT, to: HANDLE },
  };
}

const operator = {
  id: OPERATOR,
  kind: 'actor',
  state: 'active',
  handle: 'operator',
  displayName: 'Operator Name',
  automated: false,
  operatorId: null,
};

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request, recordings }) => {
      const input = await body(request);
      const target = input?.target;
      if (!target || typeof target !== 'object' || Array.isArray(target)) return;
      const pageTarget = target as Record<string, unknown>;
      if (pageTarget.subject === SUBJECT)
        return redirect(request, { account: HANDLE, ...(pageTarget.view ? { view: pageTarget.view } : {}) });
      if (pageTarget.account === HANDLE) return recording(recordings['agent-page']);
    },
    fixture: async ({ request, recordings }) => {
      const input = await body(request);
      const target = input?.target;
      if (!target || typeof target !== 'object' || Array.isArray(target)) return;
      const pageTarget = target as Record<string, unknown>;
      if (pageTarget.subject === SUBJECT)
        return redirect(request, { account: HANDLE, ...(pageTarget.view ? { view: pageTarget.view } : {}) });
      if (pageTarget.account === HANDLE) return recording(recordings['agent-page']);
    },
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: async ({ request }) =>
      new URL(request.url).searchParams.get('ids') === OPERATOR
        ? { status: 200, accounts: [operator], next: null }
        : undefined,
    fixture: async ({ request }) =>
      new URL(request.url).searchParams.get('ids') === OPERATOR
        ? { status: 200, accounts: [operator], next: null }
        : undefined,
  },
];
