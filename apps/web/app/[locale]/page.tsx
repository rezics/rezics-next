import type { Metadata } from 'next';
import { HomeRoute } from '../../features/home/home-route.tsx';
import { isUiLocale } from '../../i18n/define.ts';
import { getTranslation } from '../../i18n/server.ts';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isUiLocale(locale)) return {};
  const { data } = await getTranslation('home', [locale]);
  return { title: { absolute: `REZICS · ${data.title}` } };
}

export default async function Home({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  return <HomeRoute locale={isUiLocale(locale) ? locale : 'en'} searchParams={await searchParams} />;
}
