/** A write the session cookie may authorize: from this origin, or from a
 * non-browser client that sends neither Origin nor Fetch Metadata. It reads no
 * configuration, so client-reachable modules can share it without bundling the
 * server's environment parsing. */
export function sameOriginWrite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
