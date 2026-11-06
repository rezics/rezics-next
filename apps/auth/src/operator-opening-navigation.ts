/** Website origins come from deployment configuration, never an opening request or imported handoff. */
export function operatorWebsiteHref(origin: string, locale: string, destination: '/' | '/accounts', renew = false): string {
  const target = `/${locale}${destination === '/' ? '/' : destination}`;
  const url = new URL(renew ? '/auth/sign-in' : target, origin);
  if (renew) url.searchParams.set('return_to', target);
  return url.href;
}
