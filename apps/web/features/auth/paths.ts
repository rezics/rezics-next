export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !/^\/(?!\/)[^\\\r\n]*$/.test(value)) return '/studio';
  return value;
}

export function appCallback(requestUrl: string): string {
  return new URL('/auth/callback', requestUrl).toString();
}

export function signInPath(next: string | null | undefined): string {
  return `/sign-in?next=${encodeURIComponent(safeReturnPath(next))}`;
}
