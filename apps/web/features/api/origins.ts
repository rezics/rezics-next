import { webConfig } from '../config/env.ts';

export function serviceOrigin(name: 'MAIN_ORIGIN' | 'ACCOUNT_ORIGIN'): string {
  const url = new URL(webConfig()[name]);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

export { sameOriginWrite } from './same-origin.ts';
