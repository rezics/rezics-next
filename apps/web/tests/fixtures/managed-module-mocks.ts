import { mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as start from '../../.storybook/react-start';

// Module mocks are process-wide and bun may run the managed-account files in any order. Every file registers this
// same definition, so a module cached by one file behaves identically for the others.
export const requests = new AsyncLocalStorage<Request>();
export const boundaries: Request[] = [];
export const env: Record<string, unknown> = {};

export function installManagedModuleMocks(): void {
  mock.module('@tanstack/react-start', () => ({
    ...start,
    createServerFn: (options?: { method?: string }) => {
      const original = start.createServerFn();
      const chain = {
        validator(validate: (input: unknown) => unknown) {
          original.validator(validate);
          return chain;
        },
        handler<T extends (...args: never[]) => unknown>(handler: T): T {
          const invoke = original.handler(handler);
          return ((input?: { headers?: HeadersInit }) => {
            const headers = new Headers(input?.headers);
            headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
            headers.set('origin', 'https://site.test');
            const request = new Request('https://site.test/en/settings', { method: options?.method ?? 'GET', headers });
            boundaries.push(request);
            return requests.run(request, () => invoke(input as never));
          }) as unknown as T;
        },
      };
      return chain;
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => requests.getStore()! }));
  mock.module('cloudflare:workers', () => ({ env }));
}
