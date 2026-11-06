import { fork } from 'node:child_process';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { configureReceiptKeys } from '../../src/command/receipt-key.ts';
import { createPool } from '../../src/database/pool.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createOutcomeRpc } from '../search/support/outcome-rpc.ts';
import { sharedAuth, closeOwnedSemanticAuth, type OwnedResourceObserver, type SharedAuth } from './outcome-auth.ts';

type Registration = Parameters<SharedAuth['host']['workflows']['register']>[0];
type Ready = { issuer: string; audience: string };
type EncodedRing = { current: number; keys: [number, string][] };
type Init = {
  source: string;
  kernelUrl: string;
  routeKey: string;
  keys: EncodedRing;
  receiptKeys: EncodedRing;
};

function encodeRing(ring: KeyRing): EncodedRing {
  return {
    current: ring.current,
    keys: [...ring.keys].map(([id, key]) => [id, Buffer.from(key).toString('base64url')]),
  };
}

function decodeRing(encoded: EncodedRing): KeyRing {
  return {
    current: encoded.current,
    keys: new Map(encoded.keys.map(([id, key]) => [id, Buffer.from(key, 'base64url')])),
  };
}

async function settleIndependently(
  steps: readonly (() => unknown | Promise<unknown>)[],
  message: string,
  cause?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (cause && errors.length) throw new AggregateError([cause, ...errors], message, { cause });
  if (cause) throw cause;
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, message);
}

/** Only Auth crosses IPC. Kernel HTTP, Search and the supplied pools stay in the caller's capture context. */
export async function isolatedOutcomeAuth(
  source: URL,
  kernelUrl: string,
  routeKey: Uint8Array,
  keys: KeyRing,
  receiptKeys: KeyRing,
  onOwnedResource?: OwnedResourceObserver,
) {
  const child = fork(import.meta.filename, [], {
    execPath: process.execPath,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const retain = (chunk: unknown) => {
    output = (output + String(chunk)).slice(-65_536);
  };
  child.stdout!.on('data', retain);
  child.stderr!.on('data', retain);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  const rpc = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) =>
          child.send(packet as object, (error) => (error ? reject(error) : resolve())),
        ),
      subscribe(message, failure) {
        const lost = () => failure(new Error(`Isolated Auth disconnected: ${output}`));
        child.on('message', message);
        child.on('error', failure);
        child.on('disconnect', lost);
        child.on('exit', lost);
        return () => {
          child.off('message', message);
          child.off('error', failure);
          child.off('disconnect', lost);
          child.off('exit', lost);
        };
      },
    },
    {
      timeoutMs: 120_000,
      async onRequest(method, params) {
        if (method !== 'owned') throw new Error(`Unknown Auth parent control: ${method}`);
        await onOwnedResource?.(params as Parameters<OwnedResourceObserver>[0]);
        return { acknowledged: true };
      },
    },
  );
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= (async () => {
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 150_000);
      try {
        await settleIndependently(
          [
            () => rpc.request('close'),
            () => {
              if (child.connected) child.disconnect();
            },
            async () => {
              const result = await exited;
              if (forced || result.code !== 0 || result.signal !== null)
                throw new Error(`Isolated Auth did not drain: ${JSON.stringify(result)}: ${output}`);
            },
          ],
          'Isolated Auth cleanup failed',
        );
      } finally {
        clearTimeout(timer);
        rpc.close();
      }
    })());
  }
  try {
    const ready = await rpc.request<Ready>('init', {
      source: source.href,
      kernelUrl,
      routeKey: Buffer.from(routeKey).toString('base64url'),
      keys: encodeRing(keys),
      receiptKeys: encodeRing(receiptKeys),
    } satisfies Init);
    return {
      ...ready,
      service: { handler: (request: Request) => fetch(request) },
      host: {
        workflows: {
          register: (input: Registration) => rpc.request<{ accountId: string }>('register', input),
        },
      },
      registerClient: (clientId: string, scopes: string[]) => rpc.request<void>('client', { clientId, scopes }),
      close,
    };
  } catch (error) {
    await settleIndependently([() => close()], 'Isolated Auth setup and cleanup failed', error);
    throw error;
  }
}

if (import.meta.main) {
  if (!process.send) throw new Error('Isolated Auth requires private IPC');
  let auth: SharedAuth | undefined;
  let seed: ReturnType<typeof createPool> | undefined;
  let release: (() => void) | undefined;
  let starting: Promise<Ready> | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const close = () =>
    (closing ??= (async () => {
      await starting?.catch(() => {});
      await Promise.allSettled([...operations]);
      await settleIndependently(
        [() => closeOwnedSemanticAuth(), () => release?.(), () => seed?.end()],
        'Isolated Auth child cleanup failed',
      );
    })());
  const rpc = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) =>
          process.send!(packet as object, (error: Error | null) => (error ? reject(error) : resolve())),
        ),
      subscribe(message, failure) {
        process.on('message', message);
        process.on('error', failure);
        return () => {
          process.off('message', message);
          process.off('error', failure);
        };
      },
    },
    {
      timeoutMs: 120_000,
      onRequest(method, params) {
        if (method === 'close') return close();
        if (closing) throw new Error('Isolated Auth is closing');
        if (method === 'init') {
          if (starting) throw new Error('Isolated Auth init already attempted');
          return (starting = (async () => {
            const input = params as Init;
            auth = await sharedAuth(
              new URL(input.source),
              async (resource) => {
                const result = await rpc.request<{ acknowledged: boolean }>('owned', resource);
                if (!result.acknowledged) throw new Error('Auth ownership was not acknowledged');
              },
              true,
            );
            seed = createPool(input.kernelUrl, { connectionTimeoutMillis: 10_000 });
            const referenceKeys = decodeRing(input.keys);
            const receiptKeys = decodeRing(input.receiptKeys);
            configureReceiptKeys(seed, receiptKeys);
            const registration = createRegistrationProofBindings({ pool: seed, referenceKeys });
            release = auth.bind({
              trustedAccess: createAuthBindings({
                pool: seed,
                ...registration,
                verifyPendingIdentity: registration.verifyNativePendingIdentity,
              }),
              access: createRegistrationPorts({
                pool: seed,
                authPool: auth.database,
                routeKey: Buffer.from(input.routeKey, 'base64url'),
                referenceKeys,
              }).ports,
            });
            return { issuer: auth.issuer, audience: auth.audience };
          })());
        }
        if (!auth) throw new Error('Isolated Auth is not initialized');
        const operation = (async () => {
          if (method === 'register') return auth!.host.workflows.register(params as Registration);
          if (method === 'client') {
            const { clientId, scopes } = params as { clientId: string; scopes: string[] };
            return auth!.registerClient(clientId, scopes);
          }
          throw new Error(`Unknown Auth control: ${method}`);
        })();
        operations.add(operation);
        void operation.finally(() => operations.delete(operation)).catch(() => {});
        return operation;
      },
    },
  );
  process.on(
    'disconnect',
    () =>
      void close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }),
  );
}
