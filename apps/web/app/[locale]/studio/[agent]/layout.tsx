import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { studioContext, studioPath } from '../../../../features/studio/route.ts';
import { StudioFrame, StudioIdentityMissing } from '../../../../features/studio/studio-frame.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function StudioLayout({ children, params }: {
  children: ReactNode; params: Promise<{ agent: string }>;
}) {
  const { agent: segment } = await params;
  const { studio, agents, session } = await studioContext(segment);
  if (studio.kind === 'invalid') notFound();
  const locale = await requestLocale();
  const messages = await getMessages('studio', locale);
  if (studio.kind === 'foreign') return <StudioIdentityMissing agents={agents} locale={locale} messages={messages} />;
  // Switching identity keeps the Studio home or the new-work form; a Work belongs to the Agent it was opened as.
  const path = (await studioPath()).replace(/^\/studio\/[^/]+/, '') === '/new' ? '/new' : '';
  return <StudioFrame agent={studio.agent} agents={agents} session={session} path={path} locale={locale}
    messages={messages}>{children}</StudioFrame>;
}
