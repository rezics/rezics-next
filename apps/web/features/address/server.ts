import { headers } from 'next/headers';
import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { ADDRESS_HEADER, type AddressRead, readAddress, resolvedAddress } from './client.ts';
import type { AddressScope } from './path.ts';

/** Reuse the proxy's admission read; incoming clients cannot supply this header. */
export const resolveAddress = cache(async (scope: AddressScope, key: string, locale: UiLocale): Promise<AddressRead> => {
  const incoming = await headers();
  const carried = incoming.get(ADDRESS_HEADER);
  if (carried) {
    try {
      const data = resolvedAddress(JSON.parse(carried));
      if (data?.scope === scope && (data.key === key || data.holder.slice(-36) === key)) return { kind: 'resolved', data };
    } catch { /* A malformed internal header is never admission. */ }
  }
  const languages = displayLanguages({ pageUrl: incoming.get('x-rezics-page-url'), uiLocale: locale });
  return readAddress({ scope, key }, languages.join(','));
});
