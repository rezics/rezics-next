import { createElement } from 'react';
import { useRouter } from '@tanstack/react-router';

// Runs synchronously in the head, before styles or body content can paint.
// A literal keeps the bootstrap independent of bundler helpers and personal SSR reads.
export const preferencesBootstrap = String.raw`(() => {
  const root = document.documentElement;
  let cookies = '';
  try {
    cookies = document.cookie;
  } catch {}
  const matches = (query) => {
    try {
      return matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const theme = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(cookies)?.[1] ?? 'system';
  const contrast = /(?:^|;\s*)rezics_contrast=(system|standard|more)(?:;|$)/.exec(cookies)?.[1] ?? 'system';
  root.classList.remove('light', 'dark');
  root.classList.add(theme === 'system' ? (matches('(prefers-color-scheme: dark)') ? 'dark' : 'light') : theme);
  root.dataset.contrast =
    contrast === 'more' || (contrast === 'system' && matches('(prefers-contrast: more)')) ? 'more' : 'standard';
  if (/(?:^|;\s*)rezics_nav=collapsed(?:;|$)/.test(cookies)) root.dataset.nav = 'collapsed';
  else delete root.dataset.nav;
})()`;

export function PreferencesScript() {
  const nonce = useRouter().options.ssr?.nonce;
  return createElement('script', {
    nonce,
    'data-preferences': '',
    dangerouslySetInnerHTML: { __html: preferencesBootstrap },
  });
}
