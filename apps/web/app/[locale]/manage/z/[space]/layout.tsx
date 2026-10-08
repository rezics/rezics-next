import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ZoneEditorFrame } from '../../../../../features/zone-editor/frame.tsx';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring } from '../../../../../features/zone-editor/read.ts';
import { zoneEditorPath } from '../../../../../features/zone-editor/routes.ts';
import { manager } from '../../../../../features/manage/server.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

export const metadata: Metadata = { robots: { index: false } };

export default async function ZoneEditorLayout({ children, params }: {
  children: ReactNode; params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  const locale = await requestLocale();
  const { agent, actingSubject, main } = await manager(locale, zoneEditorPath(space));
  const [manageMessages, loaded] = await Promise.all([
    getMessages('manage', locale),
    loadZoneAuthoring(main, space, locale, actingSubject),
  ]);
  if (loaded.kind === 'missing') notFound();
  const copy = messages[locale];
  return <ZoneEditorFrame name={loaded.kind === 'ready' ? loaded.model.name : space} editorPath={zoneEditorPath(space)}
    agent={agent} locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}>
    {children}
  </ZoneEditorFrame>;
}
