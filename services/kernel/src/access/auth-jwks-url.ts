/** Loopback walk stacks publish JWKS on native Auth while AUTH_ISSUER is the pages origin. */
export function loopbackNativeJwksAllowed(issuer: URL, jwks: URL): boolean {
  if (jwks.protocol === issuer.protocol && jwks.origin === issuer.origin) return true;
  return (
    issuer.protocol === 'http:' &&
    jwks.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname) &&
    jwks.hostname === issuer.hostname &&
    jwks.pathname === '/.well-known/jwks.json'
  );
}
