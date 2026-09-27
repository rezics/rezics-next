'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { isPublicPagePath, localizedPath } from '../../i18n/locale.ts';
import { useOptionalShell } from './shell-provider.tsx';

/** Keeps page links in the current UI locale. Non-page routes stay at the origin root. */
export default function LocalizedLink({ href, ...props }: ComponentProps<typeof Link>) {
  const locale = useOptionalShell()?.locale ?? 'en';
  const page = typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')
    && isPublicPagePath(href.split(/[?#]/, 1)[0]!);
  return <Link href={page ? localizedPath(href, locale) : href} {...props} />;
}
