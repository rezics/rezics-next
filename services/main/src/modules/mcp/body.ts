import { MCP_COST } from './capabilities.ts';
import { FILE_IMPORT_COST } from '../library-import/formats/contract.ts';

export const LIBRARY_IMPORT_MCP_BYTES = 2 * FILE_IMPORT_COST.bytes + 64 * 1024;

/** Apply both byte and time bounds before handing protocol parsing to the SDK. */
export async function mcpBody(request: Request, deadlineMs: number = MCP_COST.deadlineMs): Promise<Uint8Array | Response | null> {
  const importHint = request.headers.get('mcp-method') === 'tools/call'
    && request.headers.get('mcp-name') === 'library_import_create';
  const limit = importHint ? LIBRARY_IMPORT_MCP_BYTES : MCP_COST.maxRequestBytes;
  if (Number(request.headers.get('content-length') ?? 0) > limit) {
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
      if (chunk.done) {
        const body = Buffer.concat(chunks);
        if (bytes > MCP_COST.maxRequestBytes) {
          // Headers only select a bounded read. Verify the actual RPC before
          // dispatch so a forged hint cannot enlarge another tool's budget.
          let rpc: { method?: string; params?: { name?: string } };
          try { rpc = JSON.parse(body.toString()) as typeof rpc; }
          catch { return new Response(null, { status: 413 }); }
          if (rpc?.method !== 'tools/call' || rpc.params?.name !== 'library_import_create') {
            return new Response(null, { status: 413 });
          }
        }
        return body;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) return new Response(null, { status: 413 });
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
