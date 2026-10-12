import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ZoneEditorFrame } from '../../../../../features/zone-editor/frame.tsx';
import { ZoneEditorDraftProvider } from '../../../../../features/zone-editor/draft-provider.tsx';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring, loadZoneLifecycle, loadZoneRecoveryReturnAddress } from '../../../../../features/zone-editor/read.ts';
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
  const [manageMessages, loadedEditor, loadedLifecycle] = await Promise.all([
    getMessages('manage', locale),
    loadZoneAuthoring(main, space, locale, actingSubject),
    loadZoneLifecycle(main, space, locale, actingSubject),
  ]);
  if (loadedEditor.kind === 'missing' && loadedLifecycle.kind === 'missing') notFound();
  const copy = messages[locale];
  const readyEditor = loadedEditor?.kind === 'ready' ? loadedEditor : null;
  const draftZoneId = readyEditor?.model.zoneId ?? (loadedLifecycle?.kind === 'ready' ? loadedLifecycle.zoneId : null);
  const pageUrl = (await headers()).get('x-rezics-page-url');
  let requestedReturn: string | null = null;
  try { requestedReturn = pageUrl ? new URL(pageUrl).searchParams.get('address') : null; } catch { /* No return override. */ }
  const lifecycleAddress = loadedLifecycle.kind === 'ready' ? { ...loadedLifecycle,
    returnAddress: requestedReturn ? await loadZoneRecoveryReturnAddress(main, requestedReturn, loadedLifecycle, actingSubject)
      : loadedLifecycle.returnAddress } : undefined;
  const frame = <ZoneEditorFrame name={readyEditor?.model.name ?? (loadedLifecycle?.kind === 'ready' ? loadedLifecycle.name : space)}
    editorPath={zoneEditorPath(space)} lifecycleOnly={loadedLifecycle.kind === 'ready' && loadedLifecycle.status === 'retired'}
    lifecycleAddress={lifecycleAddress}
    agent={agent} locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}
    sectionTheme={copy.sectionTheme} sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {children}
  </ZoneEditorFrame>;
  return draftZoneId
    ? <ZoneEditorDraftProvider zoneId={draftZoneId} actingSubject={actingSubject}>{frame}</ZoneEditorDraftProvider>
    : frame;
}
