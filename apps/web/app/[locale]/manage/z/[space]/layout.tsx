import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ZoneEditorFrame } from '../../../../../features/zone-editor/frame.tsx';
import { ZoneEditorDraftProvider } from '../../../../../features/zone-editor/draft-provider.tsx';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneManagementFrame } from '../../../../../features/zone-editor/read.ts';
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
    loadZoneManagementFrame(main, space, locale, actingSubject),
  ]);
  if (loaded.missing) notFound();
  const copy = messages[locale];
  const frame = <ZoneEditorFrame name={loaded.name} editorPath={zoneEditorPath(space)}
    lifecycleOnly={loaded.lifecycleOnly} lifecycleAddress={loaded.lifecycleAddress}
    agent={agent} locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}
    sectionTheme={copy.sectionTheme} sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {children}
  </ZoneEditorFrame>;
  return loaded.draftZoneId
    ? <ZoneEditorDraftProvider zoneId={loaded.draftZoneId} actingSubject={actingSubject}>{frame}</ZoneEditorDraftProvider>
    : frame;
}
