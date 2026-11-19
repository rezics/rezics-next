import { afterEach, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

const origin = 'https://auth.test';
const sessionUrl = origin + '/session';
const cookie = 'auth_session=original';

export function runManagementTestsInChild(file: string) {
  if (process.env.AUTH_MANAGEMENT_TEST_CHILD === file) return false;
  // Bun module mocks affect the whole process, including already imported modules.
  test('Auth management with the native issuer reader', async () => {
    const child = Bun.spawn([process.execPath, 'test', file], {
      env: { ...process.env, AUTH_MANAGEMENT_TEST_CHILD: file },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, output + error).toBe(0);
  });
  return true;
}

type ServerFnInput = { data?: unknown; signal?: AbortSignal };
type Call = { url: string; path: string; init: RequestInit; body: Record<string, unknown> };

export function installManagementServerFixture() {
  const requests = new AsyncLocalStorage<Request>();
  const binding: { AUTH_SECURITY_SCOPE_CONFIGURATION?: string } = { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:4' };
  mock.module('@tanstack/react-start', () => ({
    createServerFn: () => {
      let validate = (data: unknown) => data;
      const builder = {
        validator(check: typeof validate) {
          validate = check;
          return builder;
        },
        handler: (handler: (input: ServerFnInput) => unknown) => (options?: ServerFnInput) => {
          const signal = options?.signal;
          const request = new Request(origin + '/_serverFn/session', {
            headers: { origin, cookie },
            ...(signal ? { signal } : {}),
          });
          return requests.run(request, () => handler({ ...options, data: validate(options?.data) }));
        },
      };
      return builder;
    },
    createServerOnlyFn: (handler: unknown) => handler,
  }));
  mock.module('cloudflare:workers', () => ({ env: binding }));
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: () => requests.getStore()!,
    setResponseHeader() {},
  }));
  Object.assign(globalThis, { __AUTH_ORIGIN__: '' });

  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const observed: Call[] = [];
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    binding.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4';
    const calls = observed.splice(0);
    for (const { url, path, init } of calls) {
      if (path !== '/session') {
        expect(url).toBe(path);
        continue;
      }
      expect(url).toBe(sessionUrl);
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'manual' });
      const headers = new Headers(init.headers);
      expect(headers.get('cookie')).toBe(cookie);
      expect(headers.get('origin')).toBe(origin);
      expect(headers.has('authorization')).toBe(false);
    }
  });

  function storage() {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      },
    });
  }

  function respond(reply: (call: Call) => Response) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input, init = {}) => {
      const url = String(input);
      const path = new URL(url, origin).pathname;
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const call = { url, path, init, body };
      calls.push(call);
      observed.push(call);
      return reply(call);
    }) as typeof fetch;
    return calls;
  }

  return { binding, respond, storage };
}
