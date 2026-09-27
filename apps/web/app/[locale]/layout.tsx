import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isUiLocale(locale)) return {};
  const url = (await headers()).get('x-rezics-page-url');
  if (!url) return {};
  const page = new URL(url);
  const address = (choice: UiLocale) => new URL(localizedPath(page.pathname, choice), page.origin).toString();
  return { alternates: { canonical: address(locale), languages: Object.fromEntries(
    uiLocales.map(choice => [choice, address(choice)])) } };
}

export default async function LocaleLayout({ children, params }: {
  children: ReactNode; params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isUiLocale(locale)) notFound();
  return children;
}
