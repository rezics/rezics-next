'use client';

import Link from 'next/link';
import { type ComponentProps, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { isPublicPagePath, localizedPath } from '../../i18n/locale.ts';
import { useOptionalShell } from './shell-provider.tsx';

/** Keeps page links in the current UI locale. Non-page routes stay at the origin root. */
export default function LocalizedLink({ href, ref, ...props }: ComponentProps<typeof Link>) {
  const [enhanced, setEnhanced] = useState(false);
  const anchor = useRef<HTMLAnchorElement | null>(null);
  const restoreFocus = useRef(false);
  const attachAnchor = useCallback((node: HTMLAnchorElement | null) => {
    // Async result lists can focus their native link before enhancement replaces it.
    // Carry that focus to the framework anchor instead of dropping it onto body.
    if (!node) restoreFocus.current = anchor.current === document.activeElement;
    anchor.current = node;
    if (node && restoreFocus.current) {
      restoreFocus.current = false;
      node.focus();
    }
  }, []);
  useImperativeHandle(ref, () => anchor.current!, [enhanced]);
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
    return <a ref={attachAnchor} href={typeof props.as === 'string' ? props.as : destination} {...native} />;
  }
  return <Link ref={attachAnchor} href={destination} {...props} />;
}
