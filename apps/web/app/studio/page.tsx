import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CreateWorkForm } from './create-work-form.tsx';
import { getTranslation, requestLocale } from '../../i18n/server.ts';

export default async function StudioPage() {
  const jar = await cookies();
  if (!jar.get('rezics_access')?.value) redirect('/sign-in?next=%2Fstudio');
  if (!jar.get('rezics_subject')?.value) redirect('/identity?next=%2Fstudio');
  const { data: messages } = await getTranslation('studio', [await requestLocale()]);
  return <main className="page-width"><div className="auth-layout"><h1>{messages.createHeading}</h1>
    <p className="muted">{messages.createHelp}</p>
    <CreateWorkForm messages={messages} /></div></main>;
}
