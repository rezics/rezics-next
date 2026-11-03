import { Buffer } from 'node:buffer';

type Source = {
  operationId: string;
  scale?: number;
  repetition?: number;
};
type Send = Source & {
  attempt: number;
  requestBytes: number | null;
  responseBytes: number | null;
  status?: number;
  outcome: 'pending' | 'complete' | 'failed' | 'cancelled';
};

/**
 * Observe the existing official-SDK fetch boundary, restricted to one loopback origin.
 * Bytes mean the serialized request target + body and response body chunks delivered by fetch.
 * Headers, TLS/socket overhead, proxy forwarding and other native/DBOS pools are not measured.
 * A send is a real fetch invocation, including rejected invocations, not a successful SDK result.
 */
export function observeProviderBytes(origin: string) {
  const upstream = globalThis.fetch;
  let active: { source: Source; sends: Send[]; settlements: Promise<void>[] } | undefined;
  const observedFetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const run = active;
    if (url.origin !== origin || run === undefined) return upstream(input, init);
    const body = init?.body;
    const send: Send = {
      ...run.source,
      attempt: run.sends.length + 1,
      // The Stripe fetch client serializes bodies as strings. Unsupported input stays missing.
      requestBytes:
        input instanceof Request || (body != null && typeof body !== 'string')
          ? null
          : Buffer.byteLength(url.pathname + url.search) + (typeof body === 'string' ? Buffer.byteLength(body) : 0),
      responseBytes: null,
      outcome: 'pending',
    };
    run.sends.push(send);
    let settled!: () => void;
    run.settlements.push(new Promise<void>((resolve) => (settled = resolve)));
    try {
      const response = await upstream(input, init);
      send.status = response.status;
      send.responseBytes = 0;
      const reader = response.body?.getReader();
      if (!reader) {
        send.outcome = 'complete';
        settled();
        return response;
      }
      // Forward each original chunk once. Do not clone/drain ahead of the bounded production reader.
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                send.outcome = 'complete';
                reader.releaseLock();
                settled();
                controller.close();
              } else {
                send.responseBytes! += chunk.value.byteLength;
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              send.outcome = 'failed';
              reader.releaseLock();
              settled();
              controller.error(error);
            }
          },
          async cancel(reason) {
            send.outcome = 'cancelled';
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
              settled();
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      send.outcome = 'failed';
      settled();
      throw error;
    }
  }, upstream) as typeof fetch;
  globalThis.fetch = observedFetch;
  return {
    async run<T>(source: Source, expectsProvider: boolean, operation: () => Promise<T>) {
      if (active) throw new Error('Provider observation requires serial logical operations');
      const run = { source, sends: [] as Send[], settlements: [] as Promise<void>[] };
      active = run;
      try {
        // Keep failures observable without replacing the original operation's rejection.
        const result = await operation().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await Promise.all(run.settlements);
        const missing = run.sends.some((send) => send.requestBytes === null || send.responseBytes === null);
        const observation = {
          ...source,
          source: 'official Stripe SDK fetch / loopback request target and body / response body chunks',
          status:
            run.sends.length === 0
              ? expectsProvider
                ? 'missing-physical-measurement'
                : 'no-provider-calls'
              : missing
                ? 'missing-physical-measurement'
                : 'measured',
          sends: run.sends,
          // Missing and inapplicable measurements must never turn into zero-valued cost samples.
          totals:
            run.sends.length === 0 || missing
              ? null
              : {
                  providerSends: run.sends.length,
                  providerRequestBytes: run.sends.reduce((sum, send) => sum + send.requestBytes!, 0),
                  providerResponseBytes: run.sends.reduce((sum, send) => sum + send.responseBytes!, 0),
                },
          limitations:
            'Body boundary only; partial/failed sends retain observed bytes. No complete physical-cost evidence.',
        };
        if (!result.ok) {
          console.log(JSON.stringify({ providerObservation: observation }));
          throw result.error;
        }
        return { value: result.value, observation };
      } finally {
        active = undefined;
      }
    },
    close() {
      if (globalThis.fetch !== observedFetch)
        throw new Error('Close provider observations in reverse installation order');
      globalThis.fetch = upstream;
    },
  };
}

export type ProviderByteObserver = ReturnType<typeof observeProviderBytes>;
