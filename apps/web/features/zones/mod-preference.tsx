'use client';

import { useEffect, type ReactNode, type SyntheticEvent } from 'react';
import { preferenceCookie } from '../shell/preferences.ts';
import { MOD_ENV_COOKIE, modPreference, parseBrowseState } from './browse-state.ts';

/** Remember the environment as a reader follows any Mods browse link or search form. */
export function ModPreferenceMemory({ children, current }: { children: ReactNode; current?: string }) {
  // A copied browse URL is itself a choice; carry it to the Work detail page.
  useEffect(() => {
    if (current !== undefined) document.cookie = preferenceCookie(MOD_ENV_COOKIE, current,
      location.protocol === 'https:');
  }, [current]);
  function remember(params: URLSearchParams) {
    const filter = parseBrowseState({ version: params.getAll('version'), loader: params.getAll('loader'),
      env: params.getAll('env') }).filter;
    document.cookie = preferenceCookie(MOD_ENV_COOKIE, modPreference(filter), location.protocol === 'https:');
  }
  function click(event: SyntheticEvent<HTMLDivElement>) {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const destination = new URL(anchor.getAttribute('href')!, location.href);
    if (destination.origin === location.origin && /\/r\/mods\/browse$/.test(destination.pathname)) {
      remember(destination.searchParams);
    }
  }
  function submit(event: SyntheticEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLFormElement)) return;
    const destination = new URL(event.target.action, location.href);
    if (destination.origin !== location.origin || !/\/r\/mods\/browse$/.test(destination.pathname)) return;
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.target)) if (typeof value === 'string') params.append(key, value);
    remember(params);
  }
  return <div onClickCapture={click} onSubmitCapture={submit}>{children}</div>;
}
