/** Production RSC errors otherwise reach the reader only as an opaque digest. */
export function onRequestError(error: unknown, request: { path: string; method: string }) {
  console.error(JSON.stringify({
    level: 'error', event: 'web_render_failed', method: request.method,
    path: request.path.split('?')[0],
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'UnknownError' },
  }));
}
