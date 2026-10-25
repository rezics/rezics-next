/** The configured spelling is the identity; never normalize an issuer into trust. */
export function issuerOrigin(value: string): URL {
  const issuer = new URL(value);
  const localHttp = issuer.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname);
  if (issuer.origin !== value || (issuer.protocol !== 'https:' && !localHttp))
    throw new Error('Issuer must be an HTTPS origin or a canonical HTTP loopback origin');
  return issuer;
}
