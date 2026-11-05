import { assertPublicCacheReadAllowed } from '../security/page-cache.ts';

export const SESSION_COOKIE = '__Host-rezics_session';
export const LOGIN_COOKIE = '__Host-rezics_login';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_SECONDS = 10 * 60;

export function cookie(request: Request, name: string): string | undefined {
  assertPublicCacheReadAllowed(request, 'session or cookie');
  const entries = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
  return entries.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function setCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seconds}`;
}
export const clearCookie = (name: string) => setCookie(name, '', 0);

export function randomId(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export const validId = (id: string | undefined): id is string => /^[A-Za-z0-9_-]{43}$/.test(id ?? '');
