import { expect, expectTypeOf, mock, spyOn, test } from 'bun:test';
import type { MediaImportFetchConfig } from '../../src/content/media-import.ts';
import type { NativeAuthorErasureWorkflows } from '../../src/content/operation-contract.ts';
import * as routes from '../../src/content/routes.ts';
import type { ContentRuntime } from '../../src/content/runtime.ts';
import type { TurnstileVerifier } from '../../src/content/turnstile.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel, type KernelDependencies } from '../../src/http/kernel.ts';

type KernelContent = ContentRuntime & { cursorNow?: () => number };

test('trusted optional content runtime types retain exactly the three native ports', () => {
  expectTypeOf<ContentRuntime>().toEqualTypeOf<
    Readonly<{
      fetchConfig?: MediaImportFetchConfig;
      workflows?: NativeAuthorErasureWorkflows;
      anonymousVerifier?: TurnstileVerifier;
    }>
  >();
  expectTypeOf<keyof ContentRuntime>().toEqualTypeOf<'fetchConfig' | 'workflows' | 'anonymousVerifier'>();
  expectTypeOf<KernelDependencies['content']>().toEqualTypeOf<KernelContent | undefined>();
  expectTypeOf<routes.Dependencies['cursorNow']>().toEqualTypeOf<(() => number) | undefined>();
  expectTypeOf<Pick<routes.Dependencies, keyof ContentRuntime>>().toEqualTypeOf<ContentRuntime>();
  expectTypeOf<Parameters<typeof routes.contentRoutes>[1]>().toEqualTypeOf<routes.Dependencies>();
  expectTypeOf<KernelDependencies['clock']>().toEqualTypeOf<(() => Date) | undefined>();
  expect({} satisfies ContentRuntime).toEqual({});
});

test('kernel forwards native ports unchanged without executing jobs, I/O, access or its sole clock', async () => {
  const forbidden = mock((): never => {
    throw new Error('Composition must not execute a dependency');
  });
  const pool = createPool('postgres://kernel.invalid/content-runtime');
  const connect = spyOn(pool, 'connect').mockImplementation(forbidden);
  const query = spyOn(pool, 'query').mockImplementation(forbidden);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(forbidden, { preconnect: forbidden }));
  const compose = spyOn(routes, 'contentRoutes');
  const fetchConfig: MediaImportFetchConfig = Object.freeze({ allowedHosts: Object.freeze(['images.example']) });
  const workflows: NativeAuthorErasureWorkflows = Object.freeze({ enqueue: forbidden, status: forbidden });
  const anonymousVerifier: TurnstileVerifier = Object.freeze({ verify: forbidden });
  const cursorNow = forbidden;
  const runtime: ContentRuntime = Object.freeze({ fetchConfig, workflows, anonymousVerifier });
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(42)]]) };
  const base: KernelDependencies = { pool, routeKey: new Uint8Array(32), tokens, access: forbidden, clock: forbidden };
  try {
    const baseline = JSON.stringify(
      createKernel(base).routes.map(({ method, path, hooks }) => ({ method, path, hooks })),
    );
    const omitted = compose.mock.calls.at(-1)![1];
    for (const field of Object.keys(runtime)) expect(Object.hasOwn(omitted, field)).toBe(false);

    for (let mask = 0; mask < 8; mask++) {
      const content: KernelContent = {
        ...(mask & 1 ? { fetchConfig } : {}),
        ...(mask & 2 ? { workflows } : {}),
        ...(mask & 4 ? { anonymousVerifier } : {}),
        cursorNow,
      };
      // Extra JavaScript properties cannot introduce another clock or request authority.
      const provided = { ...content, clock: forbidden, actor: forbidden, provider: forbidden, permission: forbidden };
      const kernel = createKernel({ ...base, content: provided });
      const received = compose.mock.calls.at(-1)![1];
      expect(received.fetchConfig).toBe(content.fetchConfig);
      expect(received.workflows).toBe(content.workflows);
      expect(received.anonymousVerifier).toBe(content.anonymousVerifier);
      expect(received.cursorNow).toBe(content.cursorNow);
      expect(received.pool).toBe(pool);
      expect(received.tokens).toBe(tokens);
      expect(received.routeKey).toBe(base.routeKey);
      expect(typeof received.clock).toBe('function');
      expect(Object.keys(received).sort()).toEqual(
        ['pool', 'routeKey', 'clock', 'tokens', 'access', ...Object.keys(content)].sort(),
      );
      expect(JSON.stringify(kernel.routes.map(({ method, path, hooks }) => ({ method, path, hooks })))).toBe(baseline);
    }
    expect(forbidden).not.toHaveBeenCalled();
  } finally {
    compose.mockRestore();
    fetch.mockRestore();
    query.mockRestore();
    connect.mockRestore();
    await pool.end();
  }
});

test('content composition retains lazy access resolution and the validated kernel clock', async () => {
  const pool = createPool('postgres://kernel.invalid/content-runtime');
  const compose = spyOn(routes, 'contentRoutes');
  const access = { authenticate: mock(), authorize: mock() };
  const factory = mock(() => access);
  const instant = new Date('2026-01-01T00:00:00Z');
  const clock = mock(() => instant);
  try {
    createKernel({ pool, routeKey: new Uint8Array(32), access: factory, clock, content: {} });
    const received = compose.mock.calls.at(-1)![1];
    expect(factory).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(received.access).toBe(access);
    expect(received.access).toBe(access);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(received.clock!()).toBe(instant);
    expect(clock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(new Date(NaN));
    expect(() => received.clock!()).toThrow('Invalid command clock');
  } finally {
    compose.mockRestore();
    await pool.end();
  }
});
