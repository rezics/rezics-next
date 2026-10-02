import { redirect } from 'next/navigation';
import { requestLocale } from '../../../i18n/server.ts';

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, search] = await Promise.all([requestLocale(), searchParams]);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  query.set('type', 'communities');
  // The proxy sends HTTP 301 before rendering; this fallback covers direct component invocations.
  redirect(`/${locale}/discover?${query}`);
}
