import { AuthFrame, AuthHeading } from '../../../../features/shell/auth-frame.tsx';
import { readPublicBirthday } from '../../../../features/api/server.ts';
import { getTranslation, requestLocale } from '../../../../i18n/server.ts';

export const metadata = { robots: { index: false, follow: false } };
export default async function BirthdayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await requestLocale();
  const [birthday, { t }] = await Promise.all([readPublicBirthday(id), getTranslation('account', [locale])]);
  return <AuthFrame><AuthHeading title={t.birthdayPublic} />
    {birthday.status === 'ok' ? <time dateTime={birthday.data} className="text-lg">{birthday.data}</time>
      : <p>{t.birthdayUnavailable}</p>}
  </AuthFrame>;
}
