/** Read an untrusted JSON body within a caller-selected transport allowance.
 * Callers supply a finite positive byte allowance and their existing whole-call
 * signal. This utility neither starts nor renews a deadline.
 */
export async function readJsonBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Private JSON response unavailable');

  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  let onAbort: () => void = () => {};
  // Race the read as well as cancelling it: external streams may ignore cancel.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Private JSON read aborted', 'AbortError'));
  });
  try {
    signal.throwIfAborted();
    const length = response.headers.get('content-length');
    // A valid announced excess can be rejected without reading. Every other
    // header, including a dishonest small length, still uses the byte counter.
    if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes)
      throw new Error('Private JSON response too large');

    signal.addEventListener('abort', onAbort, { once: true });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      // Test before retaining the chunk. Decoded character counts cannot bound
      // UTF-8 allocation, and Content-Length cannot establish actual size.
      if (value.byteLength > maxBytes - size) throw new Error('Private JSON response too large');
      size += value.byteLength;
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // One fatal decode handles code points split across transport chunks.
    // Parsing starts only after the entire body has passed the byte allowance.
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    signal.throwIfAborted();
    return value;
  } catch {
    // JSON.parse and external stream errors can contain response excerpts.
    // Callers receive no body, credential, identifier or parser diagnostic.
    throw new Error('Private JSON response unavailable');
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Cleanup is best effort only. Awaiting a hostile cancellation promise
    // would extend the caller's deadline or keep a retired read alive.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
