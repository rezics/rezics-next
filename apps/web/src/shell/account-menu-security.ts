import { securityHrefFromIssuer } from '../settings/auth-management';

/** One configuration read per lifecycle; a disposed menu must never receive its result. */
export function resolveAccountSecurity(
  readIssuer: () => Promise<string>,
  resolved: (href: string | null) => void,
): () => void {
  let active = true;
  void (async () => {
    let href: string | null = null;
    try {
      href = securityHrefFromIssuer(await readIssuer());
    } catch {
      // A missing or failed configuration read leaves the destination unavailable.
    }
    if (active) resolved(href);
  })();
  return () => {
    active = false;
  };
}
