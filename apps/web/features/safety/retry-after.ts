// Server-safe: the settings save, which runs in a route handler, uses this too.

/** A spent budget names when to come back: `Retry-After` in seconds, as G-543's `429` states it. */
export function retryAfterSeconds(response: Pick<Response, 'headers'>): number {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 60;
}
