export function serviceOrigin(name: 'MAIN_ORIGIN' | 'ACCOUNT_ORIGIN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

export function sameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
