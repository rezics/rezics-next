import { expect, test } from 'bun:test';
import {
  AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES,
} from '@rezics/auth-contract';
import { AUTOMATED_PROFILE, loadAutomatedCreationPage } from '../src/automated-account-create';

const accountId = '11111111-1111-4111-8111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';
const operator = { id: operatorId, kind: 'organization', handle: 'operator', displayName: 'Operator' };
const session = {
  account_id: accountId,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: [...AUTOMATED_PROFILE.scope],
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 3,
  amr: ['pwd'],
};
const rules = {
  minLength: 3,
  maxLength: 64,
  normalization: 'lowercase',
  pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
};
type Readiness = 'authentication-needed' | 'select-operator' | 'review' | 'refused';
function page(readiness: Readiness, picked = operator) {
  const actions = {
    'authentication-needed': 'authenticate',
    'select-operator': 'select-operator',
    review: 'confirm',
    refused: 'none',
  } as const;
  return {
    viewer: { accountId },
    readiness,
    operator: readiness === 'review' ? picked : null,
    handleRules: rules,
    action: actions[readiness],
  };
}
function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}
function maximalReview() {
  return page('review', {
    id: operatorId,
    kind: 'organization',
    handle: `a${'-'.repeat(AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH - 1)}`,
    displayName: '\u0001'.repeat(AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH),
  });
}
type Call = { path: string; init?: RequestInit };
async function loadWith(
  pageResponse: Response,
  options: {
    sessions?: object[];
    caller?: AbortSignal;
    operatorAccountId?: string | null;
    sessionResponse?: (body: object) => Response;
  } = {},
) {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  let sessionIndex = 0;
  const sessionBodies = options.sessions ?? [session, session];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === '/session') {
      const body = sessionBodies[Math.min(sessionIndex++, sessionBodies.length - 1)]!;
      return options.sessionResponse?.(body) ?? json(body);
    }
    if (path === '/account-management/automated/operator') return pageResponse;
    throw new Error(`Unexpected Auth request: ${path}`);
  }) as typeof fetch;
  try {
    return {
      result: await loadAutomatedCreationPage(
        accountId,
        options.operatorAccountId === undefined ? operatorId : options.operatorAccountId,
        options.caller,
      ),
      calls,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('installed loader admits all legal page variants and the maximum escaped review within the byte budget', async () => {
  const variants = [
    ['authentication-needed', operatorId],
    ['select-operator', null],
    ['review', operatorId],
    ['refused', operatorId],
  ] as const;
  for (const [readiness, selected] of variants) {
    const value = page(readiness);
    const { result, calls } = await loadWith(json(value), { operatorAccountId: selected });
    expect(result).toEqual({ kind: 'ready', page: value });
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
    expect(calls[1]!.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorAccountId: selected }),
    });
    expect(calls[1]!.init?.signal).toBeInstanceOf(AbortSignal);
  }

  const maximal = maximalReview();
  const serialized = JSON.stringify(maximal);
  expect(new TextEncoder().encode(serialized).byteLength).toBe(AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES);
  const { result, calls } = await loadWith(
    new Response(serialized, { headers: { 'content-type': 'application/json' } }),
  );
  expect(result).toEqual({ kind: 'ready', page: maximal });
  expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
});

test('bounded stream decoding accepts split UTF-8 and ignores absent or false Content-Length', async () => {
  const emojiPage = page('review', { ...operator, displayName: 'Operator 🙂' });
  const bytes = new TextEncoder().encode(JSON.stringify(emojiPage));
  const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
  const split = emojiStart + 2;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/json', 'content-length': '1' } },
  );
  const { result, calls } = await loadWith(response);
  expect(result).toEqual({ kind: 'ready', page: emojiPage });
  expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
});

test('malformed or over-bound page identity and labels are unavailable after the original three-read sequence', async () => {
  const valid = page('review');
  const invalid = [
    { ...valid, extra: true },
    { ...valid, viewer: { accountId: '33333333-3333-4333-8333-333333333333' } },
    { ...valid, operator: { ...operator, handle: 'a'.repeat(AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH + 1) } },
    {
      ...valid,
      operator: { ...operator, displayName: 'x'.repeat(AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH + 1) },
    },
    { ...valid, handleRules: { ...rules, maxLength: 65 } },
    { ...valid, action: 'authenticate' },
  ];
  for (const value of invalid) {
    const { result, calls } = await loadWith(json(value));
    expect(result).toEqual({ kind: 'unavailable' });
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
    expect(calls.some(({ path }) => path.startsWith('/account-operations/') || path === '/signin')).toBe(false);
  }
});

test('stream overflow is rejected before JSON parsing despite a false short length header', async () => {
  const raw = `${JSON.stringify(maximalReview())} `;
  expect(raw.length).toBe(AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES + 1);
  let parsedOverflow = false;
  const originalParse = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === raw) parsedOverflow = true;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    const { result, calls } = await loadWith(
      new Response(raw, { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
    );
    expect(result).toEqual({ kind: 'unavailable' });
    expect(parsedOverflow).toBe(false);
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator']);
  } finally {
    JSON.parse = originalParse;
  }
});

test('error bodies are bounded and status mapping stays signed-out, refused or unavailable', async () => {
  for (const [status, expected] of [
    [401, 'signed-out'],
    [403, 'refused'],
    [503, 'unavailable'],
  ] as const) {
    const { result, calls } = await loadWith(json({ error: 'automated_operator_denied' }, status));
    expect(result).toEqual({ kind: expected });
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator']);
  }
  const tooLargeError = json({ error: '\u0001'.repeat(AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES) }, 403);
  expect((await loadWith(tooLargeError)).result).toEqual({ kind: 'unavailable' });
});

test('caller cancellation retires stalled page and either session phase even when streams ignore abort', async () => {
  async function cancelledAt(target: 'first-session' | 'page' | 'second-session') {
    const controller = new AbortController();
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    let sessions = 0;
    const stalled = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            setTimeout(() => controller.abort(), 0);
            return new Promise<void>(() => {});
          },
          cancel() {
            return new Promise<void>(() => {});
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    globalThis.fetch = (async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === '/session') {
        sessions++;
        if ((target === 'first-session' && sessions === 1) || (target === 'second-session' && sessions === 2))
          return stalled();
        return json(session);
      }
      if (path === '/account-management/automated/operator') {
        if (target === 'page') return stalled();
        return json(page('review'));
      }
      throw new Error(`Unexpected Auth request: ${path}`);
    }) as typeof fetch;
    try {
      const result = await loadAutomatedCreationPage(accountId, operatorId, controller.signal);
      return { result, calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const first = await cancelledAt('first-session');
  expect(first.result).toEqual({ kind: 'unavailable' });
  expect(first.calls).toEqual(['/session']);
  const pageRead = await cancelledAt('page');
  expect(pageRead.result).toEqual({ kind: 'unavailable' });
  expect(pageRead.calls).toEqual(['/session', '/account-management/automated/operator']);
  const current = await cancelledAt('second-session');
  expect(current.result).toEqual({ kind: 'unavailable' });
  expect(current.calls).toEqual(['/session', '/account-management/automated/operator', '/session']);
  expect(
    first.calls.concat(pageRead.calls, current.calls).some((path) => path.startsWith('/account-operations/')),
  ).toBe(false);
});

test('post-read session replacement keeps advice unavailable', async () => {
  const replaced = { ...session, authn_epoch: session.authn_epoch + 1 };
  const { result, calls } = await loadWith(json(page('review')), { sessions: [session, replaced] });
  expect(result).toEqual({ kind: 'unavailable' });
  expect(calls.map(({ path }) => path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
});
