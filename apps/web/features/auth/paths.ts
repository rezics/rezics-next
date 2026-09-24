export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !/^\/(?!\/)[^\\\r\n]*$/.test(value)) return '/studio';
  return value;
}

export function appCallback(requestUrl: string): string {
  return new URL('/auth/callback', requestUrl).toString();
}
