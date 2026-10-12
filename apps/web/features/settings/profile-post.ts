import type { UiLocale } from '../../i18n/define.ts';

/** Literal local form routes keep the browser request inventory explicit for every interface locale. */
export const profilePosts = {
  'en': (body: FormData) => fetch('/en/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'zh-Hant': (body: FormData) => fetch('/zh-Hant/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'zh-Hans': (body: FormData) => fetch('/zh-Hans/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'ja': (body: FormData) => fetch('/ja/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'ko': (body: FormData) => fetch('/ko/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'de': (body: FormData) => fetch('/de/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'fr': (body: FormData) => fetch('/fr/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
  'es': (body: FormData) => fetch('/es/settings/profile', {
    method: 'POST', body, credentials: 'same-origin',
  }),
} satisfies Record<UiLocale, (body: FormData) => Promise<Response>>;

