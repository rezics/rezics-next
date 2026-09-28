import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { localeAlternates, pageUrl } from '../../features/seo/address.ts';
import { isUiLocale } from '../../i18n/define.ts';

// Every localized page is canonical at its own path. A page whose address
// carries a selection or a native identity replaces these (see features/seo).
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isUiLocale(locale)) return {};
  const page = await pageUrl();
  return page ? { alternates: localeAlternates(page.origin, page.pathname, locale) } : {};
}

export default async function LocaleLayout({ children, params }: {
  children: ReactNode; params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isUiLocale(locale)) notFound();
  return children;
}
