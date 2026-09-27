export function safeReturnPath(value: string | null | undefined, fallback = '/studio'): string {
  if (!value || !/^\/(?!\/)[^\\\r\n]*$/.test(value)) return fallback;
  return value;
}

export function appCallback(requestUrl: string): string {
  return new URL('/auth/callback', requestUrl).toString();
}

export function signInPath(next: string | null | undefined): string {
  return `/auth/start?next=${encodeURIComponent(safeReturnPath(next))}`;
}
