/** Match the BFF's HTTPS policy, including its explicit local-development exception. */
export function trustedAuthUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#')
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

/** Fixed Auth-owned route. Navigation supplies no account, scope, approval or return target. */
export function accountRenameHref(securityHref: string | null): string | null {
  const links = accountSafetyLinks(securityHref);
  return links ? new URL('/account/rename', links.security).href : null;
}
