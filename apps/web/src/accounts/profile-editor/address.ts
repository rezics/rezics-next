import { getLocale } from '../../paraglide/runtime.js';
/** Immutable account selection only; the private native GET still decides admission. */
export function accountProfileHref(accountId: string, locale = getLocale()) {
  return `/${locale}/accounts/${encodeURIComponent(accountId)}/profile`;
}
