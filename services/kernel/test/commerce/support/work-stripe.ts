import { startFakeStripe } from './fake-stripe.ts';

/** Transport controls preserve the provider response captured before a concurrent state change. */
export function startWorkStripe() {
  const fake = startFakeStripe();
  let hold: { captured(): void; released: Promise<void> } | undefined;
  let unavailable = false;
  let reads = 0;
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const sessionRead = request.method === 'GET' && /^\/v1\/checkout\/sessions\/[^/]+$/.test(url.pathname);
      if (sessionRead) {
        reads++;
        if (unavailable) {
          unavailable = false;
          return Response.json({ error: { type: 'api_error', message: 'Unavailable' } }, { status: 503 });
        }
      }
      // Delay the full financial read, after locator routing and Session queue admission.
      const financialRead = sessionRead && (url.searchParams.has('expand[0]') || url.searchParams.has('expand[]'));
      const pending = financialRead ? hold : undefined;
      if (pending) hold = undefined;
      const response = await fetch(`http://127.0.0.1:${fake.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'POST' ? { body: await request.text() } : {}),
      });
      const bytes = await response.arrayBuffer();
      if (pending) {
        pending.captured();
        await pending.released;
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  });
  return {
    fake,
    port: proxy.port!,
    get reads() {
      return reads;
    },
    failRead() {
      unavailable = true;
    },
    delayRead() {
      const captured = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      hold = { captured: captured.resolve, released: released.promise };
      return { captured: captured.promise, release: released.resolve };
    },
    stop() {
      void proxy.stop(true);
      fake.stop();
    },
  };
}
