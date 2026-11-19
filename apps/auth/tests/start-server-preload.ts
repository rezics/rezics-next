import { mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

// Bun loads route dependencies before mounted test files can install mocks.
const requestSignal = new AsyncLocalStorage<AbortSignal | undefined>();
type ServerFnInput = { data?: unknown; signal?: AbortSignal | undefined };
function createServerFn() {
  let validate = (value: unknown) => value;
  const builder = {
    validator(check: (value: unknown) => unknown) {
      validate = check;
      return builder;
    },
    handler(handler: (input: ServerFnInput) => unknown) {
      return (options?: ServerFnInput) =>
        requestSignal.run(options?.signal, () => handler({ data: validate(options?.data), signal: options?.signal }));
    },
  };
  return builder;
}

const start = { ...(await import('@tanstack/react-start')) };
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn,
  createServerOnlyFn: <T>(handler: T) => handler,
}));
const server = { ...(await import('@tanstack/react-start/server')) };
mock.module('@tanstack/react-start/server', () => ({
  ...server,
  getRequest: () => {
    const signal = requestSignal.getStore();
    return new Request('https://auth.test/_serverFn/session', {
      headers: { origin: 'https://auth.test', cookie: 'auth_session=original' },
      ...(signal ? { signal } : {}),
    });
  },
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:20' } }));
