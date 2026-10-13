import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { loadZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneNavigationEditor } from '../../../../../../features/zone-editor/navigation-editor.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneNavigationPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { navigationEditorState } from '../../../../../../features/zone-editor/zone-navigation-theme-recorded-page.ts';
import { requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].navTitle };
}

export default async function ZoneNavigationPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const copy = messages[locale];
  const { actingSubject, main, signInHref } = await manager(locale, zoneNavigationPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  const read = await loadZoneNavigation(main, loaded.model.zoneId, actingSubject);
  if (!read.ok) return <ZoneAuthoringFailure failure={read.failure} copy={copy} />;
  const edited = navigationEditorState(read.data, loaded.model.state);
  const { model, previewPath, sitePath } = loaded;
  return <ZoneNavigationEditor zoneId={model.zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject} locale={locale}
    copy={copy} initial={edited.navigation} home={edited.home} previewHref={previewPath} siteHref={sitePath}
    signInHref={signInHref} />;
}
