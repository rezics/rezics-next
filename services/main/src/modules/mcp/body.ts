import { MCP_COST } from './capabilities.ts';

/** Apply both byte and time bounds before handing protocol parsing to the SDK. */
export async function mcpBody(request: Request, deadlineMs: number = MCP_COST.deadlineMs): Promise<Uint8Array | Response | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MCP_COST.maxRequestBytes) {
    return new Response(null, { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
  let abortRead: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abortRead = () => reject(signal.reason as unknown);
    signal.addEventListener('abort', abortRead, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (signal.aborted) return new Response(null, { status: 408 });
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) return Buffer.concat(chunks);
      bytes += chunk.value.byteLength;
      if (bytes > MCP_COST.maxRequestBytes) return new Response(null, { status: 413 });
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (signal.aborted) return new Response(null, { status: 408 });
    throw error;
  } finally {
    signal.removeEventListener('abort', abortRead);
    // Cancelling a stalled upload must not delay the bounded response.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
