import { webConfig } from '../config/env.ts';

export function serviceOrigin(name: 'MAIN_ORIGIN' | 'ACCOUNT_ORIGIN'): string {
  const url = new URL(webConfig()[name]);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

export function sameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
