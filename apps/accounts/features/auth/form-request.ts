import { edgeCountry } from '../proxy/account-proxy.ts';

/** Pages and Server Actions must use the same trusted edge country as API
 * proxy requests. Never elevate a client-sent country header on Cloudflare. */
export function trustedFormRequest(request: Request, countryFromHeader = false): Request {
  const country = edgeCountry(request, countryFromHeader);
  const normalized = new Request(request);
  if (country) normalized.headers.set('cf-ipcountry', country);
  else normalized.headers.delete('cf-ipcountry');
  const cf = Reflect.get(request, 'cf');
  if (cf !== undefined) Object.defineProperty(normalized, 'cf', { value: cf, configurable: true });
  return normalized;
}
