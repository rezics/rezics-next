'use client';

import Link from 'next/link';
import { type ComponentProps, useEffect, useState } from 'react';
import { isPublicPagePath, localizedPath } from '../../i18n/locale.ts';
import { useOptionalShell } from './shell-provider.tsx';

/** Keeps page links in the current UI locale. Non-page routes stay at the origin root. */
export default function LocalizedLink({ href, ...props }: ComponentProps<typeof Link>) {
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  const locale = useOptionalShell()?.locale ?? 'en';
  const page =
    typeof href === 'string' &&
    href.startsWith('/') &&
    !href.startsWith('//') &&
    isPublicPagePath(href.split(/[?#]/, 1)[0]!);
  const destination = page ? localizedPath(href, locale) : href;
  // Keep the browser's navigation until this boundary is hydrated. A framework
  // click handler must not intercept an early click while its router is loading.
  if (!enhanced && typeof destination === 'string') {
    const {
      as: _as,
      replace: _replace,
      prefetch: _prefetch,
      scroll: _scroll,
      shallow: _shallow,
      legacyBehavior: _legacy,
      passHref: _passHref,
      locale: _locale,
      onNavigate: _onNavigate,
      ...native
    } = props;
    return <a href={typeof props.as === 'string' ? props.as : destination} {...native} />;
  }
  return <Link href={destination} {...props} />;
}
