import { shutdownTelemetry, startTelemetry, withTelemetrySpan } from '../src/runtime.ts';

let pulls = 0,
  cancellations = 0;
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/empty') return new Response(null, { status: 204 });
    if (path === '/finite') return new Response('PRIVATE_FINITE');
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode('PRIVATE_CHUNK'));
          await Bun.sleep(5);
        },
        cancel() {
          cancellations++;
        },
      }),
    );
  },
});
const originalResponse = await fetch(`${upstream.url.origin}/empty`);
startTelemetry('main', { ...process.env, FUSEKI_URL: upstream.url.origin });
try {
  await withTelemetrySpan('stream.calibration', async () => {
    const response = await fetch(`${upstream.url.origin}/stream`);
    if (response.url !== `${upstream.url.origin}/stream` || response.type !== originalResponse.type)
      throw new Error('Fetch response metadata changed');
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    if (new TextDecoder().decode(first.value) !== 'PRIVATE_CHUNK')
      throw new Error('Stream body changed');
    const empty = await fetch(`${upstream.url.origin}/empty`);
    if (empty.status !== 204 || empty.body !== null) throw new Error('Empty response changed');
    const finite = await fetch(`${upstream.url.origin}/finite`);
    const cloned = finite.clone();
    if (
      cloned.url !== finite.url ||
      cloned.type !== finite.type ||
      cloned.redirected !== finite.redirected
    )
      throw new Error('Clone metadata changed');
    const bodies = await Promise.all([finite.text(), cloned.text()]);
    if (bodies.some((body) => body !== 'PRIVATE_FINITE')) throw new Error('Clone body changed');
  });
  console.log(JSON.stringify({ pulls, cancellations }));
} finally {
  await upstream.stop(true);
  await shutdownTelemetry();
}
