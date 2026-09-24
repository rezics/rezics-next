import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { WorkDetail } from '../../../features/work/work-detail.tsx';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export default async function WorkRevisionPage({ params }: { params: Promise<{ revision: string }> }) {
  const { revision } = await params;
  if (!/^[0-9a-f-]{36}$/.test(revision)) notFound();
  const jar = await cookies();
  const token = jar.get('rezics_access')?.value;
  const subject = jar.get('rezics_subject')?.value;
  if (!token || !subject) redirect(`/sign-in?next=${encodeURIComponent(`/works/${revision}`)}`);
  const main = treaty<MainApp>(serviceOrigin('MAIN_ORIGIN'));
  const response = await main.v1.revisions({ revision }).get({ query: { actingSubject: subject },
    headers: { authorization: `Bearer ${token}` }, fetch: { cache: 'no-store' } });
  if (response.error?.status === 404) notFound();
  const { data: messages } = await getTranslation('work', [await requestLocale()]);
  if (response.error || !response.data) {
    return <main className="page-width"><p className="state-panel" role="alert">
      {messages.unavailable}
    </p></main>;
  }
  const work = response.data;
  return <WorkDetail work={work} revision={revision} messages={messages} />;
}
