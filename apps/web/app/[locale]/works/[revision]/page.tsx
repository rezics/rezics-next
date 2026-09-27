import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { mainApi } from '../../../../features/api/main.ts';
import { signInPath } from '../../../../features/auth/paths.ts';
import { readSession } from '../../../../features/auth/session.ts';
import { WorkDetail, WorkUnavailable } from '../../../../features/work/work-detail.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

type Params = { params: Promise<{ revision: string }> };

const revisionId = /^[0-9a-f-]{36}$/;

// Metadata and the page share one Main read per request.
const readRevision = cache(async (revision: string) => {
  const here = localizedPath(`/works/${revision}`, await requestLocale());
  const session = await readSession();
  if (!session) redirect(signInPath(here));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', await requestLocale())}?next=${encodeURIComponent(here)}`);
  const subject = session.agent.agent.iri;
  return (await mainApi()).v1.revisions({ revision }).get({ query: { actingSubject: subject } });
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { revision } = await params;
  const { t } = await getTranslation('work', [await requestLocale()]);
  if (!revisionId.test(revision)) return { title: t.notFoundTitle };
  const response = await readRevision(revision);
  if (response.data) return { title: response.data.title };
  return { title: response.error?.status === 404 ? t.notFoundTitle : t.unavailableTitle };
}

export default async function WorkRevisionPage({ params }: Params) {
  const { revision } = await params;
  if (!revisionId.test(revision)) notFound();
  const response = await readRevision(revision);
  if (response.error?.status === 404) notFound();
  const locale = await requestLocale();
  const messages = await getMessages('work', locale);
  if (response.error || !response.data) return <WorkUnavailable messages={messages} />;
  return <WorkDetail work={response.data} revision={revision} locale={locale} messages={messages} />;
}
