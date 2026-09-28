import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { CONTENT_LANGUAGES_COOKIE, displayLanguages, storedContentLanguages }
  from '../../i18n/display-languages.ts';

/** Mount point of the BFF proxy. Main's paths continue unchanged after it. */
export const BFF_PREFIX = '/api/main';

/** Browser Eden client for Main through the BFF: the same `MainApp` type as
 * `mainApi()`, with the session cookie standing in for the bearer token. Send
 * an `Idempotency-Key` header on commands exactly as Main documents it. */
export function browserMainApi(origin: string = window.location.origin) {
  return treaty<MainApp>(`${origin}${BFF_PREFIX}`, {
    headers: () => {
      const cookie = document.cookie.split('; ').find(part => part.startsWith(`${CONTENT_LANGUAGES_COOKIE}=`))
        ?.slice(CONTENT_LANGUAGES_COOKIE.length + 1);
      const languages = displayLanguages({ pageUrl: window.location.href,
        content: storedContentLanguages(cookie), browser: navigator.languages });
      return languages.length ? { 'accept-language': languages.join(','),
        'x-rezics-display-languages': languages.join(',') } : {};
    },
    fetch: { credentials: 'same-origin' },
  });
}
