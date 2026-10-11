import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { loadZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneNavigationEditor } from '../../../../../../features/zone-editor/navigation-editor.tsx';
import { type NavigationState } from '../../../../../../features/zone-editor/navigation.ts';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneNavigationPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../../i18n/server.ts';
import type { EditorState } from '../../../../../../features/zone-editor/model.ts';

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
  const { links, head, navigation, complete, after, zoneHead } = read.data;
  const initial: NavigationState = {
    links, saved: links.map(link => ({ ...link })), pending: [], head, navigation, complete, after, notice: { kind: 'idle' },
  };
  const home: EditorState = {
    ...loaded.model.state,
    navigationRevision: head,
    ...(zoneHead ? { zoneHead } : {}),
  };
  const { model, previewPath, sitePath } = loaded;
  return <ZoneNavigationEditor zoneId={model.zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject} locale={locale}
    copy={copy} initial={initial} home={home} previewHref={previewPath} siteHref={sitePath}
    signInHref={signInHref} />;
}
