import { ConsentRecovery } from '../../../../features/auth/consent-recovery.tsx';
import { messages } from '../../../../features/auth/messages.ts';
import { safeReturnPath } from '../../../../features/auth/paths.ts';
import { isUiLocale } from '../../../../i18n/define.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

export default async function ConsentPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale: requested } = await params;
  const locale = isUiLocale(requested) ? requested : 'en';
  const next = safeReturnPath((await searchParams).next, localizedPath('/', locale));
  return <ConsentRecovery next={next} messages={messages[locale]} />;
}
