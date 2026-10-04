'use client';

import Link from 'next/link';
import { type ComponentProps, useEffect, useState } from 'react';
import { isPublicPagePath, localizedPath } from '../../i18n/locale.ts';
import { useOptionalShell } from './shell-provider.tsx';

/** Keeps page links in the current UI locale. Non-page routes stay at the origin root. */
export default function LocalizedLink({ href, onClick, documentNavigation = false, ...props }:
  ComponentProps<typeof Link> & { documentNavigation?: boolean }) {
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  const locale = useOptionalShell()?.locale ?? 'en';
  const page =
    typeof href === 'string' &&
    href.startsWith('/') &&
    !href.startsWith('//') &&
    isPublicPagePath(href.split(/[?#]/, 1)[0]!);
  const destination = page ? localizedPath(href, locale) : href;
  // Keep one anchor through hydration: replacing <a> with <Link> between
  // pointerdown and pointerup loses the browser's click (and keyboard focus).
  // Before effects settle, explicit document navigation also keeps replayed
  // hydration clicks out of a router that may still be loading.
  return <Link href={destination} {...props} onClick={(event) => {
    onClick?.(event);
    const anchor = event.currentTarget;
    // Rapid browse choices must stay with one navigation owner through hydration.
    // A document request supersedes the preceding document request in the browser;
    // handing the second choice to the router can cancel it without replacing it.
    if ((enhanced && !documentNavigation) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || anchor.hasAttribute('download') ||
      (anchor.target && anchor.target !== '_self')) return;
    event.preventDefault();
    if (props.replace) window.location.replace(anchor.href);
    else window.location.assign(anchor.href);
  }} />;
}
