import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ZoneEditorFrame } from '../../../../../features/zone-editor/frame.tsx';
import { ZoneEditorDraftProvider } from '../../../../../features/zone-editor/draft-provider.tsx';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring, loadZoneLifecycle } from '../../../../../features/zone-editor/read.ts';
import { zoneEditorPath, zoneLifecyclePath } from '../../../../../features/zone-editor/routes.ts';
import { manager } from '../../../../../features/manage/server.ts';
import { isUuid } from '../../../../../features/manage/types.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

export const metadata: Metadata = { robots: { index: false } };

export default async function ZoneEditorLayout({ children, params }: {
  children: ReactNode; params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  const locale = await requestLocale();
  const { agent, actingSubject, main } = await manager(locale,
    isUuid(space) ? zoneLifecyclePath(space) : zoneEditorPath(space));
  const [manageMessages, loadedEditor, loadedLifecycle] = await Promise.all([
    getMessages('manage', locale),
    isUuid(space) ? Promise.resolve(null) : loadZoneAuthoring(main, space, locale, actingSubject),
    isUuid(space) ? loadZoneLifecycle(main, space, locale, actingSubject) : Promise.resolve(null),
  ]);
  if (loadedEditor?.kind === 'missing' || loadedLifecycle?.kind === 'missing') notFound();
  const copy = messages[locale];
  const readyEditor = loadedEditor?.kind === 'ready' ? loadedEditor : null;
  const draftZoneId = readyEditor?.model.zoneId ?? (loadedLifecycle?.kind === 'ready' ? loadedLifecycle.zoneId : null);
  const frame = <ZoneEditorFrame name={readyEditor?.model.name ?? (loadedLifecycle?.kind === 'ready' ? loadedLifecycle.name : space)}
    editorPath={zoneEditorPath(space)} lifecycleOnly={isUuid(space)}
    agent={agent} locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}
    sectionTheme={copy.sectionTheme} sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {children}
  </ZoneEditorFrame>;
  return draftZoneId
    ? <ZoneEditorDraftProvider zoneId={draftZoneId} actingSubject={actingSubject}>{frame}</ZoneEditorDraftProvider>
    : frame;
}
