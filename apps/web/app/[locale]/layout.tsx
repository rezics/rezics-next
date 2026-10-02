import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { readMediaViewer } from '../../features/api/media-viewer.ts';
import { serviceOrigin } from '../../features/api/origins.ts';
import { ACCESS_COOKIE } from '../../features/auth/cookies.ts';
import { sessionAgentState } from '../../features/auth/session.ts';
import { WebMediaProvider } from '../../features/document-editor/media-provider.tsx';
import { TypeRegistryProvider } from '../../features/catalogue/type-registry.tsx';
import { readTypes } from '../../features/catalogue/types-read.ts';
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
  // Pages below look types up synchronously; the registry is read here, once, before they render.
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const [registry, viewer, identity] = await Promise.all([
    readTypes(), readMediaViewer({ accountOrigin: serviceOrigin('ACCOUNT_ORIGIN'), accessToken: token }),
    token ? sessionAgentState() : null,
  ]);
  return <TypeRegistryProvider registry={registry}>
    <WebMediaProvider viewer={viewer} actingSubject={identity?.initialActingSubject} locale={locale}>
      {children}
    </WebMediaProvider>
  </TypeRegistryProvider>;
}
