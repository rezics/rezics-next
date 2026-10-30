/** Match the BFF's HTTPS policy, including its explicit local-development exception. */
function trustedAuthUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Only server configuration supplies the issuer; no return target or browser input is accepted. */
export function securityHrefFromIssuer(issuer: string | undefined): string | null {
  const trusted = trustedAuthUrl(issuer);
  return trusted ? new URL('/security', trusted.origin).href : null;
}

/** Both account actions stay on the origin of the configured, validated security page. */
export function accountSafetyLinks(securityHref: string | null): { security: string; deletion: string } | null {
  const security = trustedAuthUrl(securityHref);
  if (!security || security.pathname !== '/security') return null;
  return { security: security.href, deletion: new URL('/account/delete', security.origin).href };
}
