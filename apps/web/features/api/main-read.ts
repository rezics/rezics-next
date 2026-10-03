import { headers as requestHeaders } from 'next/headers';
import { isClientIp } from '../../worker/client-ip.ts';

/** The ingress replaces this source header. Never trust caller-supplied
 * x-rezics-client-ip or XFF; Main also checks the web server's peer address. */
export function forwardClientIp(
  incoming: Headers,
  outgoing: Headers,
  source = process.env.WEB_CLIENT_IP_HEADER ?? 'cf-connecting-ip',
): void {
  outgoing.delete('x-rezics-client-ip');
  const ip = incoming.get(source)?.trim();
  if (ip && isClientIp(ip)) outgoing.set('x-rezics-client-ip', ip);
}

/** All server reads use the same client attribution as the BFF. Middleware
 * and the Worker pass their request explicitly; page readers use its context. */
export async function mainReadHeaders(
  outgoing?: HeadersInit,
  incoming?: Headers,
): Promise<Headers> {
  const result = new Headers(outgoing);
  result.delete('x-rezics-client-ip');
  try {
    forwardClientIp(incoming ?? await requestHeaders(), result);
  } catch { /* CLI callers have no incoming web request. */ }
  return result;
}
