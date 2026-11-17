import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runDevelopmentSeed, seedFailureDetail } from '../../../scripts/datasets/cross-media-seed.ts';
import { SeedReadinessError, waitForKernelReadiness, type SeedReadinessOptions } from '../src/seed-readiness.ts';
import { MAX_IMPORT_RESPONSE_BYTES } from '../src/import-fetch.ts';

type ReadinessFetch = NonNullable<SeedReadinessOptions['fetch']>;
function readinessFetch(mock: (...args: Parameters<ReadinessFetch>) => ReturnType<ReadinessFetch>): ReadinessFetch {
  return Object.assign(mock, {
    preconnect() {
      throw new Error('Unexpected readiness preconnect');
    },
  });
}

const origin = 'http://127.0.0.1:4317';
const env = {
  KERNEL_ORIGIN: origin,
  AUTH_ORIGIN: 'https://auth.seed.test',
  REZICS_DEV_PERSONA_ACCOUNT_KEY: 'persona.key',
  REZICS_DEV_PERSONA_ACCOUNT: crypto.randomUUID(),
  REZICS_DEV_PERSONA_CLIENT: 'persona-client',
  REZICS_DEV_SHOWCASE_ACCOUNT_KEY: 'showcase.key',
  REZICS_DEV_SHOWCASE_CLIENT: 'showcase-client',
};

function clock() {
  let time = 0;
  const timers = new Map<() => void, number>();
  const advance = (ms: number) => {
    time += ms;
    for (const [callback, at] of [...timers].sort((a, b) => a[1] - b[1])) {
      if (at <= time && timers.delete(callback)) callback();
    }
  };
  return {
    now: () => time,
    schedule: (callback: () => void, ms: number) => {
      timers.set(callback, time + ms);
      return () => {
        timers.delete(callback);
      };
    },
    sleep: async (ms: number) => advance(ms),
    advance,
    timers,
  };
}

async function failureOf(operation: Promise<unknown>): Promise<SeedReadinessError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SeedReadinessError);
    return error as SeedReadinessError;
  }
  throw new Error('Readiness unexpectedly succeeded');
}

test('development seed waits for network failure, boot 503 and HTTP 200 before catalogue or import effects', async () => {
  const temp = join(import.meta.dir, '../../../.temp');
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'seed-readiness-'));
  const events: string[] = [];
  const requests: { request: Request; init: RequestInit | undefined }[] = [];
  const time = clock();
  const stop = new Error('captured import handoff');
  try {
    await expect(
      runDevelopmentSeed({
        root,
        env,
        waitForKernel: async (input) => {
          expect(input.origin).toBe(origin);
          await waitForKernelReadiness({
            ...input,
            ...time,
            fetch: readinessFetch(async (url, init) => {
              requests.push({ request: new Request(url, init), init });
              events.push('probe');
              if (requests.length === 1) throw Object.assign(new Error('booting'), { code: 'ECONNREFUSED' });
              return new Response('{}', { status: requests.length === 2 ? 503 : 200 });
            }),
          });
          events.push('ready');
        },
        fetchDumps: async () => {
          events.push('dumps');
          return {
            cacheRoot: root,
            bangumi: join(root, 'bangumi'),
            vndb: join(root, 'vndb'),
            bangumiArchive: join(root, 'bangumi.zip'),
            vndbArchive: join(root, 'vndb.tar.zst'),
            sourceSnapshots: {
              bangumi: {
                file: 'bangumi.zip',
                url: 'https://seed.test/bangumi.zip',
                sha256: '0'.repeat(64),
                licences: [],
              },
              vndb: {
                file: 'vndb.tar.zst',
                url: 'https://seed.test/vndb.tar.zst',
                sha256: '1'.repeat(64),
                licences: [],
              },
            },
          };
        },
        createTokenProvider: async (input) => {
          events.push('token');
          expect(input.authOrigin).toBe(env.AUTH_ORIGIN);
          return async () => 'seed-token';
        },
        seedCatalogue: async () => {
          events.push('catalogue');
          return { subjects: {}, facts: [] };
        },
        runSeed: async (args) => {
          events.push('import');
          expect(args[args.indexOf('--api') + 1]).toBe(origin);
          expect(args[args.indexOf('--auth') + 1]).toBe(env.AUTH_ORIGIN);
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(events).toEqual(['probe', 'probe', 'probe', 'ready', 'dumps', 'token', 'catalogue', 'token', 'import']);
    expect(requests.every(({ request }) => request.url === `${origin}/v1/definitions/active`)).toBe(true);
    expect(requests.every(({ request }) => request.method === 'GET' && !request.headers.has('authorization'))).toBe(
      true,
    );
    expect(requests.every(({ init }) => init?.credentials === 'omit' && init.redirect === 'error')).toBe(true);
    expect(requests.every(({ init }) => init?.cache === 'no-store')).toBe(true);
    expect(time.timers.size).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness exhaustion leaves every development import effect unstarted and preserves safe network diagnostics', async () => {
  const time = clock();
  const effects: string[] = [];
  const cause = Object.assign(new Error('Bearer secret raw body https://user:password@seed.test/?token=private'), {
    code: 'ECONNREFUSED',
  });
  let probes = 0;
  const error = await failureOf(
    runDevelopmentSeed({
      env,
      waitForKernel: (input) =>
        waitForKernelReadiness({
          ...input,
          ...time,
          deadlineMs: 5000,
          fetch: readinessFetch(async () => {
            probes++;
            throw cause;
          }),
        }),
      fetchDumps: async () => {
        effects.push('dumps');
        throw new Error('unexpected dump acquisition');
      },
      createTokenProvider: async () => {
        effects.push('token');
        throw new Error('unexpected credentials');
      },
      seedCatalogue: async () => {
        effects.push('catalogue');
        throw new Error('unexpected catalogue');
      },
      runSeed: async () => {
        effects.push('import');
        throw new Error('unexpected import');
      },
    }),
  );
  expect(probes).toBe(3);
  expect(effects).toEqual([]);
  expect(error.phase).toBe('deadline');
  expect(error.status).toBeUndefined();
  expect(error.cause).toBe(cause);
  expect(seedFailureDetail(error)).toBe(
    `Cross-media seed readiness failed phase=deadline method=GET target=${origin}/v1/definitions/active status=none network=ECONNREFUSED correlation=none`,
  );
  expect(time.timers.size).toBe(0);
});

test('only HTTP 200 releases readiness, including after an initially absent boot route', async () => {
  for (const bootStatus of [202, 204, 404]) {
    const time = clock();
    let probes = 0;
    await waitForKernelReadiness({
      origin: 'https://kernel.seed.test:8443',
      ...time,
      fetch: readinessFetch(async (url) => {
        expect(String(url)).toBe('https://kernel.seed.test:8443/v1/definitions/active');
        return new Response(null, { status: ++probes === 1 ? bootStatus : 200 });
      }),
    });
    expect(probes).toBe(2);
    expect(time.timers.size).toBe(0);
  }
});

test('repeated boot probes retain the original operation expiry', async () => {
  const time = clock();
  let probes = 0;
  const error = await failureOf(
    waitForKernelReadiness({
      origin,
      ...time,
      deadlineMs: 2500,
      fetch: readinessFetch(async () => {
        probes++;
        return new Response(null, { status: 404 });
      }),
    }),
  );
  expect(error.phase).toBe('deadline');
  expect(error.status).toBe(404);
  expect(probes).toBe(3);
  expect(time.now()).toBe(2500);
  expect(time.timers.size).toBe(0);
});

test('permanent HTTP refusal and an inadmissible Retry-After stop without exposing response text', async () => {
  for (const status of [403, 429, 503]) {
    const time = clock();
    let probes = 0;
    const error = await failureOf(
      waitForKernelReadiness({
        origin,
        ...time,
        fetch: readinessFetch(async () => {
          probes++;
          return Response.json(
            { retryable: true, detail: 'Bearer secret raw body' },
            { status, headers: { 'retry-after': '99999', 'x-request-id': 'readiness-1' } },
          );
        }),
      }),
    );
    expect(probes).toBe(1);
    expect(error.phase).toBe('http');
    expect(error.status).toBe(status);
    expect(seedFailureDetail(error)).toContain('correlation=readiness-1');
    expect(seedFailureDetail(error)).not.toContain('secret');
    expect(time.timers.size).toBe(0);
  }
});

test('cancellation interrupts a pending retry wait and preserves its private reason', async () => {
  const time = clock();
  const caller = new AbortController();
  const reason = new Error('private cancellation reason');
  let probes = 0;
  const error = await failureOf(
    waitForKernelReadiness({
      origin,
      ...time,
      signal: caller.signal,
      fetch: readinessFetch(async () => {
        probes++;
        return new Response(null, { status: 404 });
      }),
      sleep: () => {
        caller.abort(reason);
        return new Promise<void>(() => {});
      },
    }),
  );
  expect(probes).toBe(1);
  expect(error.phase).toBe('cancelled');
  expect(error.cause).toBe(reason);
  expect(seedFailureDetail(error)).not.toContain(reason.message);
  expect(time.timers.size).toBe(0);
});

test('an expired in-flight probe aborts and cancels a late HTTP 200 without starting imports', async () => {
  const time = clock();
  let complete!: (response: Response) => void;
  let started!: () => void;
  let disposed!: () => void;
  const requestSignals: AbortSignal[] = [];
  let effects = 0;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    disposed = resolve;
  });
  const failure = failureOf(
    runDevelopmentSeed({
      env,
      waitForKernel: (input) =>
        waitForKernelReadiness({
          ...input,
          ...time,
          deadlineMs: 10,
          fetch: readinessFetch(async (_url, init) => {
            if (init?.signal) requestSignals.push(init.signal);
            started();
            return new Promise<Response>((resolve) => {
              complete = resolve;
            });
          }),
        }),
      fetchDumps: async () => {
        effects++;
        throw new Error('unexpected dump acquisition');
      },
    }),
  );
  await fetching;
  time.advance(10);
  expect((await failure).phase).toBe('deadline');
  expect(requestSignals[0]?.aborted).toBe(true);
  complete(new Response(new ReadableStream({ cancel: disposed }), { status: 200 }));
  await cancelled;
  expect(effects).toBe(0);
  expect(time.timers.size).toBe(0);
});

test('an oversized HTTP 200 remains a bounded response failure', async () => {
  const time = clock();
  const error = await failureOf(
    waitForKernelReadiness({
      origin,
      ...time,
      fetch: readinessFetch(async () => new Response(new Uint8Array(MAX_IMPORT_RESPONSE_BYTES + 1))),
    }),
  );
  expect(error.phase).toBe('response');
  expect(error.status).toBe(200);
  expect(time.timers.size).toBe(0);
});
